import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { announceRelease, dispatchMessageCenter } from '../src/site/message-center';
import type { SiteEnv } from '../src/site/pipeline';

const now = Date.parse('2026-11-17T04:00:00Z');
const closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).forEach(close => close()); });
async function setup() {
  const { db, close } = createDatabase(); closes.push(close);
  const store = new Store(db);
  const env: SiteEnv = { DB: db, MESSAGE_CENTER_ENABLED: 'true', MESSAGE_CENTER_SINCE: '2026-11-17T00:00:00Z', MESSAGE_CENTER_PRODUCER_TOKEN: 'test-producer-token', NEWS_PUBLIC_URL: 'https://news.example.com' };
  async function article(id: string, score = .9, age = 0) {
    const attempt = 'hourly:2026-11-17:12';
    await store.run("INSERT OR IGNORE INTO site_attempts(id,kind,day,month,ref,status,started_at) VALUES(?,'search','2026-11-17','2026-11',?,'completed',?)", attempt, attempt, now);
    await store.run('INSERT INTO site_news(id,url,title,summary,published_at,discovered_at) VALUES(?,?,?,?,?,?)', id, `https://example.com/${id}`, `News ${id}`, 'PRIVATE', new Date(now - age).toISOString(), now);
    await store.run("INSERT INTO site_candidates(article_id,topic_id,status,score,evaluation_json,created_at) VALUES(?,'ai','accepted',?,?,?)", id, score * 100, JSON.stringify({ version: 2, worthReading: score }), now);
    await store.run("INSERT INTO site_search_items(attempt_id,article_id,topic_id) VALUES(?,?,'ai')", attempt, id);
  }
  async function digest(time = now) {
    await store.run("INSERT INTO site_digests(day,title,overview,stories_json,created_at,model,policy_version,profile_json,input_json,pending_count) VALUES('2026-11-17','日报','今日没有重要新闻','[]',?,'none',2,'PRIVATE','PRIVATE',0)", time);
  }
  return { env, store, article, digest };
}

describe('message center delivery (all HTTP mocked)', () => {
  it.each([201, 302])('announces each live version once (HTTP %i)', async code => {
    const {env,store} = await setup();
    const id = '12345678-1234-4000-8000-123456789abc'; env.WORKER_VERSION = {id};
    const fetcher = vi.fn(async (_url:RequestInfo | URL, init?:RequestInit) => {
      expect(await store.first('SELECT status FROM site_release_deliveries WHERE version_id=?',id)).toEqual({status:'reserved'});
      expect(JSON.parse(String(init?.body))).toMatchObject({externalId:`news-release:${id}`,type:'news.release'});
      expect(init?.redirect).toBe('manual'); return new Response(null,{status:code});
    });
    await Promise.all([announceRelease(env,fetcher),announceRelease(env,fetcher)]);
    await announceRelease(env,fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.first('SELECT status,http_status FROM site_release_deliveries')).toEqual({status:code===201?'accepted':'unknown',http_status:code});
  });
  it('reserves before HTTPS POST, sends even an empty digest, and deduplicates', async () => {
    const { env, store, article, digest } = await setup();
    await digest(); await article('high'); await article('boundary', .8); await article('low', .7);
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(init!.body as string);
      expect(await store.first('SELECT status FROM site_message_deliveries WHERE id=?', payload.externalId)).toEqual({ status: 'reserved' });
      expect(url).toBe('https://messages.falsita.cn/v1/messages');
      expect(init).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer test-producer-token' } });
      expect(JSON.stringify(payload)).not.toContain('PRIVATE');
      return new Response('{}', { status: 201 });
    });
    expect(await dispatchMessageCenter(env, { now, fetcher })).toBe(2);
    const payloads = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads[0]).toMatchObject({ type: 'news.daily-digest', body: '今日没有重要新闻', url: 'https://news.example.com/daily/2026-11-17' });
    expect(payloads[1]).toMatchObject({ type: 'news.worth-reading', metadata: { worthReading: .9 } });
    expect(await dispatchMessageCenter(env, { now, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses a strict configurable threshold without a daily news count limit', async () => {
    const { env, store, article, digest } = await setup();
    await digest();
    for (let i = 0; i < 8; i++) await article(`high-${i}`, .95);
    await article('boundary', .9);
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const configured = { ...env, PUSH_MIN_SCORE: '90' };
    expect(await dispatchMessageCenter(configured, { now, fetcher })).toBe(9);
    await article('later', .96);
    expect(await dispatchMessageCenter(configured, { now, fetcher })).toBe(1);
    expect(await dispatchMessageCenter(configured, { now, fetcher })).toBe(0);
    expect(await store.first("SELECT count(*) AS n FROM site_message_deliveries WHERE kind='news'")).toEqual({ n: 9 });
  });
  it.each(['timeout', '500', '409', '302'])('never automatically retries %s outcomes', async outcome => {
    const { env, store, digest } = await setup(); await digest();
    const fetcher = vi.fn(async () => { if (outcome === 'timeout') throw new Error('secret upstream body'); return new Response(null, { status: Number(outcome) }); });
    expect(await dispatchMessageCenter(env, { now, fetcher })).toBe(0);
    expect(await dispatchMessageCenter(env, { now: now + 600000, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.first('SELECT status,http_status FROM site_message_deliveries')).toEqual({ status: outcome === '409' ? 'rejected' : 'unknown', http_status: outcome === 'timeout' ? null : Number(outcome) });
  });
  it('atomically deduplicates concurrent dispatchers without dropping qualifying news', async () => {
    const { env, store, article, digest } = await setup();
    await digest(); await article('a'); await article('b');
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    await Promise.all([
      dispatchMessageCenter(env, { now, fetcher }),
      dispatchMessageCenter(env, { now, fetcher }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await store.first("SELECT count(*) AS n FROM site_message_deliveries WHERE kind='news'")).toEqual({ n: 2 });
  });
  it('does not resend crash-left reservations', async () => {
    const { env, store, digest } = await setup(); await digest();
    await store.run("INSERT INTO site_message_deliveries(id,recipient_id,kind,local_day,status,payload_json,reserved_at) VALUES('news-digest:v1:owner:2026-11-17','owner','digest','2026-11-17','reserved','{}',?)", now);
    const fetcher = vi.fn();
    expect(await dispatchMessageCenter(env, { now, fetcher })).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('is opt-in, validates secrets/targets/threshold and does not backfill or send stale news', async () => {
    const { env, article, digest } = await setup(); await digest(now - 86400000); await article('stale', .95, 86400001);
    const fetcher = vi.fn();
    expect(await dispatchMessageCenter({ ...env, MESSAGE_CENTER_ENABLED: undefined }, { now, fetcher })).toBe(0);
    for (const patch of [{ MESSAGE_CENTER_PRODUCER_TOKEN: undefined }, { MESSAGE_CENTER_URL: 'https://evil.example.com' }, { MESSAGE_CENTER_SINCE: '' }, { PUSH_MIN_SCORE: '' }, { PUSH_MIN_SCORE: 'NaN' }]) {
      await expect(dispatchMessageCenter({ ...env, ...patch }, { now, fetcher })).rejects.toThrow();
    }
    expect(await dispatchMessageCenter(env, { now, fetcher })).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
