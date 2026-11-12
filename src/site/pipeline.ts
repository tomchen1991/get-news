import { articleId } from '../config';
import { Store } from '../store';
import { createTavilySearchProvider, SearchError, type SearchProvider } from '../search/providers';
import type { NewsItem } from '../types';
import { createJevEvaluator, selection, type AiBinding, type Evaluator } from './jev';
import type { AccessEnv } from './access';
import { feedbackContext } from './feedback';
import { modelDiagnostic } from './diagnostics';
import type { PushEventEnv } from './push';
import { collectionSince, isNonNewsPage } from './source-policy';

export interface SiteEnv extends AccessEnv, PushEventEnv {
  DB: D1Database;
  AI?: AiBinding;
  SEARCH_ENABLED?: string;
  JEV_ENABLED?: string;
  TAVILY_API_KEY?: string;
  AI_GATEWAY_ID?: string;
  NEWS_TIMEZONE?: string;
  NEWS_MORNING_HOUR?: string;
  TAVILY_DAILY_CREDITS?: string;
  TAVILY_MONTHLY_CREDITS?: string;
  JEV_DAILY_REQUESTS?: string;
  JEV_MONTHLY_REQUESTS?: string;
  DIGEST_ENABLED?: string;
  DIGEST_MODEL?: string;
  DIGEST_HOUR?: string;
  DIGEST_MONTHLY_REQUESTS?: string;
  MANUAL_ISSUE_DAY?: string;
  MANUAL_ISSUE_AUTHORIZATION?: string;
  MANUAL_ISSUE_REGENERATE?: string;
  MANUAL_ISSUE_REUSE_JUDGMENTS?: string;
  MANUAL_ISSUE_REPLAY_DRAFT_FROM?: string;
  JEV_SMOKE_TEST_ID?: string;
}
export interface Topic { id: string; name: string; priority: string; weekdays_json: string; gap_days: number; queries_json: string; guidance: string; refresh_weight: number; refresh_credit: number; last_refresh_at: number | null }
interface Candidate extends Topic { article_id: string; topic_id: string; url: string; title: string; summary: string; published_at: string }
export interface SiteStats { searches: number; evaluations: number; errors: number; busy: boolean }
export function localClock(now: number, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, month: day.slice(0, 7), weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), hour: Number(get('hour')), minute: Number(get('minute')) };
}
function limit(raw: string | undefined, fallback: number, max: number) {
  const value = raw === undefined ? fallback : Number(raw);
  if (raw === '' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid budget');
  return value;
}
export function topicQueries(topic: Topic): string[] {
  const queries: unknown = JSON.parse(topic.queries_json);
  const weekdays: unknown = JSON.parse(topic.weekdays_json);
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 5 || !queries.every(q => typeof q === 'string' && q.trim() && q.length <= 1024) ||
      !Array.isArray(weekdays) || weekdays.length > 7 || !weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ||
      !Number.isInteger(topic.gap_days) || topic.gap_days < 1 || topic.gap_days > 7 || topic.name.length > 100 || topic.guidance.length > 1000) throw new Error('Invalid topic');
  return [...new Set(queries as string[])];
}
/** Smooth weighted round robin: persist credits only after a paid slot is reserved. */
export function hourlyTopic(topics: Topic[]): Topic | undefined {
  return topics.filter(t => Number.isInteger(t.refresh_weight) && t.refresh_weight > 0 && t.refresh_weight <= 10)
    .sort((a, b) => (b.refresh_credit + b.refresh_weight) - (a.refresh_credit + a.refresh_weight)
      || (a.last_refresh_at ?? 0) - (b.last_refresh_at ?? 0) || a.id.localeCompare(b.id))[0];
}
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
/** Reserve before outbound calls. Failures/crashes remain charged; never auto-retry a reservation. */
export async function reserve(store: Store, kind: 'search' | 'jev', id: string, ref: string, now: number, day: string, month: string, daily: number, monthly: number, topicId: string | null = null) {
  return await store.run(`INSERT OR IGNORE INTO site_attempts(id,kind,day,month,ref,status,started_at,topic_id)
    SELECT ?,?,?,?,?, 'reserved',?,? WHERE
    (SELECT COALESCE(sum(units),0) FROM site_attempts WHERE kind=? AND day=?) < ? AND
    (SELECT COALESCE(sum(units),0) FROM site_attempts WHERE kind=? AND month=?) < ?`, id, kind, day, month, ref, now, topicId, kind, day, daily, kind, month, monthly) === 1;
}
export async function runNewsSite(env: SiteEnv, deps: { search?: SearchProvider; evaluator?: Evaluator; now?: () => number; scheduledAt?: number; manualDay?: string } = {}): Promise<SiteStats> {
  const now = deps.now ?? Date.now, start = now();
  const stats: SiteStats = { searches: 0, evaluations: 0, errors: 0, busy: false };
  if (env.SEARCH_ENABLED !== 'true' && env.JEV_ENABLED !== 'true') return stats;
  // Trusted CLI-only override: real current date, normal budgets and reservation keys.
  // Never supplied by the public HTTP handler or ordinary Cron.
  const manual = deps.manualDay !== undefined;
  if (manual && deps.manualDay !== localClock(start, env.NEWS_TIMEZONE).day) throw new Error('Manual run must use the current local day');
  const scheduledAt = deps.scheduledAt ?? start;
  const timely = Math.abs(start - scheduledAt) <= 5 * 60000;
  const clock = localClock(timely ? scheduledAt : start, env.NEWS_TIMEZONE);
  const hourly = !manual && timely && clock.hour >= 10 && clock.hour <= 20 && clock.minute === 0;
  const hour = limit(env.NEWS_MORNING_HOUR, 7, 7);
  const dailySearch = limit(env.TAVILY_DAILY_CREDITS, 36, 100), monthlySearch = limit(env.TAVILY_MONTHLY_CREDITS, 950, 1000);
  const dailyJev = limit(env.JEV_DAILY_REQUESTS, 360, 500), monthlyJev = limit(env.JEV_MONTHLY_REQUESTS, 10000, 15000);
  // Configure stages independently: a judge failure must not stop collection, nor
  // should a missing search credential prevent judging already queued candidates.
  let evaluator: Evaluator | undefined, search: SearchProvider | undefined;
  if (env.JEV_ENABLED === 'true') {
    try { evaluator = deps.evaluator ?? createJevEvaluator(env.AI!, env.AI_GATEWAY_ID ?? ''); }
    catch { stats.errors++; }
  }
  if (env.SEARCH_ENABLED === 'true') {
    try {
      if (!deps.search && !env.TAVILY_API_KEY?.trim()) throw new Error('Missing Tavily key');
      search = deps.search ?? createTavilySearchProvider(env.TAVILY_API_KEY!);
    } catch { stats.errors++; }
  }
  const configurationErrors = stats.errors;
  const store = new Store(env.DB), token = crypto.randomUUID(), runId = crypto.randomUUID();
  const lock = await store.run(`INSERT INTO site_locks(id,token,until_at) VALUES('news',?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,until_at=excluded.until_at WHERE site_locks.until_at <= ?`, token, start + 8 * 60000, start);
  if (!lock) return { ...stats, busy: true };
  try {
    await store.run("UPDATE site_runs SET status='failed',finished_at=? WHERE status='running' AND started_at<?", start, start - 8 * 60000);
    await store.run("UPDATE site_attempts SET status='failed',finished_at=?,error_code='interrupted' WHERE status='reserved' AND started_at<?", start, start - 8 * 60000);
    await store.run("UPDATE site_candidates SET status='failed' WHERE status='evaluating' AND evaluated_at<?", start - 8 * 60000);
    await store.run("UPDATE site_candidates SET status='expired' WHERE status='pending' AND created_at<?", start - 2 * 86400000);
    await store.run("INSERT INTO site_runs(id,started_at,status) VALUES(?,?,'running')", runId, start);
    const paused = await store.first("SELECT provider FROM site_provider_state WHERE provider='tavily' AND (until_at IS NULL OR until_at>?)", start);
    if (search && !paused && (manual || (timely && (hourly || (clock.hour >= hour && clock.hour < hour + 3))))) {
      const topics = (await store.all<Topic>('SELECT * FROM site_topics WHERE enabled=1 ORDER BY id'))
        .filter(topic => { topicQueries(topic); return (JSON.parse(topic.weekdays_json) as number[]).includes(clock.weekday); });
      const chosen = hourly ? hourlyTopic(topics) : undefined;
      const selected = hourly ? (chosen ? [chosen] : []) : topics;
      for (const topic of selected) {
        let queries = topicQueries(topic);
        if (hourly) {
          const history = await store.all<{ ref: string; last_at: number }>("SELECT ref,MAX(started_at) AS last_at FROM site_attempts WHERE kind='search' GROUP BY ref");
          const last = new Map(history.map(row => [row.ref, row.last_at]));
          const ranked = await Promise.all(queries.map(async query => ({ query, last: last.get(await hash(`${topic.id}:${query}`)) ?? 0 })));
          // Rotate subqueries by last attempt (including failures), not just last success.
          queries = [ranked.sort((a, b) => a.last - b.last || a.query.localeCompare(b.query))[0].query];
        }
        for (const query of queries) {
          if (stats.searches >= (hourly ? 1 : 3) || now() - start > 180000) break;
          const ref = await hash(`${topic.id}:${query}`);
          const attempt = hourly ? `hourly:${clock.day}:${clock.hour}` : `search:${clock.day}:${ref}`;
          const state = await store.first<{ last_success_at: number }>('SELECT last_success_at FROM site_query_state WHERE id=?', ref);
          const since = collectionSince(start, topic.gap_days, state?.last_success_at);
          if (!await reserve(store, 'search', attempt, ref, now(), clock.day, clock.month, dailySearch, monthlySearch, topic.id)) continue;
          stats.searches++;
          try {
            if (hourly) {
              const eligible = topics.filter(t => t.refresh_weight > 0);
              const total = eligible.reduce((sum, t) => sum + t.refresh_weight, 0);
              await env.DB.batch([
                ...eligible.map(t => env.DB.prepare('UPDATE site_topics SET refresh_credit=refresh_credit+refresh_weight WHERE id=?').bind(t.id)),
                env.DB.prepare('UPDATE site_topics SET refresh_credit=refresh_credit-?,last_refresh_at=? WHERE id=?').bind(total, start, topic.id),
              ]);
            }
            const result = await search.search({ query, maxResults: 10, startDate: manual ? clock.day : localClock(since, env.NEWS_TIMEZONE).day });
            // basic is fixed at 1 credit; unexpected reported cost stops further search this run.
            if (!Number.isSafeInteger(result.credits) || result.credits < 1 || result.credits > 1000000) throw new Error('Invalid search cost');
            await store.run('UPDATE site_attempts SET units=? WHERE id=?', result.credits, attempt);
            if (result.credits > 1) {
              await store.run("INSERT OR REPLACE INTO site_provider_state(provider,reason,until_at) VALUES('tavily','unexpected_cost',NULL)");
              throw new Error('Unexpected search cost');
            }
            for (const item of result.items.slice(0, 10)) {
              if (isNonNewsPage(item.url)) continue;
              const canonical = await articleId(item.url);
              const publication = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
              const eligible = Number.isFinite(publication) && publication >= since && publication <= start + 5 * 60000
                && (!manual || localClock(publication, env.NEWS_TIMEZONE).day === clock.day);
              const existing = await store.first<{ topic_id: string; status: string }>('SELECT topic_id,status FROM site_candidates WHERE article_id=? ORDER BY CASE WHEN status=\'baseline\' THEN 1 ELSE 0 END,topic_id LIMIT 1', canonical.id);
              // A URL already queued/judged in another topic is not new news.
              if (existing && existing.topic_id !== topic.id) continue;
              const newlyQueued = eligible && (!existing || existing.status === 'baseline');
              await env.DB.batch([
                env.DB.prepare(`INSERT INTO site_news(id,url,title,summary,published_at,discovered_at) VALUES(?,?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(site_news.published_at,excluded.published_at)`).bind(canonical.id, canonical.url, item.title, item.summary, item.publishedAt, start),
                env.DB.prepare(`INSERT INTO site_candidates(article_id,topic_id,status,created_at) VALUES(?,?,?,?)
                  ON CONFLICT(article_id,topic_id) DO UPDATE SET status='pending',created_at=excluded.created_at
                  WHERE excluded.status='pending' AND site_candidates.status='baseline'`).bind(canonical.id, topic.id, eligible ? 'pending' : 'baseline', start),
                ...(hourly && newlyQueued ? [env.DB.prepare('INSERT OR IGNORE INTO site_search_items(attempt_id,article_id,topic_id) VALUES(?,?,?)').bind(attempt, canonical.id, topic.id)] : []),
              ]);
            }
            await env.DB.batch([
              env.DB.prepare('INSERT INTO site_query_state(id,last_success_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at').bind(ref, start),
              env.DB.prepare("UPDATE site_attempts SET status='completed',finished_at=? WHERE id=?").bind(now(), attempt),
            ]);
          } catch (error) {
            stats.errors++;
            if (error instanceof SearchError) {
              const permanent = ['unauthorized', 'quota', 'configuration'].includes(error.code);
              await store.run("INSERT OR REPLACE INTO site_provider_state(provider,reason,until_at) VALUES('tavily',?,?)", error.code, permanent ? null : now() + Math.max(30 * 60000, error.retryAfterMs ?? 0));
            }
            await store.run("UPDATE site_attempts SET status='failed',finished_at=?,error_code='search_failed' WHERE id=?", now(), attempt);
            // Conservative stop: don't multiply authorization/quota/provider failures.
            break;
          }
        }
        if (stats.errors > configurationErrors || stats.searches >= (hourly ? 1 : 3)) break;
      }
    }
    if (manual && evaluator) {
      // The operator may include today's already-collected first-query baseline,
      // without repeating its search or admitting older undated history.
      const baselines = await store.all<{ article_id: string; topic_id: string; published_at: string }>(`SELECT c.article_id,c.topic_id,n.published_at
        FROM site_candidates c JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
        WHERE c.status='baseline' AND t.enabled=1 AND c.created_at>=? AND n.published_at>=? LIMIT 500`, start - 86400000, new Date(start - 86400000).toISOString());
      for (const row of baselines) {
        const publication = Date.parse(row.published_at);
        if (Number.isFinite(publication) && publication <= start + 5 * 60000 && localClock(publication, env.NEWS_TIMEZONE).day === clock.day)
          await store.run("UPDATE site_candidates SET status='pending',created_at=? WHERE article_id=? AND topic_id=? AND status='baseline'", start, row.article_id, row.topic_id);
      }
    }
    if (evaluator) {
      const jobs = await store.all<Candidate>(`SELECT c.article_id,c.topic_id,n.url,n.title,n.summary,n.published_at,t.*
        FROM site_candidates c JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
        WHERE c.status='pending' AND t.enabled=1 ORDER BY c.created_at,c.topic_id,c.article_id LIMIT 8`);
      for (const job of jobs) {
        if (now() - start > 180000) break;
        const published = Date.parse(job.published_at);
        if (isNonNewsPage(job.url) || !Number.isFinite(published) || published < start - 14 * 86400000 || published > start + 5 * 60000) {
          await store.run("UPDATE site_candidates SET status='expired' WHERE article_id=? AND topic_id=?", job.article_id, job.topic_id);
          continue;
        }
        const ref = `${job.article_id}:${job.topic_id}`, attempt = `jev:v2:${ref}`;
        if (!await reserve(store, 'jev', attempt, ref, now(), clock.day, clock.month, dailyJev, monthlyJev)) continue;
        await store.run("UPDATE site_candidates SET status='evaluating',evaluated_at=? WHERE article_id=? AND topic_id=? AND status='pending'", now(), job.article_id, job.topic_id);
        stats.evaluations++;
        try {
          const item: NewsItem = { externalId: job.article_id, url: job.url, title: job.title, summary: job.summary, publishedAt: job.published_at };
          const feedback = await feedbackContext(env.DB, job.topic_id, start);
          const evaluation = await evaluator.evaluate(item, { name: job.name, guidance: job.guidance, priority: job.priority, feedback: feedback.examples }), decision = selection(evaluation);
          await env.DB.batch([
            env.DB.prepare("UPDATE site_candidates SET status=?,score=?,evaluation_json=?,evaluated_at=? WHERE article_id=? AND topic_id=?").bind(decision.accepted ? 'accepted' : 'rejected', decision.score, JSON.stringify({ version: 2, ...evaluation, feedbackVersion: await hash(JSON.stringify(feedback)), feedbackRefs: feedback.revisions }), now(), job.article_id, job.topic_id),
            env.DB.prepare("UPDATE site_attempts SET status='completed',finished_at=? WHERE id=?").bind(now(), attempt),
          ]);
        } catch (error) {
          stats.errors++;
          await env.DB.batch([
            env.DB.prepare("UPDATE site_candidates SET status='failed',evaluated_at=? WHERE article_id=? AND topic_id=?").bind(now(), job.article_id, job.topic_id),
            env.DB.prepare("UPDATE site_attempts SET status='failed',finished_at=?,error_code='jev_failed',diagnostic_json=? WHERE id=?").bind(now(), JSON.stringify(modelDiagnostic(error)), attempt),
          ]);
          break;
        }
      }
    }
    await store.run('UPDATE site_runs SET status=?,finished_at=?,searches=?,evaluations=?,errors=? WHERE id=?', stats.errors ? 'partial' : 'completed', now(), stats.searches, stats.evaluations, stats.errors, runId);
    return stats;
  } catch {
    await store.run("UPDATE site_runs SET status='failed',finished_at=?,errors=errors+1 WHERE id=?", now(), runId);
    throw new Error('News run failed');
  } finally {
    await store.run("DELETE FROM site_locks WHERE id='news' AND token=?", token);
  }
}
