import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dependencies, handleRequest } from '../src';
import { searchConfig } from '../src/search/config';
import { Store } from '../src/store';
import type { Env } from '../src/types';
import { createDatabase } from './d1';
const admin = 'search-admin-token-at-least-32-characters';
const agent = 'profile-agent-token-at-least-32-characters';
function request(path:string, method='GET', body?:unknown, token=admin) {
 return new Request(`https://worker.example.com${path}`, { method, headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, ...(body===undefined?{}:{body:JSON.stringify(body)}) });
}
describe('search configuration and admin boundary',()=>{
 let database:ReturnType<typeof createDatabase>, env:Env;
 beforeEach(()=>{database=createDatabase();env={DB:database.db,ADMIN_TOKEN:admin,PROFILE_AGENT_TOKEN:agent,PROFILE_AGENT_USER_ID:'owner'};vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Network must not run in this test');}));});
 afterEach(()=>{database.close();vi.unstubAllGlobals();});
 it('search defaults off, including nonliteral truthy values and secrets without opt-in',()=>{
  for(const SEARCH_ENABLED of [undefined,'false','TRUE','1']) expect(dependencies({...env,SEARCH_ENABLED,TAVILY_API_KEY:'not-a-real-key'}).search).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
 });
 it('validates provider, budgets and timezone before a search can run',()=>{
  for(const change of [{SEARCH_PROVIDER:'unknown'}, {TAVILY_DAILY_CREDITS:'-1'}, {TAVILY_DAILY_CREDITS:'1.5'}, {TAVILY_MONTHLY_CREDITS:'NaN'}, {TAVILY_MONTHLY_CREDITS:'100001'}, {SEARCH_TIMEZONE:'not/a-zone'}]) expect(()=>searchConfig({...env,TAVILY_API_KEY:'test-only-key',CF_SEARCH_API_TOKEN:'test-only-key',CF_ACCOUNT_ID:'a'.repeat(32),SEARCH_ENABLED:'true',...change})).toThrow();
  expect(fetch).not.toHaveBeenCalled();
 });
 it('invalid search configuration does not disable the independent RSS pipeline',async()=>{
  const invalid={...env,TAVILY_API_KEY:'test-only-key',CF_SEARCH_API_TOKEN:'test-only-key',CF_ACCOUNT_ID:'a'.repeat(32),SEARCH_ENABLED:'true',SEARCH_PROVIDER:'invalid'};
  const deps=dependencies(invalid);
  expect(deps.search).toBeUndefined();expect(deps.sources.has('rss')).toBe(true);
  const response=await handleRequest(request('/api/run','POST'),invalid);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'completed',errors:1});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('uses safe default budgets and independent CF request units',()=>{
  expect(searchConfig({...env,TAVILY_API_KEY:'test-only-key',CF_SEARCH_API_TOKEN:'test-only-key',CF_ACCOUNT_ID:'a'.repeat(32),SEARCH_ENABLED:'true'})).toMatchObject({name:'tavily',timezone:'Asia/Shanghai',dailyLimit:29,monthlyLimit:900});
  expect(searchConfig({...env,TAVILY_API_KEY:'test-only-key',CF_SEARCH_API_TOKEN:'test-only-key',CF_ACCOUNT_ID:'a'.repeat(32),SEARCH_ENABLED:'true',SEARCH_PROVIDER:'cloudflare',CF_SEARCH_DAILY_REQUESTS:'3',CF_SEARCH_MONTHLY_REQUESTS:'45',TAVILY_DAILY_CREDITS:'99'})).toMatchObject({name:'cloudflare',dailyLimit:3,monthlyLimit:45});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('lets admin inspect without exposing configured secrets or making calls',async()=>{
  const response=await handleRequest(request('/api/search'),{...env,TAVILY_API_KEY:'private-tavily-key',CF_SEARCH_API_TOKEN:'private-cf-key'});
  expect(response.status).toBe(200);
  const text=await response.text();expect(JSON.parse(text)).toMatchObject({enabled:false,provider:'tavily',plans:[],attempts:[],state:[]});
  for(const value of [admin,agent,'private-tavily-key','private-cf-key']) expect(text).not.toContain(value);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('forbids scoped profile agent from search status, resume and run',async()=>{
  for(const [path,method] of [['/api/search','GET'],['/api/search/resume','POST'],['/api/run','POST']]) expect((await handleRequest(request(path,method,undefined,agent),env)).status).toBe(403);
  expect((await handleRequest(request('/api/search','GET',undefined,'invalid'),env)).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('resume clears only provider pause, never reservations or spend history',async()=>{
  const store=new Store(database.db);
  await store.run("INSERT INTO search_provider_state(provider,paused_until,error_code) VALUES('tavily',9999999999999,'quota')");
  await store.run("INSERT INTO search_attempts(id,slot,provider,plan_key,query,day,month,started_at) VALUES('attempt','2026-11-09T08:00','tavily','ai','ai','2026-11-09','2026-11',1)");
  expect((await handleRequest(request('/api/search/resume','POST'),env)).status).toBe(200);
  expect(await store.all('SELECT * FROM search_provider_state')).toEqual([]);
  expect(await store.first('SELECT count(*) AS count,sum(units) AS units FROM search_attempts')).toEqual({count:1,units:1});
 });
 it('prevents admin source API from rewriting or creating reserved search IDs',async()=>{
  const store=new Store(database.db);
  await store.run("INSERT INTO sources(id,name,kind,url,enabled,acquisition) VALUES('search_tavily','Tavily News','rss','https://api.tavily.com/search',0,'search')");
  for(const id of ['search_tavily','search_cloudflare']) {
   const response=await handleRequest(request('/api/sources','PUT',{id,name:'Override',kind:'rss',url:'https://news.example.com/feed',enabled:true}),env);
   expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'reserved_source_id'});
  }
  expect(await store.first("SELECT name,enabled,acquisition FROM sources WHERE id='search_tavily'")).toEqual({name:'Tavily News',enabled:0,acquisition:'search'});
  expect(await store.first("SELECT count(*) AS count FROM sources WHERE id='search_cloudflare'")).toEqual({count:0});
 });
});
