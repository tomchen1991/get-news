import type { UserProfile } from '../types';
import { topicMatches } from '../interest-policy';

export interface SearchPlan { key: string; query: string; userIds: string[]; intervalMs: number }
const minute = 60_000;
const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');

/** Only explicit topic labels go to the search service, never profile evidence,
 * inferred interests, user names or complete profile JSON. This is a bounded
 * lexical planner, not a semantic/private-data classifier. */
export function buildSearchPlans(profiles: UserProfile[]): SearchPlan[] {
 const shared = new Map<string, SearchPlan>();
 for (const profile of [...profiles].sort((a,b)=>a.id.localeCompare(b.id))) {
  if (!profile.enabled || profile.preferences?.delivery === 'paused') continue;
  const preferences = profile.preferences;
  const topics = [...profile.interests, ...(preferences?.topics ?? []).filter(t=>t.mode!=='exclude').map(t=>t.topic)];
  const excluded = [...profile.excludedTopics, ...(preferences?.topics ?? []).filter(t=>t.mode==='exclude').map(t=>t.topic)];
  for (const topic of topics) {
   const query = normalize(topic);
   if (!query || query.length > 300 || /[\u0000-\u001f\u007f]/u.test(query) || excluded.some(rule=>topicMatches(rule, query))) continue;
   const modes = (preferences?.topics ?? []).filter(t=>topicMatches(t.topic, query)).map(t=>t.mode);
   let intervalMs = (modes.includes('prefer') ? 30 : 60) * minute;
   if (modes.includes('less')) intervalMs = 180 * minute;
   if (modes.includes('digest') || preferences?.delivery === 'digest') intervalMs = Math.max(intervalMs, 180 * minute);
   const plan = shared.get(query);
   if (plan) {
    if (!plan.userIds.includes(profile.id)) plan.userIds.push(profile.id);
    plan.intervalMs = Math.min(plan.intervalMs, intervalMs);
   } else shared.set(query, {key:query, query, userIds:[profile.id], intervalMs});
  }
 }
 return [...shared.values()].sort((a,b)=>a.key.localeCompare(b.key)).slice(0,30);
}

/** A global collection schedule, independent of user notification quiet hours.
 * Exactly 29 local slots including both 08:00 and 22:00. The local slot key
 * suppresses duplicate cron delivery and repeated wall-clock slots at DST. */
export function searchSlot(now: number, timezone = 'Asia/Shanghai'): {slot:string;day:string;month:string} | null {
 if (!Number.isFinite(now)) return null;
 let parts: Intl.DateTimeFormatPart[];
 try {
  parts = new Intl.DateTimeFormat('en-CA', {timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(now));
 } catch { return null; }
 const get = (name:string) => parts.find(part=>part.type===name)?.value ?? '';
 const hour = Number(get('hour')), minutes = Number(get('minute'));
 if ((minutes !== 0 && minutes !== 30) || hour < 8 || hour > 22 || (hour === 22 && minutes !== 0)) return null;
 const day = `${get('year')}-${get('month')}-${get('day')}`;
 return {slot:`${day}T${get('hour')}:${get('minute')}`,day,month:day.slice(0,7)};
}
