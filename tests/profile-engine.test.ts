import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { runPipeline } from '../src/engine';
import type { Decision, UserProfile } from '../src/types';
const NOW=Date.parse('2026-11-09T04:00:00Z');
const user:UserProfile={id:'u',name:'User',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.8,dailyLimit:3,timezone:'UTC',quietStart:22,quietEnd:2,enabled:true};
const decision:Decision={important:true,shouldPush:true,score:95,confidence:.95,reason:'Important',summary:'Release',topics:['AI']};
const preferences=()=>({topics:[],sources:[],inferredTopics:[],delivery:'alert',cooldownMinutes:0});
describe('profile-aware pipeline',()=>{
 let db:ReturnType<typeof createDatabase>,store:Store;
 beforeEach(async()=>{db=createDatabase();store=new Store(db.db);await store.saveProfile(user);await store.saveSource({id:'s',name:'Source',kind:'rss',url:'https://news.example.com/rss',enabled:true,topics:['AI']});});
 afterEach(()=>db.close());
 async function set(p:unknown){await store.run('UPDATE users SET preferences_json=?,profile_revision=profile_revision+1 WHERE id=?',JSON.stringify(p),'u');}
 function setup(count=1) {
  const fetch=vi.fn().mockResolvedValue({items:Array.from({length:count},(_,i)=>({externalId:String(i),url:`https://news.example.com/${i}`,title:`News ${i}`,summary:'Release',publishedAt:new Date(NOW-1000).toISOString()})),notModified:false,etag:null,lastModified:null});
  const evaluate=vi.fn().mockResolvedValue(decision),send=vi.fn().mockResolvedValue('sent');
  return {fetch,evaluate,send,deps:{store,sources:new Map([['rss',{kind:'rss',fetch}]]),judge:{evaluate},notifier:{send},now:()=>NOW}};
 }
 it('paused and source-excluded users spend no collection/model budget',async()=>{
  for(const p of [{...preferences(),delivery:'paused'},{...preferences(),sources:[{sourceId:'s',mode:'exclude'}]}]){
   await set(p);const s=setup();await runPipeline(s.deps);expect(s.fetch).not.toHaveBeenCalled();expect(s.evaluate).not.toHaveBeenCalled();
  }
 });
 it('stores digest decision without sending an alert',async()=>{
  await set({...preferences(),delivery:'digest'});const s=setup();await runPipeline(s.deps);
  expect(s.evaluate).toHaveBeenCalledOnce();expect(s.send).not.toHaveBeenCalled();
  expect(await store.first('SELECT status,error_code,decision_json FROM judgments')).toMatchObject({status:'skipped',error_code:'digest_only',decision_json:JSON.stringify(decision)});
 });
 it('enforces explicit topic exclusions even if judge says push',async()=>{
  await set({...preferences(),topics:[{topic:'AI',mode:'exclude'}]});const s=setup();await runPipeline(s.deps);
  expect(s.send).not.toHaveBeenCalled();expect(await store.first('SELECT error_code FROM judgments')).toEqual({error_code:'topic_excluded'});
 });
 it('does not accept a stale decision when profile changes during model call',async()=>{
  const s=setup();s.evaluate.mockImplementation(async()=>{await set({...preferences(),delivery:'paused'});return decision;});
  await runPipeline(s.deps);expect(s.send).not.toHaveBeenCalled();expect(await store.first('SELECT error_code FROM judgments')).toEqual({error_code:'profile_changed'});
 });
 it('compares candidates and enforces cooldown atomically',async()=>{
  await set({...preferences(),topics:[{topic:'priority',mode:'prefer'}],cooldownMinutes:60});
  const s=setup(2);s.evaluate.mockResolvedValueOnce(decision).mockResolvedValueOnce({...decision,topics:['priority']});
  await runPipeline(s.deps);expect(s.send).toHaveBeenCalledOnce();expect(s.send.mock.calls[0][1].decision.topics).toEqual(['priority']);
  expect(await store.first("SELECT count(*) AS n FROM outbox WHERE status='pending'")).toEqual({n:1});
 });
 it('slows explicit less sources and preserves their failure backoff',async()=>{
  await set({...preferences(),sources:[{sourceId:'s',mode:'less'}]});const s=setup();s.fetch.mockRejectedValue(new Error('failed'));
  await runPipeline(s.deps);expect(await store.first('SELECT next_poll_at FROM sources')).toEqual({next_poll_at:NOW+180*60_000});
  await runPipeline(s.deps);expect(s.fetch).toHaveBeenCalledOnce();
 });
});
