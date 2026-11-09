import type { UserProfile } from './types';

// Pure policy: it never creates a source, fetches a URL, calls a model or sends a message.
// The caller supplies tags from the administrator-managed source catalog, not feed text.
type Mode = 'prefer' | 'less' | 'exclude' | 'digest';
type PolicyProfile = UserProfile & { preferences?: {
 topics: Array<{ topic: string; mode: Mode }>;
 sources: Array<{ sourceId: string; mode: Mode }>;
 inferredTopics: Array<{ topic: string; weight: number; evidence: string }>;
 delivery: 'alert' | 'digest' | 'paused';
 cooldownMinutes: number;
} };
export interface CatalogSource { id: string; enabled: boolean | number; tags?: string[] }
export interface SourcePlan { shouldPoll: boolean; intervalMs: number | null; userIds: string[]; reason: string }
export interface AlertPolicy { action: 'allow' | 'digest' | 'suppress'; reason: string }
const minute = 60_000;
const normalize = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');

/** Lexical label matching, not semantic classification. ASCII words cannot match inside
 * other words (AI must not match paid). CJK phrases need two characters unless exact.
 * Long natural-language interests still belong in the LLM input, not a substring rule.
 */
export function topicMatches(rule: string, label: string): boolean {
 const r = normalize(rule), t = normalize(label);
 if (!r || !t) return false;
 if (r === t) return true;
 if (r.length < 2) return false;
 const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const left = /^[a-z0-9]/.test(r) ? '(?<![a-z0-9])' : '';
 const right = /[a-z0-9]$/.test(r) ? '(?![a-z0-9])' : '';
 return new RegExp(`${left}${escaped}${right}`, 'u').test(t);
}
function sourceModes(profile: PolicyProfile, sourceId: string): Mode[] {
 return (profile.preferences?.sources ?? []).filter(r => r.sourceId === sourceId).map(r => r.mode);
}
function topicModes(profile: PolicyProfile, topics: string[]): Mode[] {
 return (profile.preferences?.topics ?? []).filter(r => topics.some(t => topicMatches(r.topic, t))).map(r => r.mode);
}
export function sourceAllowed(profile: PolicyProfile, sourceId: string): boolean {
 return profile.enabled && profile.preferences?.delivery !== 'paused' && !sourceModes(profile, sourceId).includes('exclude');
}

/** A shared source is still fetched when any enabled user wants it. A topic exclusion
 * does not disable a mixed-topic feed; per-article filtering happens after collection.
 * No settings => legacy 20-minute schedule. Unmatched tagged sources => 60 minutes.
 */
export function planSource(source: CatalogSource, profiles: PolicyProfile[]): SourcePlan {
 if (!source.enabled) return { shouldPoll: false, intervalMs: null, userIds: [], reason: 'source_disabled' };
 const users = profiles.filter(p => sourceAllowed(p, source.id));
 if (!users.length) return { shouldPoll: false, intervalMs: null, userIds: [], reason: 'no_active_subscribers' };
 const tags = source.tags ?? [];
 const intervals = users.map(p => {
  const sourceRules = sourceModes(p, source.id), topicRules = topicModes(p, tags);
  const interestMatch = p.interests.some(i => tags.some(t => topicMatches(i, t)));
  let minutes = p.preferences && tags.length && !interestMatch ? 60 : 20;
  if (topicRules.includes('prefer')) minutes = 20;
  // Slowing an entire mixed feed just because one excluded tag matches would hide
  // unrelated stories. Slow only if every tag is explicitly low-priority/excluded.
  if (tags.length && tags.every(t => topicModes(p, [t]).some(m => m === 'less' || m === 'exclude'))) minutes = 180;
  if (sourceRules.includes('prefer')) minutes = 20;
  if (sourceRules.includes('less')) minutes = 180;
  if (p.preferences?.delivery === 'digest' || sourceRules.includes('digest') || topicRules.includes('digest')) minutes = Math.max(minutes, 60);
  return minutes * minute;
 });
 return { shouldPoll: true, intervalMs: Math.min(...intervals), userIds: users.map(p => p.id).sort(), reason: 'shared_interest_schedule' };
}

/** Digest means retain for a future/manual digest, never send an alert. It does not
 * promise that a digest scheduler exists. Inferred interests cannot relax hard rules.
 */
export function alertPolicy(profile: PolicyProfile, sourceId: string, topics: string[]): AlertPolicy {
 if (!profile.enabled) return { action: 'suppress', reason: 'user_disabled' };
 if (profile.preferences?.delivery === 'paused') return { action: 'suppress', reason: 'delivery_paused' };
 const sourceRules = sourceModes(profile, sourceId), topicRules = topicModes(profile, topics);
 if (sourceRules.includes('exclude')) return { action: 'suppress', reason: 'source_excluded' };
 if (topicRules.includes('exclude') || profile.excludedTopics.some(r => topics.some(t => topicMatches(r, t)))) return { action: 'suppress', reason: 'topic_excluded' };
 if (profile.preferences?.delivery === 'digest' || sourceRules.includes('digest') || topicRules.includes('digest')) return { action: 'digest', reason: 'digest_only' };
 return { action: 'allow', reason: 'alert_allowed' };
}

/** Relative tie-breaking/ranking bonus. Never bypass score/confidence, expiry, quota
 * or hard exclusions. Inferred hints stay advisory in the model prompt only.
 */
export function candidatePriority(profile: PolicyProfile, sourceId: string, topics: string[]): number {
 if (alertPolicy(profile, sourceId, topics).action !== 'allow') return -100;
 const modes = [...sourceModes(profile, sourceId), ...topicModes(profile, topics)];
 if (modes.includes('less')) return -15;
 return modes.includes('prefer') ? 10 : 0;
}
