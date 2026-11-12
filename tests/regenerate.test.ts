import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { generateDailyDigest, publicDigest } from '../src/site/digest';
import { regenerateEmptyIssue } from '../src/site/regenerate';
import { dispatchManualIssue } from '../src/site/manual';
import type { SiteEnv } from '../src/site/pipeline';

const now = Date.parse('2026-11-11T05:10:00Z'), day = '2026-11-11';
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); });
async function setup(count = 12) {
  const database = createDatabase(); databases.push(database); const store = new Store(database.db);
  const env: SiteEnv = { DB: database.db, SEARCH_ENABLED: 'true', JEV_ENABLED: 'true', DIGEST_ENABLED: 'true', DIGEST_MODEL: 'deepseek/offline', AI_GATEWAY_ID: 'news' };
  const chat = { complete: vi.fn(async (_system: string, input: any) => JSON.stringify({ title: '新版日报', overview: '新'.repeat(220), stories: [{ title: '报道', articleIds: input.articles.slice(0, 2).map((s: any) => s.id) }] })) };
  await generateDailyDigest(env, { chat, now: () => now - 1000, manualDay: day }); // existing free empty issue
  for (let i = 0; i < count; i++) {
    const id = i.toString(16).padStart(64, '0'), status = i === 0 ? 'failed' : 'rejected';
    await store.run('INSERT INTO site_news(id,url,title,summary,published_at,discovered_at) VALUES(?,?,?,?,?,?)', id, `https://example.com/${i}`, String(i), 'Evidence', new Date(now - 3600000).toISOString(), now - 2000);
    await store.run("INSERT INTO site_candidates(article_id,topic_id,status,score,evaluation_json,created_at,evaluated_at) VALUES(?,'ai',?,32,?,?,?)", id, status, JSON.stringify({ version: 1, relevance: 0.3 }), now - 2000, now - 1500);
    await store.run("INSERT INTO site_attempts(id,kind,day,month,ref,status,started_at) VALUES(?,'jev',?,'2026-11',?,?,?)", `jev:${id}:ai`, day, `${id}:ai`, i === 0 ? 'failed' : 'completed', now - 2000);
  }
  const evaluator = { evaluate: vi.fn(async (item: { title: string }) => ({ worthReading: 0.01 + Number(item.title) * 0.01 })) };
  return { env, store, chat, evaluator };
}
describe('explicit current-day Noul policy regeneration', () => {
  it('rejudges saved news, retains history, sends global top ten despite low probabilities, and atomically replaces only an empty issue', async () => {
    const { env, store, chat, evaluator } = await setup();
    const previous = await publicDigest(env.DB, day);
    const configured = { ...env, MANUAL_ISSUE_DAY: day, MANUAL_ISSUE_AUTHORIZATION: 'v2-01', MANUAL_ISSUE_REGENERATE: 'true' };
    expect(await dispatchManualIssue(configured, { chat, evaluator, now: () => now })).toBe(true);
    expect(evaluator.evaluate).toHaveBeenCalledTimes(12); expect(chat.complete).toHaveBeenCalledTimes(1);
    expect((chat.complete.mock.calls[0][1] as any).articles.map((s: any) => s.title)).toEqual(['11','10','9','8','7','6','5','4','3','2']);
    expect(await store.first("SELECT count(*) AS n FROM site_attempts WHERE kind='search'")).toEqual({ n: 0 });
    expect(await store.first("SELECT count(*) AS n FROM site_attempts WHERE id LIKE 'jev:v2:%'")).toEqual({ n: 12 });
    expect(await store.first("SELECT status FROM site_attempts WHERE id=?", `jev:${'0'.repeat(64)}:ai`)).toEqual({ status: 'failed' });
    expect(await store.first('SELECT count(*) AS n FROM site_judgment_history')).toEqual({ n: 12 });
    const revision = await store.first<{ snapshot_json: string }>('SELECT snapshot_json FROM site_digest_revisions');
    expect(JSON.parse(revision!.snapshot_json).digest.overview).toBe(previous!.overview);
    expect((await publicDigest(env.DB, day))?.overview).toHaveLength(220);
    expect(await store.first('SELECT status FROM site_digest_regenerations')).toEqual({ status: 'published' });
    expect(await dispatchManualIssue(configured, { chat, evaluator, now: () => now })).toBe(false);
    expect(chat.complete).toHaveBeenCalledTimes(1);
    expect(await store.first("SELECT model FROM site_digest_attempts WHERE day=?", day)).toEqual({ model: 'none' }); // old audit intact
  });
  it('can regenerate only the summary from existing v2 judgments without invoking Jev or touching pending news', async () => {
    const { env, store, chat, evaluator } = await setup(3);
    await store.run("UPDATE site_candidates SET status='accepted',score=78,evaluation_json=?", JSON.stringify({ version: 2, worthReading: 0.78 }));
    await store.run("UPDATE site_candidates SET status='pending' WHERE article_id=?", '2'.padStart(64, '0'));
    const configured = { ...env, MANUAL_ISSUE_DAY: day, MANUAL_ISSUE_AUTHORIZATION: 'summary-only-01', MANUAL_ISSUE_REGENERATE: 'true', MANUAL_ISSUE_REUSE_JUDGMENTS: 'true' };
    expect(await dispatchManualIssue(configured, { chat, evaluator, now: () => now })).toBe(true);
    expect(evaluator.evaluate).not.toHaveBeenCalled(); expect(chat.complete).toHaveBeenCalledTimes(1);
    expect((chat.complete.mock.calls[0][1] as any).articles).toHaveLength(2);
    expect((await publicDigest(env.DB, day))?.hasPending).toBe(true);
    expect(await store.first('SELECT count(*) AS n FROM site_judgment_history')).toEqual({ n: 0 });
    expect(await store.first("SELECT count(*) AS n FROM site_attempts WHERE kind='search' OR id LIKE 'jev:v2:%'")).toEqual({ n: 0 });
  });
  it('publishes a saved near-boundary draft with a provenance notice, without any provider call or extra model budget', async () => {
    const { env, store, chat, evaluator } = await setup(1);
    await store.run("UPDATE site_candidates SET status='accepted',score=78,evaluation_json=?", JSON.stringify({ version: 2, worthReading: 0.78 }));
    const output = JSON.stringify({ title: '已保存的模型草稿', overview: '新'.repeat(195), stories: [{ title: '报道', articleIds: ['0'.repeat(64)] }] });
    await store.run("INSERT INTO site_digest_regenerations(day,authorization_id,month,status,started_at,model,diagnostic_json) VALUES(?,'saved','2026-11','failed',?,?,?)", day, now - 1000, env.DIGEST_MODEL, JSON.stringify({ error: { message: 'Invalid digest' }, output }));
    const configured = { ...env, DIGEST_MONTHLY_REQUESTS: '0', MANUAL_ISSUE_REUSE_JUDGMENTS: 'true', MANUAL_ISSUE_REPLAY_DRAFT_FROM: 'saved' };
    expect(await regenerateEmptyIssue(configured, day, 'saved-publish-01', { chat, evaluator, now: () => now })).toBe('published');
    expect(chat.complete).not.toHaveBeenCalled(); expect(evaluator.evaluate).not.toHaveBeenCalled();
    const issue = await publicDigest(env.DB, day);
    expect(issue?.overview).toContain('以上仅据摘要整理，请核对原文。');
    expect(issue!.overview.replace(/\s/gu, '').length).toBeGreaterThanOrEqual(200);
    expect(await store.first("SELECT model,status FROM site_digest_regenerations WHERE authorization_id='saved'")).toEqual({ model: env.DIGEST_MODEL, status: 'failed' });
    const replay = await store.first<any>("SELECT model,status,diagnostic_json FROM site_digest_regenerations WHERE authorization_id='saved-publish-01'");
    expect(replay).toMatchObject({ model: 'none', status: 'published' });
    expect(JSON.parse(replay.diagnostic_json)).toMatchObject({ providerCall: false, editorialNoticeAdded: true, replayedFrom: 'saved' });
  });
  it('retains the existing issue when new model output is invalid and never retries its reservation', async () => {
    const { env, store, chat, evaluator } = await setup(1); const previous = await publicDigest(env.DB, day);
    chat.complete.mockResolvedValue('invalid JSON'); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await regenerateEmptyIssue(env, day, 'v2-01', { chat, evaluator, now: () => now })).toBe('failed');
    expect(await publicDigest(env.DB, day)).toEqual(previous);
    expect(await store.first('SELECT count(*) AS n FROM site_digest_revisions')).toEqual({ n: 0 });
    expect((await store.first<any>('SELECT diagnostic_json FROM site_digest_regenerations')).diagnostic_json).toContain('invalid JSON');
    await expect(regenerateEmptyIssue(env, day, 'v2-01', { chat, evaluator, now: () => now })).rejects.toThrow('already reserved');
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });
  it('checks monthly budget before rejudging and counts failed regenerations against ordinary daily generation', async () => {
    const { env, store, chat, evaluator } = await setup(1);
    await expect(regenerateEmptyIssue({ ...env, DIGEST_MONTHLY_REQUESTS: '0' }, day, 'v2-01', { chat, evaluator, now: () => now })).rejects.toThrow('budget exhausted');
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    await store.run("INSERT INTO site_digest_regenerations(day,authorization_id,month,status,started_at,model) VALUES(?,'older','2026-11','failed',?,'deepseek/offline')", day, now);
    await expect(regenerateEmptyIssue({ ...env, DIGEST_MONTHLY_REQUESTS: '1' }, day, 'v2-01', { chat, evaluator, now: () => now })).rejects.toThrow('budget exhausted');
    expect(chat.complete).not.toHaveBeenCalled();
  });
  it('rejects historical dates and refuses to overwrite an already model-generated issue', async () => {
    const { env, store, chat, evaluator } = await setup(1); const deps = { chat, evaluator, now: () => now };
    await expect(regenerateEmptyIssue(env, '2026-11-10', 'v2-01', deps)).rejects.toThrow('current-day');
    await store.run("UPDATE site_digests SET model='deepseek/offline'");
    await expect(regenerateEmptyIssue(env, day, 'v2-01', deps)).rejects.toThrow('model-free empty');
    expect(evaluator.evaluate).not.toHaveBeenCalled(); expect(chat.complete).not.toHaveBeenCalled();
  });
});
