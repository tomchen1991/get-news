import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { dispatchManualIssue, runManualIssue } from '../src/site/manual';
import { runNewsSite, type SiteEnv } from '../src/site/pipeline';
import { generateDailyDigest, publicDigest } from '../src/site/digest';
import type { NewsItem } from '../src/types';

const now = Date.parse('2026-11-11T03:40:00Z'); // 11:40 Shanghai, outside the morning and digest windows
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
async function setup() {
  const database = createDatabase(); databases.push(database);
  const store = new Store(database.db);
  await store.run("UPDATE site_topics SET enabled=0");
  await store.run("UPDATE site_topics SET enabled=1,queries_json='[\"one query\"]' WHERE id='ai'");
  const env: SiteEnv = { DB: database.db, SEARCH_ENABLED: 'true', JEV_ENABLED: 'true', DIGEST_ENABLED: 'true', DIGEST_MODEL: 'openai/offline', AI_GATEWAY_ID: 'news' };
  const item = (id: string, time = now - 3600000): NewsItem => ({ externalId: id, title: 'Concrete release', summary: 'Official evidence', url: `https://news.example.com/${id}`, publishedAt: new Date(time).toISOString() });
  const search = { search: vi.fn(async () => ({ items: [item('today'), item('yesterday', now - 12 * 3600000), item('future', now + 6 * 60000)], credits: 1 })) };
  const evaluator = { evaluate: vi.fn(async () => ({ worthReading: 0.9 })) };
  const chat = { complete: vi.fn(async (_system: string, data: any) => JSON.stringify({ title: '今日简报', overview: '新'.repeat(220), stories: [{ title: '发布', articleIds: [data.articles[0].id] }] })) };
  return { env, store, search, evaluator, chat, item };
}
describe('authorized operator-only first issue', () => {
  it('dispatches a configured day only once and then resumes ordinary Cron', async () => {
    const { env, search, evaluator, chat, store } = await setup();
    const configured = { ...env, MANUAL_ISSUE_DAY: '2026-11-11' };
    const deps = { search, evaluator, chat, now: () => now };
    expect(await dispatchManualIssue(env, deps)).toBe(false);
    expect(search.search).not.toHaveBeenCalled();
    expect(await dispatchManualIssue(configured, deps)).toBe(true);
    expect(await store.first('SELECT status,result FROM site_manual_authorizations')).toEqual({ status: 'completed', result: 'published' });
    expect(await dispatchManualIssue(configured, deps)).toBe(false);
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });
  it('does not retry an interrupted or failed dispatch', async () => {
    const { env, search, evaluator, chat, store } = await setup();
    const configured = { ...env, MANUAL_ISSUE_DAY: '2026-11-11' };
    const deps = { search, evaluator, chat, now: () => now };
    await store.run("INSERT INTO site_manual_authorizations(day,authorization_id,status,started_at) VALUES('2026-11-11','initial','running',?)", now);
    expect(await dispatchManualIssue(configured, deps)).toBe(true);
    expect(search.search).not.toHaveBeenCalled();
    await store.run("UPDATE site_manual_authorizations SET status='failed'");
    expect(await dispatchManualIssue(configured, deps)).toBe(false);
    expect(search.search).not.toHaveBeenCalled();
    expect(await dispatchManualIssue({ ...configured, MANUAL_ISSUE_DAY: '2026-11-10' }, deps)).toBe(false);
  });
  it('allows a new explicit authorization without deleting or resetting the original failed audit', async () => {
    const { env, search, evaluator, chat, store } = await setup();
    await store.run("INSERT INTO site_manual_authorizations(day,authorization_id,status,started_at) VALUES('2026-11-11','initial','failed',?)", now - 1000);
    const configured = { ...env, MANUAL_ISSUE_DAY: '2026-11-11', MANUAL_ISSUE_AUTHORIZATION: 'operator-resume-01' };
    const deps = { search, evaluator, chat, now: () => now };
    expect(await dispatchManualIssue(configured, deps)).toBe(true);
    expect(await store.all('SELECT authorization_id,status FROM site_manual_authorizations ORDER BY authorization_id')).toEqual([
      { authorization_id: 'initial', status: 'failed' }, { authorization_id: 'operator-resume-01', status: 'completed' },
    ]);
    expect(await dispatchManualIssue(configured, deps)).toBe(false);
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });
  it('collects only dated current-day first-query results outside the window, then publishes once', async () => {
    const { env, store, search, evaluator, chat } = await setup();
    const deps = { search, evaluator, chat, now: () => now };
    expect(await runManualIssue(env, '2026-11-11', deps)).toBe('published');
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(search.search.mock.calls[0]).toEqual([{ query: 'one query', maxResults: 10, startDate: '2026-11-11' }]);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1); expect(chat.complete).toHaveBeenCalledTimes(1);
    expect((await publicDigest(env.DB, '2026-11-11'))?.overview).toHaveLength(220);
    expect(await store.first("SELECT count(*) AS n FROM site_attempts WHERE kind='search'")).toEqual({ n: 1 });
    await expect(runManualIssue(env, '2026-11-11', deps)).rejects.toThrow('refusing to retry');
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });
  it('sends even a low valid Noul probability to the daily editor without a score threshold', async () => {
    const { env, store, search, evaluator, chat } = await setup();
    evaluator.evaluate.mockResolvedValue({ worthReading: 0.01 });
    expect(await runManualIssue(env, '2026-11-11', { search, evaluator, chat, now: () => now })).toBe('published');
    const input = chat.complete.mock.calls[0][1];
    expect(input.articles).toHaveLength(1); expect(input.articles[0].score).toBe(1);
    const row = await store.first<any>("SELECT status,evaluation_json FROM site_candidates WHERE status='accepted'");
    expect(JSON.parse(row.evaluation_json)).toMatchObject({ version: 2, worthReading: 0.01 });
  });
  it('can recover a legacy current-day baseline without another search', async () => {
    const { env, store, search, evaluator, chat, item } = await setup();
    const morning = now - 3 * 3600000;
    search.search.mockResolvedValue({ items: [item('morning', morning - 3600000)], credits: 1 });
    await runNewsSite({ ...env, JEV_ENABLED: 'false' }, { search, evaluator, now: () => morning });
    // Simulate a baseline saved by the previous collector policy.
    await store.run("UPDATE site_candidates SET status='baseline'");
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(await store.first('SELECT status FROM site_candidates')).toEqual({ status: 'baseline' });
    expect(await runManualIssue(env, '2026-11-11', { search, evaluator, chat, now: () => now })).toBe('published');
    expect(search.search).toHaveBeenCalledTimes(1); expect(evaluator.evaluate).toHaveBeenCalledTimes(1);
  });
  it('does not alter ordinary Cron or digest time windows', async () => {
    const { env, search, evaluator, chat } = await setup();
    await runNewsSite(env, { search, evaluator, now: () => now });
    expect(search.search).not.toHaveBeenCalled();
    expect(await generateDailyDigest(env, { chat, now: () => now })).toBe('outside_window');
    expect(chat.complete).not.toHaveBeenCalled();
    await expect(generateDailyDigest(env, { chat, now: () => now, manualDay: '2026-11-10' })).rejects.toThrow('current local day');
  });
  it('stops after a judge error without retrying the failed judgment or generating an issue', async () => {
    const { env, search, evaluator, chat, store } = await setup();
    evaluator.evaluate.mockRejectedValue(new Error('offline error'));
    await expect(runManualIssue(env, '2026-11-11', { search, evaluator, chat, now: () => now })).rejects.toThrow('stopping without retry');
    expect(evaluator.evaluate).toHaveBeenCalledTimes(1); expect(chat.complete).not.toHaveBeenCalled();
    expect(await store.first("SELECT status FROM site_attempts WHERE kind='jev'")).toEqual({ status: 'failed' });
  });
  it('refuses a premature digest when the search budget cannot complete the plan', async () => {
    const { env, search, evaluator, chat } = await setup();
    await expect(runManualIssue({ ...env, TAVILY_DAILY_CREDITS: '0' }, '2026-11-11', { search, evaluator, chat, now: () => now })).rejects.toThrow('search plan is incomplete');
    expect(search.search).not.toHaveBeenCalled(); expect(chat.complete).not.toHaveBeenCalled();
  });
  it('does not bypass the judgment budget, disabled switches or current-date guard', async () => {
    const { env, search, evaluator, chat } = await setup(); const deps = { search, evaluator, chat, now: () => now };
    await expect(runManualIssue(env, '2026-11-10', deps)).rejects.toThrow('current local date');
    await expect(runManualIssue({ ...env, JEV_ENABLED: 'false' }, '2026-11-11', deps)).rejects.toThrow('explicitly enabled');
    await expect(runManualIssue({ ...env, JEV_DAILY_REQUESTS: '0' }, '2026-11-11', deps)).rejects.toThrow('Unfinished candidates');
    expect(evaluator.evaluate).not.toHaveBeenCalled(); expect(chat.complete).not.toHaveBeenCalled();
  });
});
