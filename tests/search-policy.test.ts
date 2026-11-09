import { describe, expect, it } from 'vitest';
import { buildSearchPlans, searchSlot } from '../src/search/policy';
import { defaultPreferences } from '../src/profiles';
import type { UserProfile } from '../src/types';
const user:UserProfile={id:'u',name:'PRIVATE NAME',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.75,dailyLimit:3,timezone:'UTC',quietStart:22,quietEnd:8,enabled:true};
describe('search plans',()=>{
 it('shares normalized queries while retaining subscribers',()=>{
  expect(buildSearchPlans([user,{...user,id:'b',interests:[' ＡＩ ']}])).toEqual([{key:'ai',query:'ai',userIds:['b','u'],intervalMs:3600000}]);
 });
 it('honors disabled/paused users and per-user exclusion',()=>{
  expect(buildSearchPlans([{...user,enabled:false},{...user,id:'b',preferences:{...defaultPreferences(),delivery:'paused'}}])).toEqual([]);
  const result=buildSearchPlans([{...user,excludedTopics:['AI']},{...user,id:'b'}]);
  expect(result[0].userIds).toEqual(['b']);
  expect(buildSearchPlans([{...user,preferences:{...defaultPreferences(),topics:[{topic:'AI',mode:'exclude'}]}}])).toEqual([]);
 });
 it('changes collection cadence without publishing evidence or inferred topics',()=>{
  const preferences={...defaultPreferences(),topics:[{topic:'AI',mode:'prefer' as const},{topic:'space',mode:'less' as const},{topic:'economy',mode:'digest' as const}],inferredTopics:[{topic:'PRIVATE TOPIC',weight:1,evidence:'SECRET'}]};
  expect(buildSearchPlans([{...user,preferences}])).toEqual([
   {key:'ai',query:'ai',userIds:['u'],intervalMs:1800000},
   {key:'economy',query:'economy',userIds:['u'],intervalMs:10800000},
   {key:'space',query:'space',userIds:['u'],intervalMs:10800000},
  ]);
  expect(buildSearchPlans([{...user,preferences:{...preferences,delivery:'digest'}}])[0].intervalMs).toBe(10800000);
 });
 it('bounds plans and invalid topics',()=>{
  expect(buildSearchPlans([{...user,interests:['', 'x'.repeat(301), '\u0000bad']}])).toEqual([]);
  expect(buildSearchPlans([{...user,interests:Array.from({length:40},(_,i)=>`topic ${i}`)}])).toHaveLength(30);
 });
});
describe('search slots',()=>{
 it('has exactly 29 slots a day and includes local endpoints',()=>{
  const start=Date.parse('2026-11-01T00:00:00+08:00');
  const slots=Array.from({length:144},(_,i)=>searchSlot(start+i*600000)).filter(Boolean);
  expect(slots).toHaveLength(29);
  expect(slots[0]).toEqual({slot:'2026-11-01T08:00',day:'2026-11-01',month:'2026-11'});
  expect(slots.at(-1)?.slot).toBe('2026-11-01T22:00');
 });
 it('uses configured timezone, no slots outside halfhours, invalid zones fail closed',()=>{
  const now=Date.parse('2026-11-01T08:00:00Z');
  expect(searchSlot(now,'UTC')?.slot).toBe('2026-11-01T08:00');
  expect(searchSlot(now)?.slot).toBe('2026-11-01T16:00');
  expect(searchSlot(now+600000,'UTC')).toBeNull();
  expect(searchSlot(now,'invalid')).toBeNull();
  expect(searchSlot(NaN)).toBeNull();
 });
});
