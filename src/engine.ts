import type { Decision, Judge, SourceAdapter, UserProfile } from './types';
import { LIMITS, articleId, isEligible, isQuiet, localTime } from './config';
import { Store, type SourceRow } from './store';
import type { Notifier } from './notifications';
import { runSearch, type SearchConfig } from './search/runner';
import { readProfile } from './profiles';
import { alertPolicy, candidatePriority, planSource, sourceAllowed } from './interest-policy';
export interface Dependencies { store:Store; sources:Map<string,SourceAdapter>; judge?:Judge; notifier?:Notifier; now?:()=>number; search?:SearchConfig; searchConfigurationError?:boolean }
export interface RunStats { state:'completed'|'busy'; sources:number; items:number; decisions:number; accepted:number; deliveryAttempts:number; delivered:number; errors:number }
export async function runPipeline(deps:Dependencies):Promise<RunStats> {
 const now=deps.now??Date.now, store=deps.store, start=now(), token=crypto.randomUUID();
 const stats:RunStats={state:'completed',sources:0,items:0,decisions:0,accepted:0,deliveryAttempts:0,delivered:0,errors:deps.searchConfigurationError?1:0};
 if(!await store.lock(token,start,LIMITS.leaseMs)) return {...stats,state:'busy'};
 try {
  await store.run("INSERT INTO runs(id,started_at,status) VALUES(?,?,'running')",token,start);
  // Never auto-retry a possibly delivered webhook after a crash or ambiguous outcome.
  await store.run("UPDATE outbox SET status='uncertain',error_code='interrupted_delivery' WHERE status='sending'");
  await store.run("UPDATE judgments SET status='failed',error_code='attempts_exhausted' WHERE status='processing' AND attempts>=3 AND lease_until<=?",now());
  const profiles=await store.profiles();
  const active=async()=>{if(now()-start>LIMITS.runMs || !await store.run("UPDATE locks SET until_at=? WHERE id='poll' AND token=? AND until_at>?",now()+LIMITS.leaseMs,token,now())) throw new Error('lease_lost');};
  await store.run("UPDATE judgments SET status='skipped',error_code='expired',updated_at=? WHERE (status='pending' OR (status='processing' AND lease_until<=?)) AND article_id IN (SELECT id FROM articles WHERE discovered_at<? OR (published_at IS NOT NULL AND julianday(published_at)<julianday(?)))",now(),now(),now()-LIMITS.ageMs,new Date(now()-LIMITS.ageMs).toISOString());
  await store.run("UPDATE outbox SET status='suppressed',error_code='expired' WHERE status='pending' AND judgment_id IN (SELECT j.id FROM judgments j JOIN articles a ON j.article_id=a.id WHERE a.discovered_at<? OR (a.published_at IS NOT NULL AND julianday(a.published_at)<julianday(?)))",now()-LIMITS.ageMs,new Date(now()-LIMITS.ageMs).toISOString());
  const sources=await store.all<SourceRow>("SELECT * FROM sources WHERE enabled=1 AND acquisition='rss' ORDER BY next_poll_at,id LIMIT 20");
  let sourceAttempts=0;
  for(const source of sources) {
   if(sourceAttempts>=LIMITS.sourcesPerRun) break;
   if(now()-start>LIMITS.runMs) break;
   const plan=planSource({id:source.id,enabled:source.enabled,tags:JSON.parse(source.topics_json??'[]')},profiles);
   if(!plan.shouldPoll) continue;
   const interval=plan.intervalMs??LIMITS.pollMs;
   // Retry backoff is authoritative; successful sources follow the current preference cadence.
   if(source.failures>0 && now()<source.next_poll_at) continue;
   // Respect a newly lengthened cadence, but allow newly preferred sources to speed up.
   if(source.last_checked_at!==null && now()<source.last_checked_at+interval) continue;
   sourceAttempts++;
   try {
    await active();
    const adapter=deps.sources.get(source.kind); if(!adapter) throw new Error('unsupported_source');
    const result=await adapter.fetch(source.url,{etag:source.etag,lastModified:source.last_modified});
    if(!result.notModified) {
     // Newest first; missing dates last. Keep an upper bound independent of adapter behavior.
     const items=[...result.items].sort((a,b)=>(Date.parse(b.publishedAt??'')||0)-(Date.parse(a.publishedAt??'')||0)).slice(0,LIMITS.articlesPerFeed);
     for(const [index,item] of items.entries()) {
      if(index%10===0) await active();
      const canonical=await articleId(item.url);
      await store.ingest(canonical.id,{...item,url:canonical.url},source.id,isEligible(item.publishedAt,now(),source.last_success_at!==null),profiles,now());
      stats.items++;
     }
    }
    await active();
    await store.run('UPDATE sources SET etag=?,last_modified=?,last_checked_at=?,last_success_at=?,next_poll_at=?,last_error=NULL,failures=0 WHERE id=?',result.notModified?source.etag:result.etag,result.notModified?source.last_modified:result.lastModified,now(),now(),now()+interval,source.id);
    stats.sources++;
   } catch {
    await active();
    stats.errors++;
    await store.run('UPDATE sources SET last_checked_at=?,next_poll_at=?,failures=failures+1,last_error=? WHERE id=?',now(),now()+Math.min(6*3600000,interval*2**Math.min(source.failures,4)),'source_fetch_failed',source.id);
   }
  }
  if(deps.search) {
   await active();
   try { stats.items+=await runSearch(store,deps.search,profiles,start); } catch { stats.errors++; }
  }
  if(deps.judge) for(const job of await store.jobs(now(),LIMITS.decisionsPerRun)) {
   if(now()-start>LIMITS.runMs) break;
   if(now()-job.discovered_at>LIMITS.ageMs || (job.published_at && now()-Date.parse(job.published_at)>LIMITS.ageMs)) {
    await store.run("UPDATE judgments SET status='skipped',error_code='expired',updated_at=? WHERE id=?",now(),job.id); continue;
   }
   await active();
   const user=await readProfile(store.db,job.user_id);
   if(!user || !sourceAllowed(user,job.source_id)) {
    await store.run("UPDATE judgments SET status='skipped',error_code='profile_policy',updated_at=? WHERE id=? AND status='pending'",now(),job.id); continue;
   }
   if(!await store.claim(job,user,now(),token)) continue;
   stats.decisions++;
   try {
    const d=await deps.judge.evaluate({externalId:job.article_id,url:job.url,title:job.title,summary:job.summary,publishedAt:job.published_at},user);
    const current=await readProfile(store.db,user.id);
    const policy=alertPolicy(current??{...user,enabled:false},job.source_id,d.topics);
    if(!current || current.revision!==user.revision || policy.action!=='allow') {
     await store.run("UPDATE judgments SET status='skipped',decision_json=?,error_code=?,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?",JSON.stringify(d),current?.revision!==user.revision?'profile_changed':policy.reason,now(),job.id,token);
     continue;
    }
    if(d.important && d.shouldPush && d.score>=user.minScore && d.confidence>=user.minConfidence) {
     const payload={version:1,id:job.id,type:'news.alert',userId:user.id,article:{id:job.article_id,title:job.title,url:job.url,publishedAt:job.published_at},decision:d};
     await active();
     await store.accept(job,d,payload,now(),token); stats.accepted++;
    } else await store.run("UPDATE judgments SET status='skipped',decision_json=?,error_code=NULL,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?",JSON.stringify(d),now(),job.id,token);
   } catch {
    stats.errors++;
    await store.run("UPDATE judgments SET status=?,error_code='judge_failed',next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=?",job.attempts+1>=3?'failed':'pending',now()+LIMITS.pollMs*2**job.attempts,now(),job.id,token);
   }
  }
  if(deps.notifier) for(const user of await store.profiles()) {
   const time=localTime(now(),user.timezone);
   if(isQuiet(time.hour,user.quietStart,user.quietEnd) || user.dailyLimit===0) continue;
   const usage=await store.first<{reservations:number}>('SELECT reservations FROM daily_usage WHERE user_id=? AND day=?',user.id,time.day);
   if((usage?.reservations??0)>=user.dailyLimit) continue;
   const pending=await store.all<{id:string;user_id:string;payload_json:string;created_at:number;discovered_at:number;published_at:string|null;profile_json:string;source_id:string;decision_json:string}>(`SELECT o.*,a.discovered_at,a.published_at,a.source_id,j.profile_json,j.decision_json FROM outbox o JOIN judgments j ON j.id=o.judgment_id JOIN articles a ON a.id=j.article_id WHERE o.status='pending' AND o.available_at<=? AND o.user_id=? ORDER BY o.created_at,o.id LIMIT ?`,now(),user.id,Math.min(100,LIMITS.deliveriesPerRun*4));
   // Compare a bounded pool before spending the user's interruption budget.
   pending.sort((a,b)=>((JSON.parse(b.decision_json) as Decision).score+candidatePriority(user,b.source_id,(JSON.parse(b.decision_json) as Decision).topics))-((JSON.parse(a.decision_json) as Decision).score+candidatePriority(user,a.source_id,(JSON.parse(a.decision_json) as Decision).topics)) || a.created_at-b.created_at || a.id.localeCompare(b.id));
   for(const message of pending) {
    if(stats.deliveryAttempts>=LIMITS.deliveriesPerRun || now()-start>LIMITS.runMs) break;
    await active();
    if(now()-message.discovered_at>LIMITS.ageMs || (message.published_at && now()-Date.parse(message.published_at)>LIMITS.ageMs)) {await store.run("UPDATE outbox SET status='suppressed',error_code='expired' WHERE id=?",message.id); continue;}
    const fresh=await readProfile(store.db,user.id);
    const judgedProfile=JSON.parse(message.profile_json) as UserProfile;
    const decision=JSON.parse(message.decision_json) as Decision;
    if(!fresh || !fresh.enabled || (fresh.revision??0)!==(judgedProfile.revision??0) || alertPolicy(fresh,message.source_id,decision.topics).action!=='allow') {
     await store.run("UPDATE outbox SET status='suppressed',error_code='profile_changed' WHERE id=? AND status='pending'",message.id); continue;
    }
    const freshTime=localTime(now(),fresh.timezone);
    if(isQuiet(freshTime.hour,fresh.quietStart,fresh.quietEnd) || fresh.dailyLimit===0) continue;
    if(JSON.stringify(judgedProfile.interests)!==JSON.stringify(user.interests) || JSON.stringify(judgedProfile.excludedTopics)!==JSON.stringify(user.excludedTopics) || judgedProfile.minScore!==user.minScore || judgedProfile.minConfidence!==user.minConfidence) {await store.run("UPDATE outbox SET status='suppressed',error_code='profile_changed' WHERE id=?",message.id);continue;}
    if(!await store.reserve(message.id,fresh.id,freshTime.day,fresh.dailyLimit,fresh.revision,fresh.preferences?.cooldownMinutes??0,now())) continue;
    // Revision is checked atomically at reservation, and once again before network I/O.
    const beforeSend=await readProfile(store.db,fresh.id);
    if(!beforeSend || !beforeSend.enabled || beforeSend.revision!==fresh.revision) {
     await store.run("UPDATE outbox SET status='suppressed',error_code='profile_changed' WHERE id=? AND status='sending'",message.id); continue;
    }
    // Count attempts, not only successes, to keep costs and interruption bounded.
    stats.deliveryAttempts++;
    const outcome=await deps.notifier.send(message.id,JSON.parse(message.payload_json));
    if(outcome==='sent') stats.delivered++;
    await store.run('UPDATE outbox SET status=?,sent_at=?,error_code=? WHERE id=?',outcome,outcome==='sent'?now():null,outcome==='sent'?null:`delivery_${outcome}`,message.id);
   }
  }
  await store.run("UPDATE runs SET finished_at=?,status='completed',stats_json=? WHERE id=?",now(),JSON.stringify(stats),token);
  return stats;
 } catch(error) {
  await store.run("UPDATE runs SET finished_at=?,status='failed',error_code='pipeline_failed' WHERE id=?",now(),token);
  throw new Error('pipeline_failed');
 } finally {await store.unlock(token);}
}
