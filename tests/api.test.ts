import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createDatabase } from './d1';
import { handleRequest,dependencies } from '../src';
import { articleId,isEligible,isQuiet,localTime,parseProfile,parseSource,LIMITS } from '../src/config';
import { Store } from '../src/store';
import type { Env, UserProfile } from '../src/types';
const token='a-valid-admin-token-with-at-least-32-characters';
const profile:UserProfile={id:'owner',name:'Owner',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.8,dailyLimit:3,timezone:'Asia/Shanghai',quietStart:22,quietEnd:8,enabled:true};
describe('authenticated API',()=>{
 let db:ReturnType<typeof createDatabase>,env:Env;
 beforeEach(()=>{db=createDatabase();env={DB:db.db,ADMIN_TOKEN:token};});afterEach(()=>db.close());
 function request(path:string,method='GET',body?:unknown,auth=token) {return new Request(`https://worker.example.com${path}`,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
 it('only health is public; missing or short configured auth fails closed',async()=>{expect((await handleRequest(new Request('https://worker.example.com/health'),env)).status).toBe(200);for(const e of [env,{...env,ADMIN_TOKEN:undefined},{...env,ADMIN_TOKEN:'short'}])expect((await handleRequest(request('/api/users','GET',undefined,'wrong'),e)).status).toBe(401);});
 it('creates and updates profiles and source without credentials in state',async()=>{expect((await handleRequest(request('/api/users','PUT',profile),env)).status).toBe(200);expect((await handleRequest(request('/api/sources','PUT',{id:'rss',name:'News',kind:'rss',url:'https://news.example.com/rss',enabled:true}),env)).status).toBe(200);const r=await handleRequest(request('/api/status'),env);const text=await r.text();expect(text).not.toContain(token);expect(JSON.parse(text).llmEnabled).toBe(false);});
 it('rejects unsupported source adapters, private URLs and malformed profiles',async()=>{for(const payload of [{id:'x',kind:'web',url:'https://news.example.com',name:'x',enabled:true},{id:'x',kind:'rss',url:'https://127.0.0.1/rss',name:'x',enabled:true}])expect((await handleRequest(request('/api/sources','PUT',payload),env)).status).toBe(400);expect((await handleRequest(request('/api/users','PUT',{...profile,timezone:'made/up'}),env)).status).toBe(400);});
 it('rejects oversized admin input',async()=>{expect((await handleRequest(request('/api/users','PUT',{...profile,name:'a'.repeat(17000)}),env)).status).toBe(400);});
 it('disabled model/push flags never create external clients even with missing config',()=>{expect(dependencies(env).judge).toBeUndefined();expect(dependencies(env).notifier).toBeUndefined();expect(()=>dependencies({...env,LLM_ENABLED:'true'})).toThrow();});
 it('configuration caps are enforced atomically by SQLite even without API precheck',async()=>{const store=new Store(db.db);for(let i=0;i<10;i++)await store.saveProfile({...profile,id:`u${i}`});await expect(store.saveProfile({...profile,id:'extra'})).rejects.toThrow('user_limit');await expect(store.saveProfile({...profile,id:'u0',name:'Updated'})).resolves.toBeUndefined();});
 it('manual dry run is authenticated and completes without requests if no sources',async()=>{const r=await handleRequest(request('/api/run','POST'),env);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({state:'completed',decisions:0,delivered:0});});
});
describe('policy helpers',()=>{
 it('normalizes URL tracking parameters only, keeps meaningful query',async()=>{expect(await articleId('https://news.example.com/a?utm_source=x&b=2&a=1#fragment')).toEqual(await articleId('https://news.example.com/a?a=1&b=2'));expect((await articleId('https://news.example.com/a?a=2')).id).not.toBe((await articleId('https://news.example.com/a?a=1')).id);});
 it('honors local date, overnight and same-hour quiet policy',()=>{expect(localTime(Date.parse('2026-11-09T17:00:00Z'),'Asia/Shanghai')).toEqual({day:'2026-11-10',hour:1});expect(isQuiet(23,22,8)).toBe(true);expect(isQuiet(8,22,8)).toBe(false);expect(isQuiet(12,12,12)).toBe(false);expect(isQuiet(12,9,17)).toBe(true);});
 it('rejects negative, nonfinite and coerced configs',()=>{for(const v of [{minScore:'75'},{minConfidence:NaN},{dailyLimit:-1},{enabled:1},{interests:[]}])expect(()=>parseProfile({...profile,...v})).toThrow();expect(()=>parseSource({id:'x',name:'x',kind:'rss',url:'https://name:pw@news.example.com/rss',enabled:true})).toThrow();});
 it('bounds freshness and never trusts invalid publication dates',()=>{const now=Date.now();expect(isEligible('invalid',now,true)).toBe(false);expect(isEligible(null,now,false)).toBe(false);expect(isEligible(null,now,true)).toBe(true);expect(isEligible(new Date(now-LIMITS.ageMs-1).toISOString(),now,true)).toBe(false);});
});
