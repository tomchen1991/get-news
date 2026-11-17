import { Store } from '../store';
import { localClock, type SiteEnv } from './pipeline';
import { capturePushEvents, pushThreshold, type PushEvent } from './push';

export interface MessageCenterEnv {
  MESSAGE_CENTER_ENABLED?: string;
  MESSAGE_CENTER_URL?: string;
  MESSAGE_CENTER_PRODUCER_TOKEN?: string;
  /** UTC activation instant: never automatically backfill older events/digests. */
  MESSAGE_CENTER_SINCE?: string;
  NEWS_PUBLIC_URL?: string;
}
interface Message {
  externalId: string; type: string; title: string; body: string;
  priority: 'normal' | 'high'; url?: string;
  metadata: Record<string, unknown>; occurredAt: string;
}

/** No model calls. No automatic retries, including ambiguous HTTP outcomes.
 * A stable source-scoped externalId additionally deduplicates at the receiver.
 * D1 reservations atomically deduplicate concurrent sends; no daily count limit.
 */
export async function dispatchMessageCenter(env: SiteEnv, deps: { now?: number; fetcher?: typeof fetch } = {}): Promise<number> {
  if (env.MESSAGE_CENTER_ENABLED !== 'true') return 0;
  const now = deps.now ?? Date.now();
  const since = Date.parse(env.MESSAGE_CENTER_SINCE ?? '');
  const token = env.MESSAGE_CENTER_PRODUCER_TOKEN;
  // Fixed trusted service origin: credentials must never follow redirects or arbitrary URLs.
  const base = env.MESSAGE_CENTER_URL ?? 'https://messages.falsita.cn';
  if (!Number.isFinite(since) || !env.MESSAGE_CENTER_SINCE?.endsWith('Z') ||
      !token || !/^[\x21-\x7e]{16,512}$/.test(token) || base !== 'https://messages.falsita.cn') {
    throw new Error('Invalid message center configuration');
  }
  if (since > now) return 0;
  const threshold = pushThreshold(env);
  let publicBase: URL | undefined;
  if (env.NEWS_PUBLIC_URL) {
    try { publicBase = new URL(env.NEWS_PUBLIC_URL); } catch { throw new Error('Invalid news public URL'); }
    if (publicBase.protocol !== 'https:' || publicBase.username || publicBase.password || publicBase.search || publicBase.hash || publicBase.pathname !== '/') throw new Error('Invalid news public URL');
  }
  const store = new Store(env.DB);
  const day = localClock(now, env.NEWS_TIMEZONE).day;
  // Only today's digest: mandatory independent of news score, including empty editions.
  const digest = await store.first<{ day: string; title: string; overview: string; created_at: number }>(
    'SELECT day,title,overview,created_at FROM site_digests WHERE day=? AND created_at>=? AND created_at<=?', day, since, now);
  const messages: { kind: 'news' | 'digest'; message: Message }[] = [];
  if (digest) messages.push({ kind: 'digest', message: {
    externalId: `news-digest:v1:owner:${digest.day}`, type: 'news.daily-digest',
    title: digest.title.slice(0, 500), body: digest.overview, priority: 'normal',
    ...(publicBase ? { url: new URL(`/daily/${digest.day}`, publicBase).href } : {}),
    metadata: { day: digest.day }, occurredAt: new Date(digest.created_at).toISOString(),
  } });
  // Collection stays transport-independent. Activation cannot capture historical searches.
  try {
    await capturePushEvents({ ...env, PUSH_EVENTS_ENABLED: 'true', PUSH_EVENTS_SINCE: new Date(since).toISOString() }, now);
  } catch { console.error('message_center_news_capture_failed'); }
  const events = await store.all<{ payload_json: string }>(`SELECT payload_json FROM site_push_events e
    WHERE created_at>=? AND created_at<=? AND NOT EXISTS(SELECT 1 FROM site_message_deliveries d WHERE d.id=e.id)
    ORDER BY created_at,id LIMIT 100`, Math.max(since, now - 86400000), now);
  for (const row of events) {
    let event: PushEvent;
    try { event = JSON.parse(row.payload_json) as PushEvent; } catch { continue; }
    if (event?.type !== 'news.worth-reading' || event?.recipientId !== 'owner' || !event.article || !event.judgment || event.judgment.version !== 2 || !Number.isFinite(event.judgment.worthReading) || event.judgment.worthReading <= threshold || event.judgment.worthReading > 1 || event.article.url.length > 2048 || Date.parse(event.article.publishedAt) < now - 86400000) continue;
    messages.push({ kind: 'news', message: {
      externalId: event.id, type: event.type, title: event.article.title.slice(0, 500),
      body: event.article.title, priority: 'high', url: event.article.url,
      metadata: { articleId: event.article.id, worthReading: event.judgment.worthReading }, occurredAt: event.createdAt,
    } });
  }
  let accepted = 0;
  for (const { kind, message } of messages) {
    const payload = JSON.stringify(message);
    if (!await store.run(`INSERT OR IGNORE INTO site_message_deliveries(id,recipient_id,kind,local_day,status,payload_json,reserved_at)
      VALUES(?,'owner',?,?,'reserved',?,?)`,
      message.externalId, kind, day, payload, now)) continue;
    let status = 'unknown', httpStatus: number | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await (deps.fetcher ?? fetch)(`${base}/v1/messages`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload,
      });
      httpStatus = response.status;
      // The service only returns 200/201 after committing. No response text is logged or stored.
      status = response.status === 200 || response.status === 201 ? 'accepted'
        : response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : 'unknown';
      await response.body?.cancel();
    } catch { /* Network/redirect/timeout outcomes remain unknown; never retry automatically. */ }
    finally { clearTimeout(timer); }
    await store.run('UPDATE site_message_deliveries SET status=?,finished_at=?,http_status=? WHERE id=?', status, now, httpStatus, message.externalId);
    if (status === 'accepted') accepted++;
  }
  return accepted;
}
