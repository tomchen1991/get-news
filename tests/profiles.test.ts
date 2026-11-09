import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createDatabase } from './d1';
import { defaultPreferences, listProfileHistory, mutateProfile, readProfile, undoProfile } from '../src/profiles';

const actor = { kind: 'agent' as const, id: 'profile-agent', userId: 'alice' };
const change = (operations: unknown[], expectedRevision = 0, changeId = 'change-1') => ({ expectedRevision, changeId, reason: 'User requested this', evidence: 'message-42: prefer AI news', operations });
let db: D1Database;
let close: () => void;
async function seed(id = 'alice') { await db.prepare(`INSERT INTO users(id,name,interests_json) VALUES(?,?,?)`).bind(id, id, '["AI"]').run(); }
beforeEach(async () => { ({ db, close } = createDatabase()); await seed(); });
afterEach(() => close());

describe('profile domain', () => {
 it('preserves legacy defaults with migration, including populated databases', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
   sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
   sqlite.exec(`INSERT INTO users(id,name,interests_json,min_score) VALUES('legacy','Legacy','["AI"]',81)`);
   sqlite.exec(readFileSync(new URL('../migrations/0002_profiles.sql', import.meta.url), 'utf8'));
   const row = sqlite.prepare('SELECT * FROM users').get()!;
   expect(row.min_score).toBe(81); expect(row.profile_revision).toBe(0);
   expect(JSON.parse(String(row.preferences_json))).toEqual(defaultPreferences());
  } finally { sqlite.close(); }
 });
 it('separates inferred hints from explicit policy and audits settings atomically', async () => {
  const result = await mutateProfile(db, 'alice', change([
   { op: 'set_topic', topic: 'AI', mode: 'exclude' },
   { op: 'set_inferred_topic', topic: 'AI', weight: .2, evidence: 'article liked' },
   { op: 'set_settings', settings: { name: 'Alice', cooldownMinutes: 120, dailyLimit: 2 } },
   { op: 'set_interests', interests: ['AI', 'Science'], excludedTopics: ['Sports'] }
  ]), actor);
  expect(result.profile.revision).toBe(1); expect(result.profile.name).toBe('Alice');
  expect(result.profile.preferences?.topics).toEqual([{ topic: 'ai', mode: 'exclude' }]);
  expect(result.profile.preferences?.inferredTopics[0].weight).toBe(.2);
  expect(await readProfile(db, 'alice')).toEqual(result.profile);
  const history = await listProfileHistory(db, 'alice');
  expect(history).toHaveLength(1); expect(history[0].before.revision).toBe(0); expect(history[0].after).toEqual(result.profile);
  await expect(db.prepare(`DELETE FROM profile_changes`).run()).rejects.toThrow('immutable_profile_history');
  await expect(db.prepare(`UPDATE profile_changes SET reason='changed'`).run()).rejects.toThrow('immutable_profile_history');
 });
 it('has exact idempotency and revision conflicts, without extra history', async () => {
  const body = change([{ op: 'set_delivery', delivery: 'digest' }]);
  await mutateProfile(db, 'alice', body, actor);
  expect((await mutateProfile(db, 'alice', body, actor)).replayed).toBe(true);
  await expect(mutateProfile(db, 'alice', { ...body, reason: 'different' }, actor)).rejects.toMatchObject({ code: 'change_id_conflict', status: 409 });
  await expect(mutateProfile(db, 'alice', change([{ op: 'set_delivery', delivery: 'paused' }], 0, 'stale'), actor)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await listProfileHistory(db, 'alice')).toHaveLength(1);
 });
 it('only undoes latest change and preserves append-only history', async () => {
  await mutateProfile(db, 'alice', change([{ op: 'set_settings', settings: { name: 'Renamed' } }]), actor);
  await mutateProfile(db, 'alice', change([{ op: 'set_delivery', delivery: 'paused' }], 1, 'change-2'), actor);
  const undo = { expectedRevision: 2, changeId: 'undo-1', targetChangeId: 'change-1', reason: 'Undo', evidence: 'User said undo' };
  await expect(undoProfile(db, 'alice', undo, actor)).rejects.toMatchObject({ code: 'undo_not_latest' });
  undo.targetChangeId = 'change-2';
  const result = await undoProfile(db, 'alice', undo, actor);
  expect(result.profile.preferences?.delivery).toBe('alert'); expect(result.profile.revision).toBe(3);
  expect((await undoProfile(db, 'alice', undo, actor)).replayed).toBe(true);
  expect(await listProfileHistory(db, 'alice')).toHaveLength(3);
 });
 it('isolates users and checks source registry rather than accepting fetch targets', async () => {
  await seed('bob');
  await expect(mutateProfile(db, 'bob', change([{ op: 'set_delivery', delivery: 'paused' }]), actor)).rejects.toMatchObject({ status: 403 });
  await expect(mutateProfile(db, 'alice', change([{ op: 'set_source', sourceId: 'unknown', mode: 'prefer' }]), actor)).rejects.toMatchObject({ code: 'source_not_found' });
  await db.prepare(`INSERT INTO sources(id,name,kind,url) VALUES('trusted','Trusted','rss','https://example.com/rss')`).run();
  await mutateProfile(db, 'alice', change([{ op: 'set_source', sourceId: 'trusted', mode: 'prefer' }]), actor);
  expect(await listProfileHistory(db, 'bob')).toEqual([]);
  await expect(undoProfile(db, 'bob', { expectedRevision: 0, changeId: 'u', targetChangeId: 'change-1', reason: 'Undo', evidence: 'User' }, { ...actor, userId: 'bob' })).rejects.toMatchObject({ code: 'change_not_found' });
 });
 it.each([
  [{ op: 'set_topic', topic: 'AI', mode: 'prefer', arbitrary: true }],
  [{ op: 'set_inferred_topic', topic: 'AI', weight: -.5, evidence: 'downvote' }],
  [{ op: 'set_settings', settings: { dailyLimit: 999 } }],
  [{ op: 'set_settings', settings: { cooldownMinutes: -1 } }],
  [{ op: 'set_settings', settings: { apiKey: 'secret' } }],
  [{ op: 'set_interests', interests: [], excludedTopics: [] }],
  [{ op: 'set_source', sourceId: 'https://evil.test/', mode: 'prefer' }],
 ])('rejects malformed or unbounded operations %j', async (operation) => {
  await expect(mutateProfile(db, 'alice', change([operation]), actor)).rejects.toMatchObject({ status: 400 });
  expect((await readProfile(db, 'alice'))?.revision).toBe(0);
 });
 it('rejects missing evidence and unknown envelope keys', async () => {
  const body = change([{ op: 'set_delivery', delivery: 'paused' }]);
  await expect(mutateProfile(db, 'alice', { ...body, evidence: '' }, actor)).rejects.toMatchObject({ status: 400 });
  await expect(mutateProfile(db, 'alice', { ...body, surprise: true }, actor)).rejects.toMatchObject({ status: 400 });
 });
 it('losing compare-and-swap neither audits nor suppresses pending messages', async () => {
  await db.prepare(`INSERT INTO sources(id,name,kind,url) VALUES('s','s','rss','https://example.com/rss')`).run();
  await db.prepare(`INSERT INTO articles(id,source_id,external_id,url,title,summary,discovered_at,eligible) VALUES('a','s','a','https://example.com/a','a','a',0,1)`).run();
  await db.prepare(`INSERT INTO judgments(id,article_id,user_id,created_at,updated_at) VALUES('j','a','alice',0,0)`).run();
  await db.prepare(`INSERT INTO outbox(id,judgment_id,user_id,payload_json,created_at) VALUES('o','j','alice','{}',0)`).run();
  const racing = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
   // Simulate a competing writer between the read and transaction.
   await db.prepare('UPDATE users SET profile_revision=1 WHERE id=?').bind('alice').run();
   return db.batch(statements);
  }} as D1Database;
  await expect(mutateProfile(racing, 'alice', change([{ op: 'set_delivery', delivery: 'paused' }]), actor)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await listProfileHistory(db, 'alice')).toEqual([]);
  expect(await db.prepare('SELECT status FROM outbox').first('status')).toBe('pending');
  await mutateProfile(db, 'alice', change([{ op: 'set_delivery', delivery: 'paused' }], 1), actor);
  expect(await db.prepare('SELECT status FROM outbox').first('status')).toBe('suppressed');
 });
 it('rolls back profile changes when audit insertion fails', async () => {
  await db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON profile_changes BEGIN SELECT RAISE(ABORT,'test_abort'); END;`);
  await expect(mutateProfile(db, 'alice', change([{ op: 'set_delivery', delivery: 'paused' }]), actor)).rejects.toThrow('test_abort');
  expect((await readProfile(db, 'alice'))?.revision).toBe(0);
  expect(await listProfileHistory(db, 'alice')).toEqual([]);
 });
});
