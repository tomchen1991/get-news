import type { UserProfile } from './types';
import { assertPublicHttpsUrl } from './http';
export const LIMITS = { sourcesPerRun: 10, users: 10, decisionsPerRun: 8, deliveriesPerRun: 5, articlesPerFeed: 40, pollMs: 20*60_000, ageMs: 24*60*60_000, futureMs: 5*60_000, leaseMs: 10*60_000, runMs: 8*60_000 } as const;
const identifier = (value: unknown): string => {
 if(typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('invalid_id'); return value;
};
function strings(value: unknown, max: number, length: number): string[] {
 if(!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !x.trim() || x.length > length)) throw new Error('invalid_list');
 return value.map(x => x.trim());
}
function integer(value: unknown, min:number, max:number): number {
 if(typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('invalid_number'); return value;
}
export function parseProfile(value: unknown): UserProfile {
 if(!value || typeof value !== 'object') throw new Error('invalid_profile');
 const v = value as Record<string, unknown>;
 const interests = strings(v.interests, 20, 300); if(!interests.length) throw new Error('interests_required');
 if(typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw new Error('invalid_name');
 if(typeof v.timezone !== 'string') throw new Error('invalid_timezone');
 try { new Intl.DateTimeFormat('en-US',{timeZone:v.timezone}).format(); } catch { throw new Error('invalid_timezone'); }
 if(typeof v.minConfidence !== 'number' || !Number.isFinite(v.minConfidence) || v.minConfidence < 0 || v.minConfidence > 1) throw new Error('invalid_confidence');
 if(typeof v.enabled !== 'boolean') throw new Error('invalid_enabled');
 return {id:identifier(v.id),name:v.name.trim(),interests,excludedTopics:strings(v.excludedTopics,20,300),minScore:integer(v.minScore,0,100),minConfidence:v.minConfidence,dailyLimit:integer(v.dailyLimit,0,20),timezone:v.timezone,quietStart:integer(v.quietStart,0,23),quietEnd:integer(v.quietEnd,0,23),enabled:v.enabled};
}
export interface SourceConfig { id:string; name:string; kind:'rss'; url:string; enabled:boolean }
export function parseSource(value:unknown):SourceConfig {
 if(!value || typeof value !== 'object') throw new Error('invalid_source');
 const v = value as Record<string,unknown>;
 if(v.kind !== 'rss' || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 || typeof v.enabled !== 'boolean' || typeof v.url !== 'string' || v.url.length > 2000) throw new Error('invalid_source');
 return {id:identifier(v.id),name:v.name.trim(),kind:'rss',url:assertPublicHttpsUrl(v.url).toString(),enabled:v.enabled};
}
export function localTime(timestamp:number, timezone:string):{day:string;hour:number} {
 const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(timestamp);
 const p = Object.fromEntries(parts.map(x=>[x.type,x.value]));
 return {day:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};
}
export function isQuiet(hour:number,start:number,end:number):boolean {
 return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export function isEligible(publishedAt:string|null, now:number, initialized:boolean):boolean {
 if(publishedAt === null) return initialized;
 const timestamp = Date.parse(publishedAt);
 return Number.isFinite(timestamp) && timestamp >= now-LIMITS.ageMs && timestamp <= now+LIMITS.futureMs;
}
export async function articleId(rawUrl:string):Promise<{id:string;url:string}> {
 const url = assertPublicHttpsUrl(rawUrl); url.hash='';
 for(const key of [...url.searchParams.keys()]) if(/^utm_/i.test(key) || ['fbclid','gclid'].includes(key)) url.searchParams.delete(key);
 url.searchParams.sort();
 const canonical = url.toString();
 const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));
 return {id:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),url:canonical};
}
