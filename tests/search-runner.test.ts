import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { runSearch, type SearchConfig } from '../src/search/runner';
import { SearchError } from '../src/search/providers';
import type { NewsItem, UserProfile } from '../src/types';
const user:UserProfile={id:'u',name:'User',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.75,dailyLimit:3,timezone:'UTC',quietStart:22,quietEnd:8,enabled:true};
const now=Date.parse('2026-11-01T08:00:00Z');
const hour=3600000;
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0)) close();});
async function setup(items:NewsItem[]=[],users:UserProfile[]=[user]) {
 const database=createDatabase();cleanups.push(database.close);const store=new Store(database.db);
 for(const profile of users) await store.saveProfile(profile);
 const search=vi.fn(async()=>({items,credits:1,requestId:'request'}));
 const config:SearchConfig={name:'tavily',provider:{search},timezone:'UTC',dailyLimit:29,monthlyLimit:900};
 return {store,search,config};
}
const article=(path:string,date:string|null):NewsItem=>({externalId:path,url:`https://news.provider.com/${path}`,title:'Story',summary:'News',publishedAt:date});
describe('search runner reservations',()=>{
 it('deduplicates parallel calls and repeated invocations in a slot',async()=>{
  const {store,config,search}=await setup();
  await Promise.all([runSearch(store,config,[user],now),runSearch(store,config,[user],now)]);
  await runSearch(store,config,[user],now);
  expect(search).toHaveBeenCalledTimes(1);
  expect(await store.first('SELECT count(*) AS count,sum(units) AS units FROM search_attempts')).toEqual({count:1,units:1});
 });
 it('enforces daily and monthly hard budgets across failed or completed calls',async()=>{
  const {store,config,search}=await setup();config.dailyLimit=1;config.monthlyLimit=2;
  await runSearch(store,config,[user],now);
  await runSearch(store,config,[user],now+hour);
  expect(search).toHaveBeenCalledTimes(1);
  await runSearch(store,config,[user],now+24*hour);
  await runSearch(store,config,[user],now+48*hour);
  expect(search).toHaveBeenCalledTimes(2);
  await runSearch(store,config,[user],Date.parse('2026-12-01T08:00:00Z'));
  expect(search).toHaveBeenCalledTimes(3);
 });
 it('does not spend when disabled by zero budget or outside schedule',async()=>{
  const {store,config,search}=await setup();
  await runSearch(store,{...config,dailyLimit:0},[user],now);
  await runSearch(store,config,[user],now-30*60000);
  expect(search).not.toHaveBeenCalled();
 });
 it('rotates oldest-attempted due plans, not every user or every topic each slot',async()=>{
  const second={...user,id:'b',interests:['AI','space']};
  const {store,config,search}=await setup([], [user,second]);
  for(let i=0;i<3;i++) await runSearch(store,config,[user,second],now+i*30*60000);
  expect(search.mock.calls.map(call=>(call as unknown as [{query:string}])[0].query)).toEqual(['ai','space','ai']);
  expect(await store.first('SELECT count(*) AS count FROM search_attempts')).toEqual({count:3});
 });
 it('counts timeout reservations and never retries the same slot or refunds',async()=>{
  const {store,config,search}=await setup();config.dailyLimit=1;
  search.mockRejectedValue(new SearchError('transport'));
  await runSearch(store,config,[user],now);
  await runSearch(store,config,[user],now);
  await runSearch(store,config,[user],now+hour);
  expect(search).toHaveBeenCalledTimes(1);
  expect(await store.first('SELECT status,units,error_code FROM search_attempts')).toEqual({status:'failed',units:1,error_code:'transport'});
 });
 it('pauses quota exhaustion for the rest of the month without refunding',async()=>{
  const {store,config,search}=await setup();
  search.mockRejectedValue(new SearchError('quota',432));
  await runSearch(store,config,[user],now);
  await runSearch(store,config,[user],now+24*hour);
  expect(search).toHaveBeenCalledTimes(1);
  expect(await store.first('SELECT sum(units) AS units FROM search_attempts')).toEqual({units:1});
  const state=await store.first<{paused_until:number}>('SELECT paused_until FROM search_provider_state');
  expect(state!.paused_until).toBeGreaterThan(Date.parse('2026-11-30T23:59:59Z'));
 });
 it('permanently pauses authentication errors and honors retry-after',async()=>{
  const {store,config,search}=await setup();
  search.mockRejectedValueOnce(new SearchError('rate_limit',429,2*hour));
  await runSearch(store,config,[user],now);
  await runSearch(store,config,[user],now+hour);
  expect(search).toHaveBeenCalledTimes(1);
  search.mockRejectedValueOnce(new SearchError('unauthorized',401));
  await runSearch(store,config,[user],now+2*hour);
  await runSearch(store,config,[user],now+24*hour);
  expect(search).toHaveBeenCalledTimes(2);
  expect(await store.first('SELECT error_code FROM search_provider_state')).toEqual({error_code:'unauthorized'});
 });
});
describe('search ingestion safety',()=>{
 it('baselines first successful query, then only judges dated fresh candidates',async()=>{
  const {store,config,search}=await setup([article('baseline',new Date(now).toISOString())]);
  await runSearch(store,config,[user],now);
  expect(await store.first('SELECT count(*) AS count FROM judgments')).toEqual({count:0});
  search.mockResolvedValue({items:[article('unknown',null),article('fresh',new Date(now+hour).toISOString()),article('stale',new Date(now-48*hour).toISOString()),article('future',new Date(now+48*hour).toISOString())],credits:1,requestId:'later'});
  await runSearch(store,config,[user],now+hour);
  expect(await store.first('SELECT count(*) AS count FROM judgments')).toEqual({count:1});
  expect(await store.first('SELECT count(*) AS count FROM articles')).toEqual({count:5});
  expect(await store.first('SELECT count(*) AS count FROM search_results')).toEqual({count:5});
 });
 it('does not let unknown-date search discovery suppress later dated RSS news',async()=>{
  const {store,config}=await setup([article('discovery',null)]);
  await runSearch(store,config,[user],now);
  const row=await store.first<{id:string}>('SELECT id FROM articles');
  await store.saveSource({id:'rss',name:'RSS',kind:'rss',url:'https://news.provider.com/feed',enabled:true});
  await store.ingest(row!.id,article('discovery',new Date(now+hour).toISOString()),'rss',true,[user],now+hour);
  expect(await store.first('SELECT source_id,eligible FROM articles')).toEqual({source_id:'rss',eligible:1});
  expect(await store.first('SELECT count(*) AS count FROM judgments')).toEqual({count:1});
  expect(await store.first('SELECT count(*) AS count FROM search_results')).toEqual({count:1});
 });
 it('deduplicates canonical URLs but retains per-attempt provenance',async()=>{
  const {store,config}=await setup([article('same?utm_campaign=abc',null),article('same',null)]);
  await runSearch(store,config,[user],now);await runSearch(store,config,[user],now+hour);
  expect(await store.first('SELECT count(*) AS count FROM articles')).toEqual({count:1});
  expect(await store.first('SELECT count(*) AS count FROM search_results')).toEqual({count:2});
 });
});
describe('search migration',()=>{
 it('preserves existing RSS source and article foreign keys',()=>{
  const db=new DatabaseSync(':memory:');cleanups.push(()=>db.close());
  for(const file of ['0001_initial.sql','0002_profiles.sql','0003_source_policy.sql']) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db.exec("INSERT INTO sources(id,name,kind,url) VALUES('rss','RSS','rss','https://news.provider.com/feed'); INSERT INTO articles(id,source_id,external_id,url,title,summary,discovered_at,eligible) VALUES('a','rss','a','https://news.provider.com/a','Story','News',1,1)");
  db.exec('BEGIN');
  db.exec(readFileSync(new URL('../migrations/0004_search.sql',import.meta.url),'utf8'));
  db.exec('COMMIT');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('SELECT source_id FROM articles WHERE id=?').get('a')).toMatchObject({source_id:'rss'});
  expect(db.prepare('SELECT count(*) AS count FROM sources').get()).toMatchObject({count:1});
 });
});
