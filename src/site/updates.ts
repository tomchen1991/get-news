import { Store } from '../store';
import { isNonNewsPage } from './source-policy';

/** Read-only projection: at most three accepted headlines per completed hourly search.
 * Wait for the whole batch to finish judging, so a late high score cannot be missed.
 * No model calls, prompts, search queries or private feedback are exposed here.
 */
export async function rollingUpdates(db: D1Database, now = Date.now()) {
  const store = new Store(db);
  const batches = await store.all<{ id: string; startedAt: number; pending: number; failed: number }>(`SELECT a.id,a.started_at AS startedAt,
    (SELECT count(*) FROM site_search_items i JOIN site_candidates c ON c.article_id=i.article_id AND c.topic_id=i.topic_id
      WHERE i.attempt_id=a.id AND c.status IN ('pending','evaluating')) AS pending,
    (SELECT count(*) FROM site_search_items i JOIN site_candidates c ON c.article_id=i.article_id AND c.topic_id=i.topic_id
      WHERE i.attempt_id=a.id AND c.status='failed') AS failed
    FROM site_attempts a WHERE a.kind='search' AND a.id LIKE 'hourly:%' AND a.status='completed' AND a.started_at>=?
    ORDER BY a.started_at DESC,a.id LIMIT 33`, now - 14 * 86400000);
  if (!batches.length) return { batches: [] };
  const rows = await store.all<{ attemptId: string; id: string; topicId: string; title: string; url: string }>(`WITH ranked AS (
    SELECT i.attempt_id AS attemptId,n.id,c.topic_id AS topicId,n.title,n.url,
      ROW_NUMBER() OVER(PARTITION BY i.attempt_id ORDER BY c.score DESC,n.published_at DESC,n.id) AS rank
    FROM site_search_items i JOIN site_candidates c ON c.article_id=i.article_id AND c.topic_id=i.topic_id
      JOIN site_news n ON n.id=i.article_id JOIN site_topics t ON t.id=c.topic_id
    WHERE i.attempt_id IN (${batches.map(() => '?').join(',')}) AND c.status='accepted' AND t.enabled=1
  ) SELECT attemptId,id,topicId,title,url FROM ranked ORDER BY attemptId,rank`, ...batches.map(b => b.id));
  return { batches: batches.map(batch => ({
    startedAt: new Date(batch.startedAt).toISOString(), pending: batch.pending > 0, hasErrors: batch.failed > 0,
    items: batch.pending ? [] : rows.filter(row => row.attemptId === batch.id && !isNonNewsPage(row.url)).slice(0, 3).map(({ attemptId: _, ...item }) => item),
  })) };
}
