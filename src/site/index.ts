import { Store } from '../store';
import { siteAsset } from './page';
import { runNewsSite, type SiteEnv } from './pipeline';
import { generateDailyDigest, publicDigest, validDay } from './digest';
import { handleFeedbackRequest } from './feedback';
import { rollingUpdates } from './updates';
import { dispatchManualIssue } from './manual';
import { dispatchJevSmoke } from './smoke';
import { capturePushEvents } from './push';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export async function handleSiteRequest(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path.startsWith('/api/feedback')) return handleFeedbackRequest(request, env);
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const asset = siteAsset(path);
  if (asset) return asset;
  if (path === '/health') return json({ service: 'get-news', mode: 'public-read-owner-feedback' });
  if (path !== '/api/updates' && path !== '/api/news' && path !== '/api/digests' && !/^\/api\/digests\/(latest|\d{4}-\d{2}-\d{2})$/.test(path)) return json({ error: 'not_found' }, 404);
  try {
    const store = new Store(env.DB);
    if (path === '/api/updates') return json(await rollingUpdates(env.DB));
    if (path === '/api/digests') {
      const before = url.searchParams.get('before') ?? '9999-12-31';
      if (!validDay(before)) return json({ error: 'invalid_date' }, 400);
      const items = await store.all('SELECT day,title,created_at AS createdAt FROM site_digests WHERE day<? ORDER BY day DESC LIMIT 31', before);
      return json({ items });
    }
    if (path.startsWith('/api/digests/')) {
      let day = path.split('/').pop()!;
      if (day === 'latest') day = (await store.first<{ day: string }>('SELECT day FROM site_digests ORDER BY day DESC LIMIT 1'))?.day ?? '';
      if (!validDay(day)) return json({ error: 'digest_not_found' }, 404);
      const digest = await publicDigest(env.DB, day);
      return digest ? json(digest) : json({ error: 'digest_not_found' }, 404);
    }
    // Explicit public projection. Never expose prompts, private profile, feedback or budgets.
    const items = await store.all(`SELECT id,url,title,summary,publishedAt,score,topicId,channel FROM (
      SELECT n.id,n.url,n.title,n.summary,n.published_at AS publishedAt,c.score,t.id AS topicId,t.name AS channel,
      ROW_NUMBER() OVER(PARTITION BY n.id ORDER BY c.score DESC,t.id) AS rank
      FROM site_candidates c JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
      WHERE c.status='accepted' AND t.enabled=1 AND n.published_at>=?
    ) WHERE rank=1 ORDER BY publishedAt DESC,score DESC,id LIMIT 100`, new Date(Date.now() - 14 * 86400000).toISOString());
    const channels = await store.all('SELECT id,name FROM site_topics WHERE enabled=1 ORDER BY id');
    const last = await store.first<{ finished_at: number }>("SELECT finished_at FROM site_runs WHERE status='completed' AND searches+evaluations>0 ORDER BY finished_at DESC LIMIT 1");
    const latest = await store.first<{ status: string }>('SELECT status FROM site_runs ORDER BY started_at DESC LIMIT 1');
    return json({ items, channels, lastUpdated: last?.finished_at ? new Date(last.finished_at).toISOString() : null, latestRunStatus: latest?.status ?? null });
  } catch { return json({ error: 'news_unavailable' }, 503); }
}
export default {
  fetch: handleSiteRequest,
  async scheduled(event: ScheduledController, env: SiteEnv, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      try { if (await dispatchJevSmoke(env)) return; } catch (error) { console.error('jev_smoke_dispatch_failed', String(error)); return; }
      try { if (await dispatchManualIssue(env)) return; } catch { console.error('manual_issue_dispatch_failed'); return; }
      try { await runNewsSite(env, { scheduledAt: event.scheduledTime }); } catch { console.error('news_site_run_failed'); }
      try { await capturePushEvents(env); } catch (error) { console.error('push_event_capture_failed', String(error)); }
      try { await generateDailyDigest(env); } catch { console.error('digest_configuration_or_store_failed'); }
    })());
  },
} satisfies ExportedHandler<SiteEnv>;
