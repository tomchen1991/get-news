import { Store } from '../store';
import { collectionSince, isNonNewsPage } from './source-policy';

/** Operator-only repair, no search/model/network calls. Preview by default.
 * Requeues never-judged baseline rows; old judgments and historical batches stay intact.
 * Applying permits future normal Cron judging under the existing paid budgets.
 */
export async function recoverMissedCandidates(db: D1Database, options: { now: number; authorization: string; apply?: boolean }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.authorization) || !Number.isFinite(options.now)) throw new Error('Invalid recovery authorization');
  const store = new Store(db);
  const rows = await store.all<{ article_id: string; topic_id: string; created_at: number; url: string; published_at: string; gap_days: number }>(`SELECT c.article_id,c.topic_id,c.created_at,n.url,n.published_at,t.gap_days
    FROM site_candidates c JOIN site_news n ON n.id=c.article_id JOIN site_topics t ON t.id=c.topic_id
    WHERE c.status='baseline' AND t.enabled=1 AND n.published_at>=? AND n.published_at<=?
      AND c.evaluation_json IS NULL AND c.evaluated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM site_candidates other WHERE other.article_id=c.article_id AND other.status!='baseline')
      AND NOT EXISTS (SELECT 1 FROM site_attempts a WHERE a.kind='jev' AND a.ref LIKE c.article_id || ':%')
    ORDER BY n.published_at DESC,c.article_id,c.topic_id LIMIT 500`, new Date(options.now - 14 * 86400000).toISOString(), new Date(options.now + 5 * 60000).toISOString());
  const seen = new Set<string>();
  const candidates = rows.filter(row => {
    if (seen.has(row.article_id) || isNonNewsPage(row.url) || Date.parse(row.published_at) < collectionSince(options.now, row.gap_days)) return false;
    seen.add(row.article_id); return true;
  });
  if (options.apply) {
    for (const row of candidates) {
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO site_judgment_history(authorization_id,article_id,topic_id,snapshot_json,archived_at)
          SELECT ?,article_id,topic_id,?,? FROM site_candidates WHERE article_id=? AND topic_id=? AND status='baseline' AND created_at=?`)
          .bind(options.authorization, JSON.stringify({ ...row, status: 'baseline', reason: 'overlapping-search-window-repair' }), options.now, row.article_id, row.topic_id, row.created_at),
        db.prepare(`UPDATE site_candidates SET status='pending',created_at=? WHERE article_id=? AND topic_id=? AND status='baseline' AND created_at=?
          AND evaluation_json IS NULL AND evaluated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM site_attempts a WHERE a.kind='jev' AND a.ref LIKE site_candidates.article_id || ':%')
          AND NOT EXISTS (SELECT 1 FROM site_candidates other WHERE other.article_id=site_candidates.article_id AND other.status!='baseline')`)
          .bind(options.now, row.article_id, row.topic_id, row.created_at),
      ]);
    }
  }
  return { applied: options.apply === true, candidates: candidates.map(row => ({ articleId: row.article_id, topicId: row.topic_id, url: row.url })) };
}
