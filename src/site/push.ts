import { Store } from '../store';

export const PUSH_THRESHOLD = 0.8;
export interface PushEvent {
  version: 1;
  type: 'news.worth-reading';
  id: string;
  recipientId: string;
  createdAt: string;
  article: { id: string; title: string; url: string; publishedAt: string };
  judgment: { version: 2; worthReading: number };
  origin: { type: 'hourly'; attemptId: string };
}

/** Future delivery adapter. Article strings are untrusted text, not HTML/instructions.
 * The caller MUST reserve a delivery in D1 and enforce recipient limits before send.
 * idempotencyKey is stable per event/recipient; it is not a promise of exactly-once delivery.
 * Throwing, timing out or losing the response means UNKNOWN, never automatic retry.
 * This module intentionally has no dispatcher, network calls or concrete adapter.
 */
export interface PushTransport {
  send(event: PushEvent, context: { idempotencyKey: string; signal: AbortSignal }): Promise<
    | { status: 'accepted'; receiptId?: string }
    | { status: 'rejected'; code: string }
    | { status: 'unknown'; code: string }
  >;
}
export interface PushEventEnv {
  DB: D1Database;
  PUSH_EVENTS_ENABLED?: string;
  /** Explicit activation instant. Searches before this instant are never backfilled. */
  PUSH_EVENTS_SINCE?: string;
}

/** Record intent independently of collection/judging and any eventual delivery transport.
 * Scans hourly search membership, not the public top-three projection. Completed
 * judgments from a later Cron are included. Unique canonical article IDs dedupe
 * across topics, batches and repeated/concurrent invocations for the personal owner.
 */
export async function capturePushEvents(env: PushEventEnv, now = Date.now()): Promise<number> {
  if (env.PUSH_EVENTS_ENABLED !== 'true') return 0;
  const since = Date.parse(env.PUSH_EVENTS_SINCE ?? '');
  if (!Number.isFinite(since) || !env.PUSH_EVENTS_SINCE?.endsWith('Z')) throw new Error('Push events require an explicit UTC activation instant');
  if (since > now) return 0;
  const store = new Store(env.DB);
  const rows = await store.all<{
    id: string; title: string; url: string; published_at: string;
    attempt_id: string; evaluation_json: string;
  }>(`SELECT n.id,n.title,n.url,n.published_at,i.attempt_id,c.evaluation_json
    FROM site_search_items i
    JOIN site_attempts a ON a.id=i.attempt_id
    JOIN site_candidates c ON c.article_id=i.article_id AND c.topic_id=i.topic_id
    JOIN site_news n ON n.id=i.article_id
    JOIN site_topics t ON t.id=i.topic_id
    WHERE a.kind='search' AND a.id LIKE 'hourly:%' AND a.status='completed'
      AND a.started_at>=? AND a.started_at<=? AND c.status='accepted'
      AND c.score>=80 AND c.score<=100 AND t.enabled=1
      AND NOT EXISTS (SELECT 1 FROM site_push_events e WHERE e.recipient_id='owner' AND e.article_id=n.id)
    ORDER BY a.started_at,c.score DESC,n.id,i.topic_id LIMIT 100`, since, now);
  let created = 0;
  for (const row of rows) {
    let judgment: { version?: unknown; worthReading?: unknown };
    try { judgment = JSON.parse(row.evaluation_json); } catch { continue; }
    const score = judgment?.worthReading;
    if (judgment?.version !== 2 || typeof score !== 'number' || !Number.isFinite(score) || score < PUSH_THRESHOLD || score > 1) continue;
    let url: URL;
    try { url = new URL(row.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || row.url.length > 4096 ||
        !row.title.trim() || row.title.length > 1000 || !Number.isFinite(Date.parse(row.published_at))) continue;
    const id = `news-worth-reading:v1:owner:${row.id}`;
    const event: PushEvent = {
      version: 1, type: 'news.worth-reading', id, recipientId: 'owner', createdAt: new Date(now).toISOString(),
      article: { id: row.id, title: row.title, url: row.url, publishedAt: row.published_at },
      judgment: { version: 2, worthReading: score }, origin: { type: 'hourly', attemptId: row.attempt_id },
    };
    created += await store.run(`INSERT OR IGNORE INTO site_push_events(id,recipient_id,article_id,attempt_id,created_at,payload_json)
      VALUES(?,'owner',?,?,?,?)`, id, row.id, row.attempt_id, now, JSON.stringify(event));
  }
  return created;
}
