import { Store } from '../store';
import { generateDailyDigest, type Chat } from './digest';
import { localClock, runNewsSite, topicQueries, type Topic, type SiteEnv } from './pipeline';
import { createJevEvaluator } from './jev';
import { createGatewayChat } from './chat';
import type { SearchProvider } from '../search/providers';
import type { Evaluator } from './jev';
import { regenerateEmptyIssue } from './regenerate';
import { modelDiagnostic } from './diagnostics';

/** Explicitly authorized operator task. No HTTP route. Uses real time, the usual
 * daily/monthly reservations and existing daily issue key. Never resets failures.
 */
export async function runManualIssue(env: SiteEnv, day: string, deps: {
  now?: () => number; search?: SearchProvider; evaluator?: Evaluator; chat?: Chat;
  progress?: (stats: unknown) => void;
} = {}) {
  const now = deps.now ?? Date.now;
  if (day !== localClock(now(), env.NEWS_TIMEZONE).day) throw new Error('Use the current local date');
  if ([env.SEARCH_ENABLED, env.JEV_ENABLED, env.DIGEST_ENABLED].some(v => v !== 'true')) throw new Error('Search, Jev and digest must all be explicitly enabled');
  const evaluator = deps.evaluator ?? createJevEvaluator(env.AI!, env.AI_GATEWAY_ID ?? '');
  const chat = deps.chat ?? createGatewayChat(env.AI!, env.AI_GATEWAY_ID ?? '', env.DIGEST_MODEL ?? '', 4096);
  const store = new Store(env.DB);
  if (await store.first('SELECT day FROM site_digest_attempts WHERE day=?', day)) throw new Error('Today already has a reserved or finished issue; refusing to retry');
  for (let round = 0; round < 64; round++) {
    if (day !== localClock(now(), env.NEWS_TIMEZONE).day) throw new Error('Local day changed; stopping');
    const stats = await runNewsSite(env, { ...deps, evaluator, now, manualDay: day });
    deps.progress?.({ round: round + 1, ...stats });
    if (stats.busy || stats.errors) throw new Error('Collection/judging busy or failed; stopping without retry or digest');
    if (stats.searches || stats.evaluations) continue;
    const pending = await store.first<{ n: number }>("SELECT count(*) AS n FROM site_candidates WHERE status IN ('pending','evaluating')");
    if (pending?.n) throw new Error('Unfinished candidates remain (possibly budget exhausted); refusing a premature issue');
    const paused = await store.first("SELECT provider FROM site_provider_state WHERE provider='tavily' AND (until_at IS NULL OR until_at>?)", now());
    if (paused) throw new Error('Search provider is paused; refusing an incomplete manual issue');
    const topics = await store.all<Topic>('SELECT * FROM site_topics WHERE enabled=1');
    const weekday = localClock(now(), env.NEWS_TIMEZONE).weekday;
    for (const topic of topics) {
      const queries = topicQueries(topic);
      if (!(JSON.parse(topic.weekdays_json) as number[]).includes(weekday)) continue;
      for (const query of queries) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${topic.id}:${query}`));
        const ref = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
        const attempt = await store.first<{ status: string }>('SELECT status FROM site_attempts WHERE id=?', `search:${day}:${ref}`);
        if (attempt?.status !== 'completed') throw new Error('Daily search plan is incomplete or failed; refusing a premature issue');
      }
    }
    return generateDailyDigest(env, { chat, now, manualDay: day });
  }
  throw new Error('Manual task round limit reached; stopping');
}

/** Called only by scheduled(), never fetch(). Each explicit authorization runs once.
 * Changing the authorization ID requires a new operator instruction, not an auto-retry.
 */
export async function dispatchManualIssue(env: SiteEnv, deps: Parameters<typeof runManualIssue>[2] = {}): Promise<boolean> {
  const now = deps.now ?? Date.now, start = now();
  const day = localClock(start, env.NEWS_TIMEZONE).day;
  if (env.MANUAL_ISSUE_DAY !== day) return false;
  const authorization = env.MANUAL_ISSUE_AUTHORIZATION ?? 'initial';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(authorization)) throw new Error('Invalid manual authorization ID');
  const store = new Store(env.DB);
  const running = await store.first("SELECT day FROM site_manual_authorizations WHERE status='running' AND day=?", day);
  if (running) return true;
  const existing = await store.first<{ status: string }>('SELECT status FROM site_manual_authorizations WHERE day=? AND authorization_id=?', day, authorization);
  if (existing) return false; // finished authorization: ordinary Cron resumes
  if (!await store.run("INSERT OR IGNORE INTO site_manual_authorizations(day,authorization_id,status,started_at) VALUES(?,?,'running',?)", day, authorization, start)) return true;
  try {
    const result = env.MANUAL_ISSUE_REGENERATE === 'true'
      ? await regenerateEmptyIssue(env, day, authorization, deps)
      : await runManualIssue(env, day, deps);
    await store.run('UPDATE site_manual_authorizations SET status=?,finished_at=?,result=? WHERE day=? AND authorization_id=?', result === 'published' ? 'completed' : 'failed', now(), result, day, authorization);
  } catch (error) {
    await store.run("UPDATE site_manual_authorizations SET status='failed',finished_at=?,error_code='manual_issue_failed' WHERE day=? AND authorization_id=?", now(), day, authorization);
    console.error('manual_issue_failed', JSON.stringify(modelDiagnostic(error)));
  }
  return true;
}
