import { parseProfile } from './config';
import type { UserProfile } from './types';

export type PreferenceMode = 'prefer' | 'less' | 'exclude' | 'digest';
export interface ProfilePreferences {
 topics: { topic: string; mode: PreferenceMode }[];
 sources: { sourceId: string; mode: PreferenceMode }[];
 /** Bounded, reversible hints only. They never change explicit rules or delivery policy. */
 inferredTopics: { topic: string; weight: number; evidence: string }[];
 delivery: 'alert' | 'digest' | 'paused';
 cooldownMinutes: number;
}
export interface ProfileActor { kind: 'admin' | 'agent'; id: string; userId?: string }
export class ProfileError extends Error {
 constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function defaultPreferences(): ProfilePreferences {
 return { topics: [], sources: [], inferredTopics: [], delivery: 'alert', cooldownMinutes: 0 };
}
function fail(code = 'invalid_profile_change', status = 400): never { throw new ProfileError(code, status); }
function record(v: unknown): Record<string, unknown> {
 if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
 return v as Record<string, unknown>;
}
function exact(v: Record<string, unknown>, required: string[], optional: string[] = []): void {
 if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail();
}
function text(v: unknown, max: number): string {
 if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return fail();
 return v.trim();
}
function identifier(v: unknown): string {
 if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v)) return fail();
 return v;
}
function revision(v: unknown): number {
 if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v >= Number.MAX_SAFE_INTEGER) return fail();
 return v;
}
function mode(v: unknown): PreferenceMode {
 if (!['prefer', 'less', 'exclude', 'digest'].includes(String(v)) || typeof v !== 'string') return fail();
 return v as PreferenceMode;
}
function delivery(v: unknown): ProfilePreferences['delivery'] {
 if (v !== 'alert' && v !== 'digest' && v !== 'paused') return fail();
 return v;
}
function normalizeTopic(v: unknown): string { return text(v, 300).normalize('NFKC').toLowerCase(); }
function scoped(actor: ProfileActor, userId: string): void {
 identifier(userId); identifier(actor.id);
 if (actor.kind !== 'admin' && actor.kind !== 'agent') fail('forbidden', 403);
 if (actor.kind === 'agent' && actor.userId !== userId) fail('forbidden', 403);
}

