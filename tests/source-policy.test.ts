import { afterEach, describe, expect, it } from 'vitest';
import { collectionSince, isNonNewsPage } from '../src/site/source-policy';
import { recoverMissedCandidates } from '../src/site/recover-candidates';
import { createDatabase } from './d1';
import { Store } from '../src/store';

const day = 86400000, now = Date.parse('2026-11-11T08:00:00Z');
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
describe('overlapping collection and narrow page exclusions', () => {
  it('overlaps recent searches and bounds missed-run coverage to fourteen days', () => {
    expect(collectionSince(now, 1, now - 3600000)).toBe(now - 2 * day);
    expect(collectionSince(now, 4, now - day)).toBe(now - 5 * day);
    expect(collectionSince(now, 1, now - 7 * day)).toBe(now - 7 * day);
    expect(collectionSince(now, 1, now - 30 * day)).toBe(now - 14 * day);
  });
  it('rejects IGN playlist pages, not genuine articles or unrelated sites', () => {
    expect(isNonNewsPage('https://www.ign.com/playlist/s90salvo/library')).toBe(true);
    expect(isNonNewsPage('https://ign.com/playlist')).toBe(true);
    expect(isNonNewsPage('https://www.ign.com/articles/new-game')).toBe(false);
    expect(isNonNewsPage('https://example.com/playlist/news')).toBe(false);
    expect(isNonNewsPage('https://notign.com/playlist/user')).toBe(false);
  });
  it('previews repair, archives the old baseline, and never requeues judged/failed/old/undated/non-news URLs', async () => {
    const { db, close } = createDatabase(); closes.push(close); const store = new Store(db);
    for (const [id, status, date, url] of [
      ['missed', 'baseline', new Date(now - day).toISOString(), 'https://example.com/missed'],
      ['judged', 'accepted', new Date(now - day).toISOString(), 'https://example.com/judged'],
      ['failed', 'failed', new Date(now - day).toISOString(), 'https://example.com/failed'],
      ['old', 'baseline', new Date(now - 3 * day).toISOString(), 'https://example.com/old'],
      ['undated', 'baseline', null, 'https://example.com/undated'],
      ['library', 'baseline', new Date(now - day).toISOString(), 'https://www.ign.com/playlist/user/library'],
    ]) {
      await store.run('INSERT INTO site_news(id,url,title,summary,published_at,discovered_at) VALUES(?,?,?,?,?,?)', id, url, 'News', 'Summary', date, now - day);
      await store.run("INSERT INTO site_candidates(article_id,topic_id,status,created_at) VALUES(?,'ai',?,?)", id, status, now - day);
    }
    const options = { now, authorization: 'overlap-repair-01' };
    const preview = await recoverMissedCandidates(db, options);
    expect(preview.applied).toBe(false);
    expect(preview.candidates.map(c => c.articleId)).toEqual(['missed']);
    expect(await store.first("SELECT status FROM site_candidates WHERE article_id='missed'")).toEqual({ status: 'baseline' });
    await recoverMissedCandidates(db, { ...options, apply: true });
    expect(await store.first("SELECT status FROM site_candidates WHERE article_id='missed'")).toEqual({ status: 'pending' });
    expect(await store.first('SELECT count(*) AS n FROM site_judgment_history')).toEqual({ n: 1 });
    expect((await recoverMissedCandidates(db, { ...options, apply: true })).candidates).toEqual([]);
    expect(await store.first('SELECT count(*) AS n FROM site_attempts')).toEqual({ n: 0 });
    expect(await store.first('SELECT count(*) AS n FROM site_search_items')).toEqual({ n: 0 });
  });
});
