import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { capturePushEvents } from '../src/site/push';

const now = Date.parse('2026-11-11T05:00:00Z');
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
async function setup() {
  const { db, close } = createDatabase(); closes.push(close);
  const store = new Store(db);
  const env = { DB: db, PUSH_EVENTS_ENABLED: 'true', PUSH_EVENTS_SINCE: '2026-11-11T00:00:00Z' };
  async function add(id: string, probability: number, attempt = 'hourly:2026-11-11:13', topic = 'ai') {
    await store.run("INSERT OR IGNORE INTO site_attempts(id,kind,day,month,ref,status,started_at) VALUES(?,'search','2026-11-11','2026-11',?,'completed',?)", attempt, attempt, now);
    await store.run('INSERT OR IGNORE INTO site_news(id,url,title,summary,published_at,discovered_at) VALUES(?,?,?,?,?,?)', id, `https://example.com/${id}`, `News ${id}`, 'Untrusted summary', new Date(now).toISOString(), now);
    await store.run("INSERT OR IGNORE INTO site_candidates(article_id,topic_id,status,score,evaluation_json,created_at,evaluated_at) VALUES(?,?,'accepted',?,?,?,?)", id, topic, probability * 100, JSON.stringify({ version: 2, worthReading: probability }), now, now);
    await store.run('INSERT OR IGNORE INTO site_search_items(attempt_id,article_id,topic_id) VALUES(?,?,?)', attempt, id, topic);
  }
  return { env, store, add };
}

describe('transport-neutral high-interest push events', () => {
  it('includes the exact 0.8 boundary and all qualifying articles, not just the top three', async () => {
    const { env, store, add } = await setup();
    for (const [id, score] of [['a', .8], ['b', .81], ['c', .9], ['d', 1], ['low', .79999]] as const) await add(id, score);
    expect(await capturePushEvents(env, now)).toBe(4);
    const rows = await store.all<{ payload_json: string }>('SELECT payload_json FROM site_push_events');
    const events = rows.map(row => JSON.parse(row.payload_json));
    expect(events.find(e => e.article.id === 'a')).toMatchObject({ version: 1, type: 'news.worth-reading', recipientId: 'owner', judgment: { version: 2, worthReading: .8 } });
    expect(events.every(e => !('summary' in e.article) && !('feedback' in e))).toBe(true);
  });
  it('deduplicates across runs, batches and topics, preserving the original snapshot', async () => {
    const { env, store, add } = await setup();
    await add('same', .9);
    await add('same', .95, 'hourly:2026-11-11:14', 'agent');
    expect(await capturePushEvents(env, now)).toBe(1);
    await store.run("UPDATE site_news SET title='changed'");
    expect(await capturePushEvents(env, now)).toBe(0);
    const row = await store.first<{ payload_json: string }>('SELECT payload_json FROM site_push_events');
    expect(JSON.parse(row!.payload_json).article.title).toBe('News same');
  });
  it('does not capture morning/manual searches, failed searches or legacy/invalid judgments', async () => {
    const { env, store, add } = await setup();
    await add('morning', .9, 'search:2026-11-11:morning');
    await add('manual', .9, 'manual:2026-11-11');
    await add('failed', .9, 'hourly:2026-11-11:12');
    await store.run("UPDATE site_attempts SET status='failed' WHERE id='hourly:2026-11-11:12'");
    for (const [id, evaluation] of [['legacy', '{"version":1,"worthReading":0.9}'], ['bad', '{'], ['null', 'null'], ['string', '{"version":2,"worthReading":"0.9"}'], ['overflow', '{"version":2,"worthReading":1.1}']]) {
      await add(id, .9);
      await store.run('UPDATE site_candidates SET evaluation_json=? WHERE article_id=?', evaluation, id);
    }
    expect(await capturePushEvents(env, now)).toBe(0);
  });
  it('picks up delayed judgments after their rolling search completes', async () => {
    const { env, store, add } = await setup();
    await add('delayed', .85);
    await store.run("UPDATE site_candidates SET status='pending'");
    expect(await capturePushEvents(env, now)).toBe(0);
    await store.run("UPDATE site_candidates SET status='accepted'");
    expect(await capturePushEvents(env, now + 600000)).toBe(1);
  });
  it('requires opt-in and an explicit activation instant, without historical backfill', async () => {
    const { env, add } = await setup(); await add('old', .9);
    expect(await capturePushEvents({ ...env, PUSH_EVENTS_ENABLED: undefined }, now)).toBe(0);
    await expect(capturePushEvents({ ...env, PUSH_EVENTS_SINCE: undefined }, now)).rejects.toThrow('activation');
    expect(await capturePushEvents({ ...env, PUSH_EVENTS_SINCE: new Date(now + 1).toISOString() }, now + 1000)).toBe(0);
  });
  it('rejects unsafe source links, oversized titles and disabled topics', async () => {
    const { env, store, add } = await setup();
    await add('unsafe', .9); await add('long', .9); await add('disabled', .9, 'hourly:2026-11-11:14', 'agent');
    await store.run("UPDATE site_news SET url='javascript:alert(1)' WHERE id='unsafe'");
    await store.run("UPDATE site_news SET title=? WHERE id='long'", 'x'.repeat(1001));
    await store.run("UPDATE site_topics SET enabled=0 WHERE id='agent'");
    expect(await capturePushEvents(env, now)).toBe(0);
  });
});