/** Shared row decoder for pipeline and APIs; caller must not bypass revisioned writes. */
export function profileFromRow(r: Record<string, unknown>): UserProfile {
 return { id: String(r.id), name: String(r.name), interests: JSON.parse(String(r.interests_json)), excludedTopics: JSON.parse(String(r.excluded_topics_json)),
  minScore: Number(r.min_score), minConfidence: Number(r.min_confidence), dailyLimit: Number(r.daily_limit), timezone: String(r.timezone),
  quietStart: Number(r.quiet_start), quietEnd: Number(r.quiet_end), enabled: !!r.enabled,
  revision: Number(r.profile_revision ?? 0), preferences: r.preferences_json ? JSON.parse(String(r.preferences_json)) : defaultPreferences() };
}
export async function readProfile(db: D1Database, userId: string): Promise<UserProfile | null> {
 identifier(userId);
 const row = await db.prepare('SELECT * FROM users WHERE id=?').bind(userId).first<Record<string, unknown>>();
 return row ? profileFromRow(row) : null;
}
export interface ProfileChange {
 changeId: string; revision: number; actor: { kind: string; id: string }; reason: string; evidence: string;
 before: UserProfile; after: UserProfile; undoOf: string | null; createdAt: number;
}
export async function listProfileHistory(db: D1Database, userId: string, limit = 50): Promise<ProfileChange[]> {
 identifier(userId);
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail();
 const rows = (await db.prepare('SELECT * FROM profile_changes WHERE user_id=? ORDER BY revision DESC LIMIT ?').bind(userId, limit).all<Record<string, unknown>>()).results;
 return rows.map(r => ({ changeId: String(r.change_id), revision: Number(r.revision), actor: { kind: String(r.actor_kind), id: String(r.actor_id) }, reason: String(r.reason), evidence: String(r.evidence), before: JSON.parse(String(r.before_json)), after: JSON.parse(String(r.after_json)), undoOf: r.undo_of === null ? null : String(r.undo_of), createdAt: Number(r.created_at) }));
}
interface Envelope { expectedRevision: number; changeId: string; reason: string; evidence: string }
function envelope(v: Record<string, unknown>): Envelope {
 return { expectedRevision: revision(v.expectedRevision), changeId: identifier(v.changeId), reason: text(v.reason, 500), evidence: text(v.evidence, 1000) };
}
const settingKeys = ['name', 'minScore', 'minConfidence', 'dailyLimit', 'timezone', 'quietStart', 'quietEnd', 'enabled', 'cooldownMinutes'];
// Parsing retains a canonical request so retries cannot silently reuse an ID for different intent.
export function parseOperations(value: unknown): Record<string, unknown>[] {
 if (!Array.isArray(value) || value.length < 1 || value.length > 20) fail();
 return value.map(raw => {
  const v = record(raw);
  switch (v.op) {
   case 'set_topic': exact(v, ['op', 'topic', 'mode']); return { op: v.op, topic: normalizeTopic(v.topic), mode: mode(v.mode) };
   case 'remove_topic': case 'remove_inferred_topic': exact(v, ['op', 'topic']); return { op: v.op, topic: normalizeTopic(v.topic) };
   case 'set_source': exact(v, ['op', 'sourceId', 'mode']); return { op: v.op, sourceId: identifier(v.sourceId), mode: mode(v.mode) };
   case 'remove_source': exact(v, ['op', 'sourceId']); return { op: v.op, sourceId: identifier(v.sourceId) };
   case 'set_inferred_topic': {
    exact(v, ['op', 'topic', 'weight', 'evidence']);
    if (typeof v.weight !== 'number' || !Number.isFinite(v.weight) || Math.abs(v.weight) > .25) fail();
    return { op: v.op, topic: normalizeTopic(v.topic), weight: v.weight, evidence: text(v.evidence, 500) };
   }
   case 'set_delivery': exact(v, ['op', 'delivery']); return { op: v.op, delivery: delivery(v.delivery) };
   case 'set_settings': {
    exact(v, ['op', 'settings']); const settings = record(v.settings);
    if (!Object.keys(settings).length || Object.keys(settings).some(k => !settingKeys.includes(k))) fail();
    return { op: v.op, settings: Object.fromEntries(settingKeys.filter(k => Object.hasOwn(settings, k)).map(k => [k, settings[k]])) };
   }
   case 'set_interests': {
    exact(v, ['op', 'interests', 'excludedTopics']);
    const list = (x: unknown): string[] => {
     if (!Array.isArray(x) || x.length > 20) return fail();
     return [...new Set(x.map(t => text(t, 300)))];
    };
    const interests = list(v.interests); if (!interests.length) fail();
    return { op: v.op, interests, excludedTopics: list(v.excludedTopics) };
   }
   default: return fail();
  }
 });
}
function applyOperations(before: UserProfile, operations: Record<string, unknown>[]): UserProfile {
 const after = structuredClone(before); const p = after.preferences ?? defaultPreferences(); after.preferences = p;
 for (const op of operations) {
  switch (op.op) {
   case 'set_topic': p.topics = p.topics.filter(x => normalizeTopic(x.topic) !== op.topic); p.topics.push({ topic: op.topic as string, mode: op.mode as PreferenceMode }); break;
   case 'remove_topic': p.topics = p.topics.filter(x => normalizeTopic(x.topic) !== op.topic); break;
   case 'set_source': p.sources = p.sources.filter(x => x.sourceId !== op.sourceId); p.sources.push({ sourceId: op.sourceId as string, mode: op.mode as PreferenceMode }); break;
   case 'remove_source': p.sources = p.sources.filter(x => x.sourceId !== op.sourceId); break;
   case 'set_inferred_topic': p.inferredTopics = p.inferredTopics.filter(x => normalizeTopic(x.topic) !== op.topic); p.inferredTopics.push({ topic: op.topic as string, weight: op.weight as number, evidence: op.evidence as string }); break;
   case 'remove_inferred_topic': p.inferredTopics = p.inferredTopics.filter(x => normalizeTopic(x.topic) !== op.topic); break;
   case 'set_delivery': p.delivery = op.delivery as ProfilePreferences['delivery']; break;
   case 'set_settings': {
    const settings = { ...op.settings as Record<string, unknown> };
    if (Object.hasOwn(settings, 'cooldownMinutes')) { const n = settings.cooldownMinutes; if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 10080) fail(); p.cooldownMinutes = n; delete settings.cooldownMinutes; }
    Object.assign(after, settings); break;
   }
   case 'set_interests': after.interests = op.interests as string[]; after.excludedTopics = op.excludedTopics as string[]; break;
  }
 }
 if (p.topics.length > 20 || p.sources.length > 20 || p.inferredTopics.length > 20) fail('preference_limit');
 // Reuse baseline validation for policy bounds; never trust the agent to stay within budgets.
 let parsed: UserProfile; try { parsed = parseProfile(after); } catch { return fail(); }
 return { ...parsed, preferences: p, revision: (before.revision ?? 0) + 1 };
}
interface AuditRow { request_json: string; before_json: string; after_json: string; revision: number; undo_of: string | null }
export interface MutationResult { profile: UserProfile; replayed: boolean }
async function prior(db: D1Database, userId: string, changeId: string, requestJson: string): Promise<MutationResult | null> {
 const row = await db.prepare('SELECT request_json FROM profile_changes WHERE user_id=? AND change_id=?').bind(userId, changeId).first<AuditRow>();
 if (!row) return null;
 if (row.request_json !== requestJson) fail('change_id_conflict', 409);
 // Return the current revision on retry, not a snapshot that may now be obsolete.
 const profile = await readProfile(db, userId); if (!profile) return fail('profile_not_found', 404);
 return { profile, replayed: true };
}
async function persist(db: D1Database, userId: string, before: UserProfile, after: UserProfile, meta: Envelope, actor: ProfileActor, requestJson: string, undoOf: string | null): Promise<MutationResult> {
 let result: D1Result[];
 try {
  result = await db.batch([
   db.prepare(`UPDATE users SET name=?,interests_json=?,excluded_topics_json=?,min_score=?,min_confidence=?,daily_limit=?,timezone=?,quiet_start=?,quiet_end=?,enabled=?,preferences_json=?,profile_revision=? WHERE id=? AND profile_revision=?`).bind(after.name, JSON.stringify(after.interests), JSON.stringify(after.excludedTopics), after.minScore, after.minConfidence, after.dailyLimit, after.timezone, after.quietStart, after.quietEnd, +after.enabled, JSON.stringify(after.preferences), after.revision, userId, meta.expectedRevision),
   db.prepare(`INSERT INTO profile_changes(user_id,change_id,revision,actor_kind,actor_id,reason,evidence,request_json,before_json,after_json,undo_of,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(userId, meta.changeId, after.revision, actor.kind, actor.id, meta.reason, meta.evidence, requestJson, JSON.stringify(before), JSON.stringify(after), undoOf, Date.now()),
   // changes() refers to the audit insert, so a lost CAS cannot suppress another writer's queue.
   db.prepare(`UPDATE outbox SET status='suppressed',error_code='profile_changed' WHERE user_id=? AND status='pending' AND changes()=1`).bind(userId)
  ]);
 } catch (error) {
  const replay = await prior(db, userId, meta.changeId, requestJson); if (replay) return replay;
  throw error; // API boundary sanitizes storage errors; do not return SQL or data.
 }
 if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) {
  const replay = await prior(db, userId, meta.changeId, requestJson); if (replay) return replay;
  fail('revision_conflict', 409);
 }
 return { profile: after, replayed: false };
}
export async function mutateProfile(db: D1Database, userId: string, body: unknown, actor: ProfileActor): Promise<MutationResult> {
 scoped(actor, userId); const v = record(body); exact(v, ['expectedRevision', 'changeId', 'reason', 'evidence', 'operations']);
 const meta = envelope(v); const operations = parseOperations(v.operations);
 const requestJson = JSON.stringify({ ...meta, operations, actor });
 const replay = await prior(db, userId, meta.changeId, requestJson); if (replay) return replay;
 const before = await readProfile(db, userId); if (!before) return fail('profile_not_found', 404);
 if (before.revision !== meta.expectedRevision) fail('revision_conflict', 409);
 // A preference may reference only a registered source. Agents cannot create arbitrary fetch targets.
 for (const op of operations) if (op.op === 'set_source' && !await db.prepare('SELECT id FROM sources WHERE id=?').bind(op.sourceId).first()) fail('source_not_found', 404);
 const after = applyOperations(before, operations);
 return persist(db, userId, before, after, meta, actor, requestJson, null);
}
export async function undoProfile(db: D1Database, userId: string, body: unknown, actor: ProfileActor): Promise<MutationResult> {
 scoped(actor, userId); const v = record(body); exact(v, ['expectedRevision', 'changeId', 'reason', 'evidence', 'targetChangeId']);
 const meta = envelope(v); const targetChangeId = identifier(v.targetChangeId);
 const requestJson = JSON.stringify({ ...meta, targetChangeId, actor });
 const replay = await prior(db, userId, meta.changeId, requestJson); if (replay) return replay;
 const before = await readProfile(db, userId); if (!before) return fail('profile_not_found', 404);
 if (before.revision !== meta.expectedRevision) fail('revision_conflict', 409);
 const target = await db.prepare('SELECT * FROM profile_changes WHERE user_id=? AND change_id=?').bind(userId, targetChangeId).first<AuditRow>();
 if (!target) fail('change_not_found', 404);
 if (Number(target.revision) !== before.revision) fail('undo_not_latest', 409);
 const restored = JSON.parse(target.before_json) as UserProfile;
 const after = { ...restored, revision: meta.expectedRevision + 1 };
 return persist(db, userId, before, after, meta, actor, requestJson, targetChangeId);
}
