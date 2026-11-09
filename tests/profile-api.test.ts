import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './d1';
import { handleRequest } from '../src';
import { PROFILE_TOOLS } from '../src/profile-tools';
import { parseOperations } from '../src/profiles';
import type { Env } from '../src/types';
const admin='admin-token-at-least-32-characters-long';
const agent='agent-token-at-least-32-characters-long';
const profile={id:'alice',name:'Alice',interests:['AI'],excludedTopics:[],minScore:75,minConfidence:.8,dailyLimit:3,timezone:'Asia/Shanghai',quietStart:22,quietEnd:8,enabled:true};
const change=(revision=0,id='change-1')=>({expectedRevision:revision,changeId:id,reason:'User preference',evidence:'User: digest only',operations:[{op:'set_delivery',delivery:'digest'}]});
let database:ReturnType<typeof createDatabase>,env:Env;
function call(path:string,method='GET',body?:unknown,token=agent) {
 return handleRequest(new Request(`https://worker.example${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
}
const route='/api/profiles/alice';
beforeEach(async()=>{database=createDatabase();env={DB:database.db,ADMIN_TOKEN:admin,PROFILE_AGENT_TOKEN:agent,PROFILE_AGENT_USER_ID:'alice'};expect((await call('/api/users','PUT',profile,admin)).status).toBe(200);expect((await call('/api/users','PUT',{...profile,id:'bob'},admin)).status).toBe(200);});
afterEach(()=>database.close());
describe('scoped profile API',()=>{
 it('allows only own routes for scoped agent, denying admin APIs and other users',async()=>{
  expect((await call(route)).status).toBe(200);
  for(const [path,method] of [['/api/users','GET'],['/api/users','PUT'],['/api/sources','PUT'],['/api/run','POST'],['/api/status','GET'],['/api/profiles/bob','GET'],['/api/profiles/bob/tools','POST'],['/api/profiles/bob/history','GET']]) expect((await call(path,method,method==='GET'?undefined:{})).status).toBe(403);
  for(const e of [{...env,PROFILE_AGENT_USER_ID:undefined},{...env,PROFILE_AGENT_TOKEN:'short'}])expect((await handleRequest(new Request('https://worker.example'+route,{headers:{Authorization:`Bearer ${agent}`}}),e)).status).toBe(401);
  expect((await call('/api/profiles/bob','GET',undefined,admin)).status).toBe(200);
 });
 it('legacy PUT cannot overwrite existing profile and history is initially empty',async()=>{
  const response=await call('/api/users','PUT',{...profile,name:'Overwrite'},admin);
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'use_versioned_profile_changes'});
  expect(await (await call(route)).json()).toMatchObject({name:'Alice',revision:0});
  expect(await (await call(route+'/history')).json()).toEqual([]);
 });
 it('supports tool discovery, reads, update, idempotency, history and undo',async()=>{
  expect(await (await call(route+'/tools')).json()).toEqual({tools:PROFILE_TOOLS});
  expect(await (await call(route+'/tools','POST',{name:'get_profile',arguments:{}})).json()).toMatchObject({id:'alice',revision:0});
  const body={name:'update_profile',arguments:change()};
  const updated=await call(route+'/tools','POST',body);expect(updated.status).toBe(200);expect(await updated.json()).toMatchObject({profile:{revision:1,preferences:{delivery:'digest'}},replayed:false});
  expect(await (await call(route+'/tools','POST',body)).json()).toMatchObject({replayed:true});
  const history=await (await call(route+'/tools','POST',{name:'list_profile_changes',arguments:{}})).json();
  expect(history).toMatchObject([{changeId:'change-1',revision:1,actor:{kind:'agent',id:'profile-agent'}}]);
  const undo={expectedRevision:1,changeId:'undo-1',targetChangeId:'change-1',reason:'User undid',evidence:'User: undo it'};
  expect(await (await call(route+'/tools','POST',{name:'undo_profile_change',arguments:undo})).json()).toMatchObject({profile:{revision:2,preferences:{delivery:'alert'}}});
  expect(await (await call(route+'/tools','POST',{name:'preview_collection_plan',arguments:{}})).json()).toMatchObject({scope:'this_user',sources:[],searchPlans:[{query:'ai'}]});
  expect(await (await call('/api/profiles/bob/history','GET',undefined,admin)).json()).toEqual([]);
 });
 it('direct update/undo endpoints return safe invalid and conflict responses',async()=>{
  expect((await call(route+'/changes','POST',change())).status).toBe(200);
  expect((await call(route+'/changes','POST',change(0,'other'))).status).toBe(409);
  expect((await call(route+'/changes','POST',{...change(),reason:'different'})).status).toBe(409);
  for(const body of [{...change(1,'invalid'),extra:true},{...change(1,'invalid'),operations:[{op:'set_delivery',delivery:'invalid'}]},null]) expect((await call(route+'/changes','POST',body)).status).toBe(400);
  expect((await call(route+'/undo','POST',{expectedRevision:1,changeId:'undo',targetChangeId:'change-1',reason:'Undo',evidence:'User: revert'})).status).toBe(200);
 });
 it('rejects malformed tool calls, huge bodies, and wrong content types',async()=>{
  for(const body of [{name:'get_profile',arguments:{userId:'bob'}},{name:'delete_user',arguments:{}},{name:'get_profile',arguments:{},extra:1},{name:'update_profile',arguments:{}}])expect((await call(route+'/tools','POST',body)).status).toBe(400);
  expect((await call(route+'/changes','POST',{padding:'x'.repeat(17000)})).status).toBe(400);
  for(const headers of [new Headers({Authorization:`Bearer ${agent}`}),new Headers({Authorization:`Bearer ${agent}`,'Content-Type':'application/json'})]){
   const response=await handleRequest(new Request('https://worker.example'+route+'/changes',{method:'POST',headers,body:'{not json'}),env);expect(response.status).toBe(400);
   expect(await response.text()).toBe('{"error":"invalid_json_body"}');
  }
 });
 it('tool operation names and happy-path arguments agree with the domain validator',()=>{
  const samples=[{op:'set_topic',topic:'AI',mode:'prefer'},{op:'remove_topic',topic:'AI'},{op:'set_source',sourceId:'news',mode:'less'},{op:'remove_source',sourceId:'news'},{op:'set_inferred_topic',topic:'AI',weight:.25,evidence:'A click'},{op:'remove_inferred_topic',topic:'AI'},{op:'set_delivery',delivery:'paused'},{op:'set_settings',settings:{name:'Alice',cooldownMinutes:60}},{op:'set_interests',interests:['AI'],excludedTopics:[]}];
  const update=PROFILE_TOOLS.find(t=>t.function.name==='update_profile')!;
  const properties=update.function.parameters.properties as Record<string,any>;
  const variants=properties.operations.items.oneOf as any[];
  expect(variants.map(v=>v.properties.op.const).sort()).toEqual(samples.map(s=>s.op).sort());
  const schemaFor=(op:string)=>variants.find(v=>v.properties.op.const===op).properties;
  expect(schemaFor('set_topic').topic.maxLength).toBe(300);
  expect(schemaFor('set_inferred_topic').evidence.maxLength).toBe(500);
  expect(schemaFor('set_settings').settings.properties.cooldownMinutes.maximum).toBe(10080);
  expect(properties.expectedRevision.maximum).toBe(Number.MAX_SAFE_INTEGER-1);
  for(const field of [properties.changeId,schemaFor('set_source').sourceId]){expect(field.maxLength).toBe(64);expect(new RegExp(field.pattern).test('https://evil.test')).toBe(false);}

  for(const sample of samples){expect(()=>parseOperations([sample])).not.toThrow();const schema=variants.find(v=>v.properties.op.const===sample.op);expect(schema.additionalProperties).toBe(false);expect(Object.keys(sample).sort()).toEqual(schema.required.slice().sort());}
 });
});
