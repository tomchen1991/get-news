import { articleId, isEligible } from '../config';
import { sourceAllowed } from '../interest-policy';
import { Store } from '../store';
import type { UserProfile } from '../types';
import { buildSearchPlans, searchSlot } from './policy';
import { SearchError, type SearchProvider } from './providers';
export interface SearchConfig { provider: SearchProvider; name:'tavily'|'cloudflare'; timezone:string; dailyLimit:number; monthlyLimit:number }
/** Reservations count even on timeout/error. Never retry a slot or refund uncertain usage. */
export async function runSearch(store:Store, config:SearchConfig, profiles:UserProfile[], now:number):Promise<number> {
 const slot=searchSlot(now,config.timezone); if(!slot) return 0;
 const paused=await store.first<{paused_until:number}>('SELECT paused_until FROM search_provider_state WHERE provider=?',config.name);
 if(paused && paused.paused_until>now) return 0;
 const plans=buildSearchPlans(profiles.filter(p=>sourceAllowed(p,`search_${config.name}`)));
 const states=await store.all<{plan_key:string;next_attempt_at:number;last_attempt_at:number;last_success_at:number|null}>('SELECT * FROM search_plan_state WHERE provider=?',config.name);
 const byKey=new Map(states.map(s=>[s.plan_key,s]));
 const due=plans.filter(p=>(byKey.get(p.key)?.next_attempt_at??0)<=now).sort((a,b)=>(byKey.get(a.key)?.last_attempt_at??0)-(byKey.get(b.key)?.last_attempt_at??0)||a.key.localeCompare(b.key));
 const plan=due[0]; if(!plan) return 0;
 const id=crypto.randomUUID();
 // A single conditional insert is atomic in D1. Slot UNIQUE also protects concurrent/manual invocations.
 const reserved=await store.run(`INSERT OR IGNORE INTO search_attempts(id,slot,provider,plan_key,query,day,month,started_at)
 SELECT ?,?,?,?,?,?,?,? WHERE
 (SELECT coalesce(sum(units),0) FROM search_attempts WHERE provider=? AND day=?)<? AND
 (SELECT coalesce(sum(units),0) FROM search_attempts WHERE provider=? AND month=?)<?`,id,slot.slot,config.name,plan.key,plan.query,slot.day,slot.month,now,config.name,slot.day,config.dailyLimit,config.name,slot.month,config.monthlyLimit);
 if(!reserved) return 0;
 await store.run(`INSERT INTO search_plan_state(provider,plan_key,last_attempt_at,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(provider,plan_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at`,config.name,plan.key,now,now+plan.intervalMs);
 try {
  const existing=await store.first<{acquisition:string}>('SELECT acquisition FROM sources WHERE id=?',`search_${config.name}`);
  if(existing && existing.acquisition!=='search') throw new SearchError('configuration');
  const result=await config.provider.search({query:plan.query,maxResults:10});
  await store.run("INSERT OR IGNORE INTO sources(id,name,kind,url,enabled,acquisition) VALUES(?,?,'rss',?,0,'search')",`search_${config.name}`,config.name==='tavily'?'Tavily News':'Cloudflare Web Search (Ceramic)',config.name==='tavily'?'https://api.tavily.com/search':'https://api.cloudflare.com/client/v4/ai/websearch');
  let count=0;
  for(const [rank,item] of result.items.slice(0,10).entries()) {
   let canonical;
   try { canonical=await articleId(item.url); } catch { continue; }
   {
    // Unknown dates are discovery-only; first successful search is a baseline.
    const eligible=byKey.get(plan.key)?.last_success_at!=null && item.publishedAt!==null && isEligible(item.publishedAt,now,byKey.get(plan.key)?.last_success_at!=null);
    await store.ingest(canonical.id,{...item,url:canonical.url},`search_${config.name}`,eligible,profiles.filter(p=>plan.userIds.includes(p.id)),now);
    await store.run('INSERT OR IGNORE INTO search_results(attempt_id,article_id,rank,published_at,metadata_json) VALUES(?,?,?,?,?)',id,canonical.id,rank+1,item.publishedAt,JSON.stringify({provider:config.name,query:plan.query,requestId:result.requestId??null}));
    count++;
   }
  }
  if(config.name==='tavily' && result.credits>1) {
   await store.run('UPDATE search_attempts SET units=? WHERE id=?',Math.ceil(result.credits),id);
   await store.run("INSERT INTO search_provider_state(provider,paused_until,error_code) VALUES(?,?,'unexpected_credit_usage') ON CONFLICT(provider) DO UPDATE SET paused_until=excluded.paused_until,error_code=excluded.error_code",config.name,8640000000000000);
  }
  await store.run("UPDATE search_attempts SET status='completed',finished_at=?,request_id=?,result_count=?,credits=? WHERE id=?",now,result.requestId??null,count,result.credits,id);
  await store.run('UPDATE search_plan_state SET last_success_at=? WHERE provider=? AND plan_key=?',now,config.name,plan.key);
  return count;
 } catch(error) {
  const e=error instanceof SearchError?error:null;
  const code=e?.code??'search_failed';
  const permanent=e?.status===401||e?.status===403||e?.status===400||e?.code==='configuration'||e?.code==='invalid_query';
  const quota=e?.status===432||e?.status===433;
  // Fail closed until admin resets permanent auth/config errors, or next month for quota.
  const until=permanent?8640000000000000:quota?Date.UTC(Number(slot.month.slice(0,4)),Number(slot.month.slice(5,7)),1)+86400000:now+Math.max(30*60000,e?.retryAfterMs??0);
  await store.run(`INSERT INTO search_provider_state(provider,paused_until,error_code) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET paused_until=excluded.paused_until,error_code=excluded.error_code`,config.name,until,code);
  await store.run("UPDATE search_attempts SET status='failed',finished_at=?,error_code=? WHERE id=?",now,code,id);
  return 0;
 }
}
