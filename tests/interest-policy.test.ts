import { describe, expect, it } from 'vitest';
import { alertPolicy, candidatePriority, planSource, sourceAllowed, topicMatches } from '../src/interest-policy';
import type { UserProfile } from '../src/types';
const user: UserProfile = {id:'u',name:'User',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.75,dailyLimit:3,timezone:'UTC',quietStart:22,quietEnd:8,enabled:true};
const pref = () => ({topics:[] as Array<{topic:string;mode:'prefer'|'less'|'exclude'|'digest'}>,sources:[] as Array<{sourceId:string;mode:'prefer'|'less'|'exclude'|'digest'}>,inferredTopics:[] as Array<{topic:string;weight:number;evidence:string}>,delivery:'alert' as 'alert'|'digest'|'paused',cooldownMinutes:0});
const source = {id:'s',enabled:true};
describe('interest policy',()=>{
 it('preserves legacy cadence and does not poll without active users',()=>{
  expect(planSource(source,[user])).toMatchObject({shouldPoll:true,intervalMs:20*60_000,userIds:['u']});
  expect(planSource({...source,tags:['football']},[user]).intervalMs).toBe(20*60_000);
  expect(planSource(source,[]).shouldPoll).toBe(false);
  expect(planSource(source,[{...user,enabled:false}]).shouldPoll).toBe(false);
  expect(planSource({...source,enabled:0},[user]).shouldPoll).toBe(false);
 });
 it('makes lexical matching conservative and handles normalization',()=>{
  expect(topicMatches('AI','AI funding')).toBe(true);
  expect(topicMatches('AI','paid promotion')).toBe(false);
  expect(topicMatches(' ＡＩ ','ai')).toBe(true);
  expect(topicMatches('融资','AI融资新闻')).toBe(true);
  expect(topicMatches('融','融资')).toBe(false);
  expect(topicMatches('','AI')).toBe(false);
  expect(topicMatches('C++','C++ release')).toBe(true);
 });
 it('slows unrelated tags and low priority sources within bounds',()=>{
  expect(planSource({...source,tags:['football']},[{...user,preferences:pref()}]).intervalMs).toBe(60*60_000);
  expect(planSource({...source,tags:['AI']},[user]).intervalMs).toBe(20*60_000);
  expect(planSource(source,[{...user,preferences:{...pref(),sources:[{sourceId:'s',mode:'less'}]}}]).intervalMs).toBe(180*60_000);
 });
 it('honors each user independently when a shared source is excluded or slowed',()=>{
  const excluded={...user,preferences:{...pref(),sources:[{sourceId:'s',mode:'exclude' as const}]}};
  expect(sourceAllowed(excluded,'s')).toBe(false);
  expect(planSource(source,[excluded]).shouldPoll).toBe(false);
  expect(planSource(source,[excluded,{...user,id:'other'}])).toMatchObject({shouldPoll:true,userIds:['other'],intervalMs:20*60_000});
  expect(planSource(source,[{...user,preferences:{...pref(),sources:[{sourceId:'s',mode:'less'}]}},{...user,id:'other'}]).intervalMs).toBe(20*60_000);
 });
 it('does not globally disable mixed feeds for one excluded topic',()=>{
  const p={...user,preferences:{...pref(),topics:[{topic:'funding',mode:'exclude' as const}]}};
  expect(planSource({...source,tags:['AI','funding']},[p]).intervalMs).toBe(20*60_000);
  expect(planSource({...source,tags:['funding']},[p]).intervalMs).toBe(180*60_000);
 });
 it('digest settings prevent alerts but retain collection',()=>{
  for(const preferences of [{...pref(),delivery:'digest' as const},{...pref(),sources:[{sourceId:'s',mode:'digest' as const}]},{...pref(),topics:[{topic:'AI',mode:'digest' as const}]}]){
   const p={...user,preferences};
   expect(alertPolicy(p,'s',['AI']).action).toBe('digest');
   expect(planSource({...source,tags:['AI']},[p])).toMatchObject({shouldPoll:true,intervalMs:60*60_000});
  }
 });
 it('pause and explicit exclusion override prefer/inferred interest',()=>{
  const p={...user,preferences:{...pref(),topics:[{topic:'AI',mode:'prefer' as const}],sources:[{sourceId:'s',mode:'exclude' as const}],inferredTopics:[{topic:'AI',weight:1,evidence:'liked'}]}};
  expect(alertPolicy(p,'s',['AI'])).toEqual({action:'suppress',reason:'source_excluded'});
  expect(alertPolicy({...user,preferences:{...pref(),delivery:'paused'}},'s',['AI']).action).toBe('suppress');
  expect(planSource(source,[{...user,preferences:{...pref(),delivery:'paused'}}]).shouldPoll).toBe(false);
  expect(alertPolicy({...user,excludedTopics:['AI']},'s',['AI news']).action).toBe('suppress');
 });
 it('ranks explicit preferences but never lets inference override or grant',()=>{
  expect(candidatePriority(user,'s',['AI'])).toBe(0);
  expect(candidatePriority({...user,preferences:{...pref(),topics:[{topic:'AI',mode:'prefer'}]}},'s',['AI'])).toBe(10);
  expect(candidatePriority({...user,preferences:{...pref(),topics:[{topic:'AI',mode:'less'}]}},'s',['AI'])).toBe(-15);
  expect(candidatePriority({...user,preferences:{...pref(),inferredTopics:[{topic:'AI',weight:1,evidence:'likes'}]}},'s',['AI'])).toBe(0);
 });
});
