import type { Env } from './types';
import { LIMITS, parseProfile, parseSource } from './config';
import { Store } from './store';
import { createRssAdapter } from './sources';
import { createJudge } from './llm';
import { createWebhookNotifier } from './notifications';
import { runPipeline } from './engine';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function authorized(request:Request,env:Env):Promise<boolean> {
 if(!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length<32) return false;
 const header=request.headers.get('Authorization')??'';
 if(!header.startsWith('Bearer ') || header.length>1024) return false;
 const hash=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([hash(header.slice(7)),hash(env.ADMIN_TOKEN)]);
 let diff=0; for(let i=0;i<a.length;i++) diff|=a[i]^b[i]; return diff===0;
}
async function readJson(request:Request):Promise<unknown> {
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('json_required');
 if(!request.body) throw new Error('body_required');
 const reader=request.body.getReader(); let size=0,text=''; const decoder=new TextDecoder();
 try { while(true) { const chunk=await reader.read(); if(chunk.done) break; size+=chunk.value.byteLength; if(size>16384) {await reader.cancel(); throw new Error('body_too_large');} text+=decoder.decode(chunk.value,{stream:true}); } text+=decoder.decode(); return JSON.parse(text); }
 finally {reader.releaseLock();}
}
export function dependencies(env:Env) {
 const judge=env.LLM_ENABLED==='true'?createJudge({baseUrl:env.LLM_BASE_URL??'',apiKey:env.LLM_API_KEY??'',model:env.LLM_MODEL??''}):undefined;
 const notifier=env.PUSH_ENABLED==='true'?createWebhookNotifier(env.PUSH_WEBHOOK_URL??'',env.PUSH_WEBHOOK_TOKEN??''):undefined;
 return {store:new Store(env.DB),sources:new Map([['rss',createRssAdapter()]]),judge,notifier};
}
export async function handleRequest(request:Request,env:Env):Promise<Response> {
 const url=new URL(request.url);
 if(url.pathname==='/health' && request.method==='GET') return json({service:'get-news',version:'0.1.0'});
 if(!await authorized(request,env)) return json({error:'unauthorized'},401);
 const store=new Store(env.DB);
 try {
  if(request.method==='POST' && url.pathname==='/api/run') return json(await runPipeline(dependencies(env)));
  if(request.method==='GET' && url.pathname==='/api/status') return json({llmEnabled:env.LLM_ENABLED==='true',pushEnabled:env.PUSH_ENABLED==='true',limits:LIMITS,runs:await store.all('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20'),jobs:await store.all('SELECT status,count(*) AS count FROM judgments GROUP BY status'),outbox:await store.all('SELECT status,count(*) AS count FROM outbox GROUP BY status')});
  if(request.method==='GET' && url.pathname==='/api/sources') return json(await store.all('SELECT * FROM sources ORDER BY id'));
  if(request.method==='PUT' && url.pathname==='/api/sources') {
   const source=parseSource(await readJson(request));
   const existing=await store.first('SELECT id FROM sources WHERE id=?',source.id);
   const count=await store.first<{count:number}>('SELECT count(*) AS count FROM sources');
   if(!existing && (count?.count??0)>=20) return json({error:'source_limit'},409);
   await store.saveSource(source); return json({ok:true,id:source.id});
  }
  if(request.method==='GET' && url.pathname==='/api/users') return json(await store.all('SELECT * FROM users ORDER BY id'));
  if(request.method==='PUT' && url.pathname==='/api/users') {
   const profile=parseProfile(await readJson(request));
   const existing=await store.first('SELECT id FROM users WHERE id=?',profile.id);
   const count=await store.first<{count:number}>('SELECT count(*) AS count FROM users');
   if(!existing && (count?.count??0)>=LIMITS.users) return json({error:'user_limit'},409);
   await store.saveProfile(profile); return json({ok:true,id:profile.id});
  }
  if(request.method==='GET' && url.pathname==='/api/articles') return json(await store.all('SELECT * FROM articles ORDER BY discovered_at DESC LIMIT 100'));
  if(request.method==='GET' && url.pathname==='/api/decisions') return json(await store.all('SELECT * FROM judgments ORDER BY updated_at DESC LIMIT 100'));
  if(request.method==='GET' && url.pathname==='/api/outbox') return json(await store.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100'));
  return json({error:'not_found'},404);
 } catch(error) {
  // Never echo provider, feed, SQL or credential-bearing errors into HTTP/log responses.
  return json({error:request.method==='PUT'?'invalid_configuration':'operation_failed'},request.method==='PUT'?400:503);
 }
}
export default {
 fetch:handleRequest,
 async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext) {
  ctx.waitUntil(runPipeline(dependencies(env)).catch(()=>{console.error('get-news scheduled run failed; inspect authenticated /api/status');}));
 }
} satisfies ExportedHandler<Env>;
