import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { runPipeline } from '../src/engine';
import { LIMITS } from '../src/config';
import { createWecomNotifier } from '../src/notifications';
import type { Decision, NewsItem, SourceAdapter, UserProfile } from '../src/types';
const NOW=Date.parse('2026-11-09T04:00:00Z'); // noon Shanghai
const profile:UserProfile={id:'owner',name:'Owner',interests:['AI'],excludedTopics:['rumors'],minScore:75,minConfidence:.8,dailyLimit:3,timezone:'Asia/Shanghai',quietStart:22,quietEnd:8,enabled:true};
const decision:Decision={important:true,shouldPush:true,score:90,confidence:.95,reason:'API change',summary:'A new API was released.',topics:['AI']};
const news=(i=1,date:string|null=new Date(NOW-1000).toISOString()):NewsItem=>({externalId:String(i),url:`https://news.example.com/${i}`,title:`Release ${i}`,summary:'A verified release',publishedAt:date});
describe('pipeline with real SQLite SQL',()=>{
 let db:ReturnType<typeof createDatabase>,store:Store,time:number;
 beforeEach(async()=>{db=createDatabase();store=new Store(db.db);time=NOW;await store.saveProfile(profile);await store.saveSource({id:'feed',name:'Feed',kind:'rss',url:'https://news.example.com/rss',enabled:true});});
 afterEach(()=>db.close());
 function setup(items:NewsItem[]=[news()]) {
  const fetch=vi.fn().mockResolvedValue({items,notModified:false,etag:'v1',lastModified:null});
  const evaluate=vi.fn().mockResolvedValue(decision),send=vi.fn().mockResolvedValue('sent');
  return {fetch,evaluate,send,deps:{store,sources:new Map([['rss',{kind:'rss',fetch} as SourceAdapter]]),judge:{evaluate},notifier:{send},now:()=>time}};
 }
 it('reserves WeCom delivery before I/O and never replays an ambiguous acknowledgement',async()=>{
  const s=setup();
  const fetcher=vi.fn(async()=>{
   expect(await store.first('SELECT status FROM outbox')).toEqual({status:'sending'});
   expect(await store.first('SELECT reservations FROM daily_usage')).toEqual({reservations:1});
   return new Response('ambiguous');
  });
  const deps={...s.deps,notifier:createWecomNotifier('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=mock',fetcher)};
  await runPipeline(deps);
  expect(await store.first('SELECT status FROM outbox')).toEqual({status:'uncertain'});
  time+=LIMITS.pollMs;await runPipeline(deps);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('collects, judges, persists and delivers once across duplicate polls',async()=>{
  const s=setup(); const first=await runPipeline(s.deps);expect(first.accepted).toBe(1);expect(s.send).toHaveBeenCalledOnce();
  expect(await store.first('SELECT status FROM outbox')).toEqual({status:'sent'});
  time+=LIMITS.pollMs;await runPipeline(s.deps);expect(s.evaluate).toHaveBeenCalledOnce();expect(s.send).toHaveBeenCalledOnce();
  expect(await store.first('SELECT reservations FROM daily_usage')).toEqual({reservations:1});
 });
 it('dry collection makes no judgment, then enabling model processes backlog',async()=>{
  const s=setup();await runPipeline({...s.deps,judge:undefined,notifier:undefined});expect(s.evaluate).not.toHaveBeenCalled();
  await runPipeline({...s.deps,notifier:undefined});expect(s.evaluate).toHaveBeenCalledOnce();expect(s.send).not.toHaveBeenCalled();
  expect(await store.first('SELECT status FROM outbox')).toEqual({status:'pending'});
 });
 it('304 keeps conditional metadata, no new jobs',async()=>{
  const s=setup();await runPipeline(s.deps);time+=LIMITS.pollMs;s.fetch.mockResolvedValue({items:[],notModified:true,etag:null,lastModified:null});await runPipeline(s.deps);
  expect(s.fetch.mock.calls[1][1].etag).toBe('v1');expect((await store.first<{etag:string}>('SELECT etag FROM sources'))?.etag).toBe('v1');expect(s.evaluate).toHaveBeenCalledOnce();
 });
 it('fails closed and retries judge at most three times with delay',async()=>{
  const s=setup();s.evaluate.mockRejectedValue(new Error('secret provider error'));await runPipeline(s.deps);expect(s.send).not.toHaveBeenCalled();
  await runPipeline(s.deps);expect(s.evaluate).toHaveBeenCalledOnce();time+=LIMITS.pollMs;await runPipeline(s.deps);time+=LIMITS.pollMs*2;await runPipeline(s.deps);time+=LIMITS.pollMs*8;await runPipeline(s.deps);
  expect(s.evaluate).toHaveBeenCalledTimes(3);expect(await store.first('SELECT status,error_code FROM judgments')).toEqual({status:'failed',error_code:'judge_failed'});
 });
 it('suppresses low scores/confidence or not-important outputs',async()=>{
  for(const d of [{...decision,score:20},{...decision,confidence:.2},{...decision,important:false,shouldPush:false}]) {
   const s=setup([news(Math.random())]);s.evaluate.mockResolvedValue(d);await store.run('UPDATE sources SET next_poll_at=0');await runPipeline(s.deps);expect(s.send).not.toHaveBeenCalled();
  }
 });
 it('filters old/future items and baselines first-fetch undated articles',async()=>{
  const s=setup([news(1,new Date(NOW-2*LIMITS.ageMs).toISOString()),news(2,new Date(NOW+LIMITS.futureMs+1).toISOString()),news(3,null)]);
  await runPipeline(s.deps);expect(s.evaluate).not.toHaveBeenCalled();time+=LIMITS.pollMs;s.fetch.mockResolvedValue({items:[news(3,null),news(4,null)],notModified:false,etag:null,lastModified:null});await runPipeline(s.deps);expect(s.evaluate).toHaveBeenCalledTimes(1);expect(s.evaluate.mock.calls[0][0].url).toContain('/4');
 });
 it('limits daily pushes and preserves excess pending entries',async()=>{
  const s=setup(Array.from({length:6},(_,i)=>news(i)));await runPipeline(s.deps);expect(s.send).toHaveBeenCalledTimes(3);await runPipeline(s.deps);expect(s.send).toHaveBeenCalledTimes(3);expect(await store.first('SELECT reservations FROM daily_usage')).toEqual({reservations:3});
 });
 it('quiet hours defer sends but do not discard judgments',async()=>{
  await store.saveProfile({...profile,quietStart:11,quietEnd:14});const s=setup();await runPipeline(s.deps);expect(s.evaluate).toHaveBeenCalledOnce();expect(s.send).not.toHaveBeenCalled();
  time+=3*3600000;await runPipeline(s.deps);expect(s.send).toHaveBeenCalledOnce();
 });
 it('does not replay ambiguous delivery',async()=>{
  const s=setup();s.send.mockResolvedValue('uncertain');await runPipeline(s.deps);time+=LIMITS.pollMs;await runPipeline(s.deps);expect(s.send).toHaveBeenCalledOnce();expect(await store.first('SELECT status FROM outbox')).toEqual({status:'uncertain'});
 });
 it('recovers interrupted sending as uncertain without a second HTTP send',async()=>{
  const s=setup();await runPipeline({...s.deps,notifier:undefined});await store.run("UPDATE outbox SET status='sending'");await runPipeline(s.deps);expect(s.send).not.toHaveBeenCalled();expect(await store.first('SELECT status FROM outbox')).toEqual({status:'uncertain'});
 });
 it('locks overlapping runs without touching feeds',async()=>{
  const s=setup();await store.lock('other',time,LIMITS.leaseMs);expect((await runPipeline(s.deps)).state).toBe('busy');expect(s.fetch).not.toHaveBeenCalled();time+=LIMITS.leaseMs;await runPipeline(s.deps);expect(s.fetch).toHaveBeenCalledOnce();
 });
 it('source errors back off without preventing healthy sources',async()=>{
  await store.saveSource({id:'second',name:'Second',kind:'rss',url:'https://other.example.com/rss',enabled:true});const s=setup();s.fetch.mockRejectedValueOnce(new Error('credential URL'));await runPipeline(s.deps);expect(s.send).toHaveBeenCalledOnce();expect(await store.first('SELECT last_error,failures FROM sources WHERE id=?','feed')).toEqual({last_error:'source_fetch_failed',failures:1});
 });
 it('caps actual model attempts per tick',async()=>{const s=setup(Array.from({length:20},(_,i)=>news(i)));await runPipeline(s.deps);expect(s.evaluate).toHaveBeenCalledTimes(LIMITS.decisionsPerRun);});
 it('honors disabled profiles at send time',async()=>{const s=setup();await runPipeline({...s.deps,notifier:undefined});await store.saveProfile({...profile,enabled:false});await runPipeline(s.deps);expect(s.send).not.toHaveBeenCalled();});
 it('transactional quota reservations never count duplicate claims',async()=>{const s=setup();await runPipeline({...s.deps,notifier:undefined});const r=await store.first<{id:string}>('SELECT id FROM outbox');expect(await store.reserve(r!.id,profile.id,'2026-11-09',3)).toBe(true);expect(await store.reserve(r!.id,profile.id,'2026-11-09',3)).toBe(false);expect(await store.first('SELECT reservations FROM daily_usage')).toEqual({reservations:1});});
});

describe('review regressions',()=>{
 it('bulk-expiry removes stale backlog before selecting the 8 current judgments',async()=>{
  const d=createDatabase();const store=new Store(d.db);try {
   await store.saveProfile(profile);await store.saveSource({id:'feed',name:'Feed',kind:'rss',url:'https://news.example.com/rss',enabled:true});
   for(let i=0;i<30;i++) await store.ingest(String(i),news(i,new Date(NOW-2*LIMITS.ageMs).toISOString()),'feed',true,[profile],NOW-2*LIMITS.ageMs);
   await store.ingest('fresh',news(100),'feed',true,[profile],NOW);
   const evaluate=vi.fn().mockResolvedValue(decision);
   await runPipeline({store,now:()=>NOW,sources:new Map([['rss',{kind:'rss',fetch:async()=>({items:[],notModified:true,etag:null,lastModified:null})}]]),judge:{evaluate}});
   expect(evaluate).toHaveBeenCalledOnce();expect(evaluate.mock.calls[0][0].title).toBe('Release 100');expect(await store.first('SELECT count(*) AS n FROM judgments WHERE error_code=?','expired')).toEqual({n:30});
  }finally{d.close();}
 });
 it('expires an accepted alert based on article age, not fresh outbox age',async()=>{
  const d=createDatabase();const store=new Store(d.db);try {
   await store.saveProfile(profile);await store.saveSource({id:'feed',name:'Feed',kind:'rss',url:'https://news.example.com/rss',enabled:true});
   let time=NOW;const send=vi.fn().mockResolvedValue('sent');const deps={store,now:()=>time,sources:new Map([['rss',{kind:'rss',fetch:async()=>({items:[news(1,new Date(NOW-23*3600000).toISOString())],notModified:false,etag:null,lastModified:null})}]]),judge:{evaluate:async()=>decision}};
   await runPipeline(deps);time+=2*3600000;await runPipeline({...deps,notifier:{send}});expect(send).not.toHaveBeenCalled();expect(await store.first('SELECT status,error_code FROM outbox')).toEqual({status:'suppressed',error_code:'expired'});
  }finally{d.close();}
 });
 it('suppresses precomputed alerts when interests change before sending',async()=>{
  const d=createDatabase();const store=new Store(d.db);try {
   await store.saveProfile(profile);await store.saveSource({id:'feed',name:'Feed',kind:'rss',url:'https://news.example.com/rss',enabled:true});const send=vi.fn().mockResolvedValue('sent');const deps={store,now:()=>NOW,sources:new Map([['rss',{kind:'rss',fetch:async()=>({items:[news()],notModified:false,etag:null,lastModified:null})}]]),judge:{evaluate:async()=>decision}};
   await runPipeline(deps);await store.saveProfile({...profile,interests:['football']});await runPipeline({...deps,notifier:{send}});expect(send).not.toHaveBeenCalled();expect(await store.first('SELECT error_code FROM outbox')).toEqual({error_code:'profile_changed'});
  }finally{d.close();}
 });
});
