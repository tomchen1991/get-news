import { Store } from '../store';
import { accessConfigured, accessUser, type AccessEnv } from './access';

export type FeedbackKind = 'more' | 'uninterested' | 'duplicate' | 'quality';
export interface FeedbackExample { title: string; kind: FeedbackKind; note: string; updatedAt: number }
export interface FeedbackInput { requestId: string; articleId: string; topicId: string; kind: FeedbackKind | null; note: string; expectedRevision: number }
export class FeedbackError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function parseFeedback(value: unknown): FeedbackInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackError('invalid_feedback');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['requestId', 'articleId', 'topicId', 'kind', 'note', 'expectedRevision'].includes(k)) ||
      typeof v.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(v.requestId) || !id(v.articleId) ||
      typeof v.topicId !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(v.topicId) ||
      !(v.kind === null || ['more', 'uninterested', 'duplicate', 'quality'].includes(v.kind as string)) ||
      typeof v.note !== 'string' || v.note.length > 500 || typeof v.expectedRevision !== 'number' || !Number.isSafeInteger(v.expectedRevision) || v.expectedRevision < 0 || v.expectedRevision > 1000000) throw new FeedbackError('invalid_feedback');
  return { ...v, note: v.kind === null ? '' : v.note.trim() } as unknown as FeedbackInput;
}
/** Optimistic concurrency + append-only audit + request idempotency in a D1 transaction. */
export async function writeFeedback(db: D1Database, user: string, input: FeedbackInput, now: number): Promise<number> {
  const store = new Store(db);
  const old = await store.first<Record<string, unknown>>('SELECT * FROM site_feedback_events WHERE request_id=?', input.requestId);
  if (old) {
    if (old.user_id !== user || old.article_id !== input.articleId || old.topic_id !== input.topicId || old.kind !== input.kind || old.note !== input.note || old.expected_revision !== input.expectedRevision) throw new FeedbackError('request_id_conflict', 409);
    return input.expectedRevision + 1;
  }
  const visible = await store.first(`SELECT article_id FROM site_candidates WHERE article_id=? AND topic_id=? AND status='accepted'
    UNION SELECT article_id FROM site_digest_sources WHERE article_id=? AND topic_id=? LIMIT 1`, input.articleId, input.topicId, input.articleId, input.topicId);
  if (!visible) throw new FeedbackError('news_not_found', 404);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO site_feedback_events(request_id,user_id,article_id,topic_id,kind,note,expected_revision,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE
      COALESCE((SELECT revision FROM site_feedback WHERE user_id=? AND article_id=? AND topic_id=?),0)=?
      AND (SELECT count(*) FROM site_feedback_events WHERE user_id=? AND created_at>=?)<100`)
      .bind(input.requestId, user, input.articleId, input.topicId, input.kind, input.note, input.expectedRevision, now, user, input.articleId, input.topicId, input.expectedRevision, user, now - 86400000),
    db.prepare(`INSERT INTO site_feedback(user_id,article_id,topic_id,kind,note,revision,updated_at)
      SELECT user_id,article_id,topic_id,kind,note,expected_revision+1,created_at FROM site_feedback_events
      WHERE request_id=? AND user_id=? AND article_id=? AND topic_id=? AND expected_revision=?
      ON CONFLICT(user_id,article_id,topic_id) DO UPDATE SET kind=excluded.kind,note=excluded.note,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE site_feedback.revision=excluded.revision-1`)
      .bind(input.requestId, user, input.articleId, input.topicId, input.expectedRevision),
  ]);
  const event = await store.first<Record<string, unknown>>('SELECT * FROM site_feedback_events WHERE request_id=?', input.requestId);
  if (!event) {
    const rate = await store.first<{ n: number }>('SELECT count(*) AS n FROM site_feedback_events WHERE user_id=? AND created_at>=?', user, now - 86400000);
    throw new FeedbackError((rate?.n ?? 0) >= 100 ? 'feedback_rate_limit' : 'revision_conflict', (rate?.n ?? 0) >= 100 ? 429 : 409);
  }
  if (event.user_id !== user || event.article_id !== input.articleId || event.topic_id !== input.topicId || event.kind !== input.kind || event.note !== input.note || event.expected_revision !== input.expectedRevision) throw new FeedbackError('request_id_conflict', 409);
  return input.expectedRevision + 1;
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !request.body) throw new FeedbackError('json_required');
  const reader = request.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) { await reader.cancel(); throw new FeedbackError('body_too_large', 413); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode(); return JSON.parse(text);
  } catch (error) { if (error instanceof FeedbackError) throw error; throw new FeedbackError('invalid_json'); }
  finally { reader.releaseLock(); }
}
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Cf-Access-Jwt-Assertion' } });
export async function handleFeedbackRequest(request: Request, env: AccessEnv & { DB: D1Database }, deps: { fetcher?: typeof fetch; now?: number } = {}): Promise<Response> {
  const url = new URL(request.url), session = url.pathname === '/api/feedback/session', login = url.pathname === '/api/feedback/login';
  if (!['/api/feedback', '/api/feedback/session', '/api/feedback/login'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
  if (!(request.method === 'GET' || (!session && !login && request.method === 'POST'))) return new Response(null, { status: 405, headers: { Allow: session || login ? 'GET' : 'GET, POST' } });
  if (!accessConfigured(env)) return session ? json({ enabled: false, authenticated: false }) : json({ error: 'feedback_disabled' }, 404);
  if (request.method === 'POST' && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) return json({ error: 'origin_rejected' }, 403);
  const user = await accessUser(request, env, deps);
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (session) return json({ enabled: true, authenticated: true });
  if (login) return new Response(null, { status: 303, headers: { Location: '/feedback', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  try {
    if (request.method === 'GET') {
      const ids = [...new Set((url.searchParams.get('articleIds') ?? '').split(',').filter(Boolean))];
      if (ids.length > 100 || ids.some(v => !id(v))) throw new FeedbackError('invalid_article_ids');
      const store = new Store(env.DB);
      const rows = await store.all(`SELECT article_id AS articleId,topic_id AS topicId,kind,note,revision FROM site_feedback WHERE user_id=?
        ${ids.length ? `AND article_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY updated_at DESC LIMIT 200`, user, ...ids);
      return json({ items: rows });
    }
    const input = parseFeedback(await body(request));
    const revision = await writeFeedback(env.DB, user, input, deps.now ?? Date.now());
    return json({ ok: true, revision });
  } catch (error) {
    return error instanceof FeedbackError ? json({ error: error.code }, error.status) : json({ error: 'feedback_unavailable' }, 503);
  }
}
export async function feedbackContext(db: D1Database, topicId: string, now: number) {
  const rows = await new Store(db).all<{ user_id: string; article_id: string; revision: number; title: string; kind: FeedbackKind; note: string; updated_at: number }>(`SELECT f.user_id,f.article_id,f.revision,n.title,f.kind,f.note,f.updated_at FROM site_feedback f
    JOIN site_news n ON n.id=f.article_id WHERE f.topic_id=? AND f.kind IS NOT NULL AND f.updated_at>=?
    ORDER BY f.updated_at DESC,f.article_id LIMIT 6`, topicId, now - 90 * 86400000);
  return {
    examples: rows.map(r => ({ title: r.title.slice(0, 300), kind: r.kind, note: r.note.slice(0, 500), updatedAt: r.updated_at })),
    revisions: rows.map(r => ({ userId: r.user_id, articleId: r.article_id, revision: r.revision, updatedAt: r.updated_at })),
  };
}
