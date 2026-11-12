import { Store } from '../store';
import { EDITORIAL_PROFILE } from '../llm/editorial-profile';
import { createGatewayChat } from './chat';
import { createJevEvaluator, type Evaluator } from './jev';
import { DIGEST_SYSTEM, parseDigest, normalizeDigestOutput, digestLength, type Chat, type DigestSource } from './digest';
import { modelDiagnostic, redact } from './diagnostics';
import { localClock, runNewsSite, type SiteEnv } from './pipeline';

/** Explicit operator authorization only. Re-evaluate the saved current-day pool
 * under policy v2, without searches, resetting paid reservations or losing history.
 * Only an existing empty, model-free issue can be replaced by this workflow.
 */
export async function regenerateEmptyIssue(env: SiteEnv, day: string, authorization: string, deps: {
  now?: () => number; evaluator?: Evaluator; chat?: Chat;
} = {}) {
  const now = deps.now ?? Date.now, start = now(), clock = localClock(start, env.NEWS_TIMEZONE);
  if (day !== clock.day || !/^[a-zA-Z0-9_-]{1,64}$/.test(authorization)) throw new Error('Invalid current-day regeneration authorization');
  if (env.JEV_ENABLED !== 'true' || env.DIGEST_ENABLED !== 'true') throw new Error('Judging and digest must be enabled');
  const store = new Store(env.DB);
  const previous = await store.first<Record<string, unknown>>('SELECT * FROM site_digests WHERE day=?', day);
  const previousAttempt = await store.first<Record<string, unknown>>('SELECT * FROM site_digest_attempts WHERE day=?', day);
  if (previous?.model !== 'none' || previous.stories_json !== '[]' || previousAttempt?.model !== 'none') throw new Error('Only a model-free empty issue may be regenerated');
  if (await store.first('SELECT day FROM site_digest_inputs WHERE day=? UNION ALL SELECT day FROM site_digest_sources WHERE day=? LIMIT 1', day, day)) throw new Error('Existing issue has processed inputs or citations');
  if (await store.first('SELECT day FROM site_digest_regenerations WHERE day=? AND authorization_id=?', day, authorization)) throw new Error('Regeneration already reserved; refusing to retry');
  const replayFrom = env.MANUAL_ISSUE_REPLAY_DRAFT_FROM;
  const budget = Number(env.DIGEST_MONTHLY_REQUESTS ?? '31');
  if (env.DIGEST_MONTHLY_REQUESTS === '' || !Number.isInteger(budget) || budget < 0 || budget > 31) throw new Error('Invalid digest budget');
  const spent = await store.first<{ n: number }>(`SELECT
    (SELECT count(*) FROM site_digest_attempts WHERE month=? AND model!='none')+
    (SELECT count(*) FROM site_digest_regenerations WHERE month=? AND model!='none') AS n`, clock.month, clock.month);
  if (!replayFrom && (spent?.n ?? 0) >= budget) throw new Error('Digest budget exhausted');
  const model = env.DIGEST_MODEL ?? '';
  let savedOutput: string | undefined;
  if (replayFrom) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(replayFrom) || replayFrom === authorization || env.MANUAL_ISSUE_REUSE_JUDGMENTS !== 'true') throw new Error('Invalid saved-draft replay authorization');
    const saved = await store.first<{ model: string; status: string; diagnostic_json: string }>('SELECT model,status,diagnostic_json FROM site_digest_regenerations WHERE day=? AND authorization_id=?', day, replayFrom);
    if (saved?.status !== 'failed' || saved.model !== model) throw new Error('Saved draft does not match the selected model');
    savedOutput = JSON.parse(saved.diagnostic_json).output;
    if (typeof savedOutput !== 'string') throw new Error('No saved model output to replay');
  }
  const chat = replayFrom ? { complete: async () => savedOutput! } : deps.chat ?? createGatewayChat(env.AI!, env.AI_GATEWAY_ID ?? '', model, 4096);
  if (env.MANUAL_ISSUE_REUSE_JUDGMENTS !== 'true') {
  const evaluator = deps.evaluator ?? createJevEvaluator(env.AI!, env.AI_GATEWAY_ID ?? '');
  const candidates = await store.all<{ article_id: string; topic_id: string; published_at: string; evaluation_json: string | null }>(`SELECT c.*,n.published_at FROM site_candidates c
    JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
    WHERE t.enabled=1 AND c.status IN ('accepted','rejected','failed') AND n.published_at>=?
      AND NOT EXISTS(SELECT 1 FROM site_attempts a WHERE a.id='jev:v2:'||c.article_id||':'||c.topic_id)
    ORDER BY c.article_id,c.topic_id LIMIT 500`, new Date(start - 86400000).toISOString());
  for (const candidate of candidates) {
    const publication = Date.parse(candidate.published_at);
    if (!Number.isFinite(publication) || publication > start + 5 * 60000 || localClock(publication, env.NEWS_TIMEZONE).day !== day) continue;
    if (candidate.evaluation_json && JSON.parse(candidate.evaluation_json).version === 2) continue;
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO site_judgment_history(authorization_id,article_id,topic_id,snapshot_json,archived_at) VALUES(?,?,?,?,?)').bind(authorization, candidate.article_id, candidate.topic_id, JSON.stringify(candidate), now()),
      env.DB.prepare("UPDATE site_candidates SET status='pending',created_at=?,score=NULL,evaluation_json=NULL,evaluated_at=NULL WHERE article_id=? AND topic_id=?").bind(now(), candidate.article_id, candidate.topic_id),
    ]);
  }
  for (let round = 0; round < 64; round++) {
    if (localClock(now(), env.NEWS_TIMEZONE).day !== day) throw new Error('Local day changed');
    const stats = await runNewsSite({ ...env, SEARCH_ENABLED: 'false' }, { evaluator, now });
    if (stats.errors || stats.busy) throw new Error('Rejudging failed or busy; no automatic retry');
    if (stats.evaluations) continue;
    if (await store.first("SELECT article_id FROM site_candidates WHERE status IN ('pending','evaluating') LIMIT 1")) throw new Error('Judging incomplete or budget exhausted');
    break;
  }
  if (await store.first("SELECT article_id FROM site_candidates WHERE status IN ('pending','evaluating') LIMIT 1")) throw new Error('Rejudging round limit reached');
  }
  const ranked = await store.all<DigestSource>(`SELECT n.id,c.topic_id AS topicId,t.name AS channel,n.title,n.summary,n.url,n.published_at AS publishedAt,c.score
    FROM site_candidates c JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
    WHERE c.status='accepted' AND t.enabled=1 AND json_extract(c.evaluation_json,'$.version')=2 AND n.published_at>=?
    ORDER BY c.score DESC,n.published_at DESC,n.id,t.id LIMIT 500`, new Date(start - 86400000).toISOString());
  const seen = new Set<string>();
  const sources = ranked.filter(source => {
    const publication = Date.parse(source.publishedAt);
    if (!Number.isFinite(publication) || publication > now() + 5 * 60000 || localClock(publication, env.NEWS_TIMEZONE).day !== day || seen.has(source.id)) return false;
    seen.add(source.id); return true;
  }).slice(0, 10);
  if (!sources.length) throw new Error('No current-day candidates to regenerate from');
  const reserved = await store.run(`INSERT OR IGNORE INTO site_digest_regenerations(day,authorization_id,month,status,started_at,model)
    SELECT ?,?,?,'reserved',?,? WHERE ?=1 OR
    ((SELECT count(*) FROM site_digest_attempts WHERE month=? AND model!='none')+
     (SELECT count(*) FROM site_digest_regenerations WHERE month=? AND model!='none'))<?`, day, authorization, clock.month, now(), replayFrom ? 'none' : model, replayFrom ? 1 : 0, clock.month, clock.month, budget);
  if (!reserved) throw new Error('Digest budget exhausted or regeneration already reserved');
  let output: string | undefined;
  try {
    const input = { date: day, cutoff: new Date(now()).toISOString(), recentStories: [], fixedEditorialProfile: EDITORIAL_PROFILE,
      articles: sources.map(s => ({ id: s.id, topicId: s.topicId, channel: s.channel, title: s.title.slice(0, 300), summary: s.summary.slice(0, 800), publishedAt: s.publishedAt, score: s.score })) };
    output = await chat.complete(DIGEST_SYSTEM, input);
    const normalized = normalizeDigestOutput(output);
    const draft = parseDigest(normalized.content, sources), used = new Set(draft.stories.flatMap(story => story.articleIds));
    const published = now();
    const pending = await store.first<{ n: number }>("SELECT count(*) AS n FROM site_candidates WHERE status IN ('pending','evaluating')");
    await env.DB.batch([
      // The NOT NULL snapshot subquery also guards against concurrent replacement:
      // if the original issue no longer matches, the whole batch rolls back.
      env.DB.prepare(`INSERT INTO site_digest_revisions(day,authorization_id,snapshot_json,archived_at) VALUES(?,?,
        (SELECT ? FROM site_digests WHERE day=? AND model='none' AND stories_json='[]' AND created_at=?),?)`)
        .bind(day, authorization, JSON.stringify({ digest: previous, attempt: previousAttempt }), day, previous.created_at, published),
      env.DB.prepare(`UPDATE site_digests SET title=?,overview=?,stories_json=?,created_at=?,model=?,policy_version=2,profile_json=?,input_json=?,pending_count=? WHERE day=?`)
        .bind(draft.title, draft.overview, JSON.stringify(draft.stories), published, model, JSON.stringify(EDITORIAL_PROFILE), JSON.stringify({ ...input, editorialNoticeAdded: normalized.noticeAdded, replayedFrom: replayFrom ?? null, rawModelOutput: output }), pending?.n ?? 0, day),
      ...sources.map(s => env.DB.prepare('INSERT INTO site_digest_inputs(day,article_id) VALUES(?,?)').bind(day, s.id)),
      ...sources.filter(s => used.has(s.id)).map(s => env.DB.prepare('INSERT INTO site_digest_sources(day,article_id,topic_id,snapshot_json) VALUES(?,?,?,?)').bind(day, s.id, s.topicId, JSON.stringify(s))),
      env.DB.prepare("UPDATE site_digest_regenerations SET status='published',finished_at=?,diagnostic_json=? WHERE day=? AND authorization_id=?")
        .bind(published, JSON.stringify({ providerCall: !replayFrom, authoredByModel: model, replayedFrom: replayFrom ?? null, editorialNoticeAdded: normalized.noticeAdded, bodyLength: digestLength(draft.overview) }), day, authorization),
    ]);
    return 'published';
  } catch (error) {
    const diagnostic = { error: modelDiagnostic(error), model, output: output === undefined ? undefined : redact(output) };
    console.error('digest_regeneration_failed', JSON.stringify(diagnostic));
    await store.run("UPDATE site_digest_regenerations SET status='failed',finished_at=?,diagnostic_json=? WHERE day=? AND authorization_id=?", now(), JSON.stringify(diagnostic), day, authorization);
    return 'failed';
  }
}
