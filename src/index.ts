import { searchConfig } from './search/config';
import { buildSearchPlans } from './search/policy';
import type { Env } from './types';
import { LIMITS, parseProfile, parseSource } from './config';
import { Store } from './store';
import { createRssAdapter } from './sources';
import { createJudge } from './llm';
import { createWebhookNotifier, createWecomNotifier } from './notifications';
import { adminAsset } from './admin';
import { runPipeline } from './engine';
import { readProfile, mutateProfile, undoProfile, listProfileHistory, ProfileError } from './profiles';
import { PROFILE_TOOLS, parseToolCall } from './profile-tools';
import { planSource } from './interest-policy';
import type { SourceRow } from './store';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function authorized(request:Request,token:string|undefined):Promise<boolean> {
 if(!token || token.length<32) return false;
 const header=request.headers.get('Authorization')??'';
 if(!header.startsWith('Bearer ') || header.length>1024) return false;
 const hash=async(s:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
 const [a,b]=await Promise.all([hash(header.slice(7)),hash(token)]);
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
 if(env.PUSH_ENABLED==='true' && env.PUSH_PROVIDER && !['webhook','wecom'].includes(env.PUSH_PROVIDER)) throw new Error('Invalid push provider');
 const notifier=env.PUSH_ENABLED==='true'?(env.PUSH_PROVIDER==='wecom'?createWecomNotifier(env.WECOM_WEBHOOK_URL??''):createWebhookNotifier(env.PUSH_WEBHOOK_URL??'',env.PUSH_WEBHOOK_TOKEN??'')):undefined;
 let search,searchConfigurationError=false;
 try {search=searchConfig(env);} catch {searchConfigurationError=true;}
 return {store:new Store(env.DB),sources:new Map([['rss',createRssAdapter()]]),judge,notifier,search,searchConfigurationError};
}
export async function handleRequest(request:Request,env:Env):Promise<Response> {
 const url=new URL(request.url);
 if(request.method==='GET') { const asset=adminAsset(url.pathname); if(asset) return asset; }
 if(url.pathname==='/health' && request.method==='GET') return json({service:'get-news',version:'0.1.0'});
 const admin=await authorized(request,env.ADMIN_TOKEN);
 const agent=!admin && !!env.PROFILE_AGENT_USER_ID && await authorized(request,env.PROFILE_AGENT_TOKEN);
 if(!admin && !agent) return json({error:'unauthorized'},401);
 const profileRoute=url.pathname.match(/^\/api\/profiles\/([A-Za-z0-9_-]{1,64})(?:\/(history|changes|undo|tools|collection-plan))?$/);
 if(agent && (!profileRoute || profileRoute[1]!==env.PROFILE_AGENT_USER_ID)) return json({error:'forbidden'},403);
 const store=new Store(env.DB);
 try {
  if(admin && url.pathname==='/api/search' && request.method==='GET') return json({enabled:env.SEARCH_ENABLED==='true',provider:env.SEARCH_PROVIDER??'tavily',timezone:env.SEARCH_TIMEZONE??'Asia/Shanghai',plans:buildSearchPlans(await store.profiles()),attempts:await store.all('SELECT * FROM search_attempts ORDER BY started_at DESC LIMIT 100'),state:await store.all('SELECT * FROM search_provider_state')});
  if(admin && url.pathname==='/api/search/resume' && request.method==='POST') { await store.run('DELETE FROM search_provider_state'); return json({resumed:true}); }
  if(profileRoute) {
   const [,userId,action]=profileRoute;
   const profile=await readProfile(env.DB,userId);
   if(!profile) return json({error:'profile_not_found'},404);
   const actor=admin?{kind:'admin' as const,id:'admin'}:{kind:'agent' as const,id:'profile-agent',userId};
   const preview=async()=> (await store.all<SourceRow>("SELECT * FROM sources WHERE acquisition='rss' ORDER BY id")).map(s=>({id:s.id,name:s.name,...planSource({...s,tags:JSON.parse(s.topics_json)},[profile])}));
   if(request.method==='GET') {
    if(!action) return json(profile);
    if(action==='history') return json(await listProfileHistory(env.DB,userId));
    if(action==='tools') return json({tools:PROFILE_TOOLS});
    if(action==='collection-plan') return json({scope:'this_user',sources:await preview(),searchPlans:buildSearchPlans([profile])});
   }
   if(request.method==='POST' && ['changes','undo','tools'].includes(action)) {
    let body:unknown;
    try {body=await readJson(request);} catch {return json({error:'invalid_json_body'},400);}
    if(action==='changes') return json(await mutateProfile(env.DB,userId,body,actor));
    if(action==='undo') return json(await undoProfile(env.DB,userId,body,actor));
    let call;try {call=parseToolCall(body);}catch{return json({error:'invalid_tool_call'},400);}
    if(call.name==='get_profile') return json(profile);
    if(call.name==='list_profile_changes') return json(await listProfileHistory(env.DB,userId));
    if(call.name==='preview_collection_plan') return json({scope:'this_user',sources:await preview(),searchPlans:buildSearchPlans([profile])});
    if(call.name==='update_profile') return json(await mutateProfile(env.DB,userId,call.arguments,actor));
    return json(await undoProfile(env.DB,userId,call.arguments,actor));
   }
   return json({error:'not_found'},404);
  }
  if(request.method==='POST' && url.pathname==='/api/run') return json(await runPipeline(dependencies(env)));
  if(request.method==='GET' && url.pathname==='/api/status') return json({searchEnabled:env.SEARCH_ENABLED==='true',searchConfigurationValid:(()=>{try{searchConfig(env);return true;}catch{return false;}})(),llmEnabled:env.LLM_ENABLED==='true',pushEnabled:env.PUSH_ENABLED==='true',pushProvider:env.PUSH_PROVIDER??'webhook',limits:LIMITS,runs:await store.all('SELECT * FROM runs ORDER BY started_at DESC LIMIT 20'),jobs:await store.all('SELECT status,count(*) AS count FROM judgments GROUP BY status'),outbox:await store.all('SELECT status,count(*) AS count FROM outbox GROUP BY status')});
  if(request.method==='GET' && url.pathname==='/api/sources') return json(await store.all('SELECT * FROM sources ORDER BY id'));
  if(request.method==='PUT' && url.pathname==='/api/sources') {
   const source=parseSource(await readJson(request));
   if(source.id.startsWith('search_')) return json({error:'reserved_source_id'},400);
   const existing=await store.first('SELECT id FROM sources WHERE id=?',source.id);
   const count=await store.first<{count:number}>("SELECT count(*) AS count FROM sources WHERE acquisition='rss'");
   if(!existing && (count?.count??0)>=20) return json({error:'source_limit'},409);
   await store.saveSource(source); return json({ok:true,id:source.id});
  }
  if(request.method==='GET' && url.pathname==='/api/users') return json(await store.all('SELECT * FROM users ORDER BY id'));
  if(request.method==='PUT' && url.pathname==='/api/users') {
   const profile=parseProfile(await readJson(request));
   const existing=await store.first('SELECT id FROM users WHERE id=?',profile.id);
   const count=await store.first<{count:number}>('SELECT count(*) AS count FROM users');
   if(existing) return json({error:'use_versioned_profile_changes'},409);
   if((count?.count??0)>=LIMITS.users) return json({error:'user_limit'},409);
   await store.saveProfile(profile); return json({ok:true,id:profile.id});
  }
  if(request.method==='GET' && url.pathname==='/api/articles') return json(await store.all('SELECT * FROM articles ORDER BY discovered_at DESC LIMIT 100'));
  if(request.method==='GET' && url.pathname==='/api/decisions') return json(await store.all('SELECT * FROM judgments ORDER BY updated_at DESC LIMIT 100'));
  if(request.method==='GET' && url.pathname==='/api/outbox') return json(await store.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100'));
  return json({error:'not_found'},404);
 } catch(error) {
  if(error instanceof ProfileError) return json({error:error.code},error.status);
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
