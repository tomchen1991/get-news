import type { NewsItem, UserProfile } from './types';
import type { SourceConfig } from './config';
export interface SourceRow extends Omit<SourceConfig,'enabled'> { enabled:number; etag:string|null; last_modified:string|null; last_success_at:number|null; failures:number }
export interface JobRow { id:string; article_id:string; user_id:string; attempts:number; url:string; title:string; summary:string; published_at:string|null; discovered_at:number }
export interface OutboxRow {id:string;user_id:string;payload_json:string;created_at:number}
export class Store {
 constructor(readonly db:D1Database) {}
 async all<T>(sql:string,...args:unknown[]):Promise<T[]> { return (await this.db.prepare(sql).bind(...args).all<T>()).results; }
 async first<T>(sql:string,...args:unknown[]):Promise<T|null> { return this.db.prepare(sql).bind(...args).first<T>(); }
 async run(sql:string,...args:unknown[]):Promise<number> { return (await this.db.prepare(sql).bind(...args).run()).meta.changes; }
 async lock(token:string,now:number,duration:number):Promise<boolean> {
  return (await this.run(`INSERT INTO locks(id,token,until_at) VALUES('poll',?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,until_at=excluded.until_at WHERE locks.until_at <= ?`,token,now+duration,now)) === 1;
 }
 async unlock(token:string):Promise<void> { await this.run("DELETE FROM locks WHERE id='poll' AND token=?",token); }
 async profiles():Promise<UserProfile[]> {
  const rows=await this.all<Record<string,unknown>>('SELECT * FROM users WHERE enabled=1 ORDER BY id');
  return rows.map(r=>({id:String(r.id),name:String(r.name),interests:JSON.parse(String(r.interests_json)),excludedTopics:JSON.parse(String(r.excluded_topics_json)),minScore:Number(r.min_score),minConfidence:Number(r.min_confidence),dailyLimit:Number(r.daily_limit),timezone:String(r.timezone),quietStart:Number(r.quiet_start),quietEnd:Number(r.quiet_end),enabled:!!r.enabled}));
 }
 async saveProfile(p:UserProfile):Promise<void> {
  await this.run(`INSERT INTO users(id,name,interests_json,excluded_topics_json,min_score,min_confidence,daily_limit,timezone,quiet_start,quiet_end,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,interests_json=excluded.interests_json,excluded_topics_json=excluded.excluded_topics_json,min_score=excluded.min_score,min_confidence=excluded.min_confidence,daily_limit=excluded.daily_limit,timezone=excluded.timezone,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,enabled=excluded.enabled`,p.id,p.name,JSON.stringify(p.interests),JSON.stringify(p.excludedTopics),p.minScore,p.minConfidence,p.dailyLimit,p.timezone,p.quietStart,p.quietEnd,+p.enabled);
 }
 async saveSource(s:SourceConfig):Promise<void> {
  await this.run(`INSERT INTO sources(id,name,kind,url,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,url=excluded.url,enabled=excluded.enabled,etag=NULL,last_modified=NULL,next_poll_at=0,last_success_at=CASE WHEN sources.url=excluded.url THEN sources.last_success_at ELSE NULL END`,s.id,s.name,s.kind,s.url,+s.enabled);
 }
 async ingest(id:string,item:NewsItem,sourceId:string,eligible:boolean,users:UserProfile[],now:number):Promise<void> {
  const statements=[this.db.prepare('INSERT OR IGNORE INTO articles(id,source_id,external_id,url,title,summary,published_at,discovered_at,eligible) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,sourceId,item.externalId,item.url,item.title,item.summary,item.publishedAt,now,+eligible)];
  if(eligible && users.length) statements.push(this.db.prepare(`INSERT OR IGNORE INTO judgments(id,article_id,user_id,created_at,updated_at) SELECT u.id || ':' || a.id,a.id,u.id,?,? FROM articles a JOIN users u ON u.enabled=1 WHERE a.id=? AND a.eligible=1 AND a.discovered_at >= ?`).bind(now,now,id,now-86400000));
  await this.db.batch(statements);
 }
 async jobs(now:number,limit:number):Promise<JobRow[]> {
  return this.all<JobRow>(`SELECT j.id,j.article_id,j.user_id,j.attempts,a.url,a.title,a.summary,a.published_at,a.discovered_at FROM judgments j JOIN articles a ON a.id=j.article_id JOIN users u ON u.id=j.user_id WHERE u.enabled=1 AND j.attempts<3 AND ((j.status='pending' AND j.next_attempt_at<=?) OR (j.status='processing' AND j.lease_until<=?)) ORDER BY j.created_at,j.id LIMIT ?`,now,now,limit);
 }
 async claim(job:JobRow,profile:UserProfile,now:number,token:string):Promise<boolean> {
  return (await this.run(`UPDATE judgments SET status='processing',attempts=attempts+1,lease_until=?,updated_at=?,profile_json=?,claim_token=? WHERE id=? AND attempts<3 AND ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND lease_until<=?)) AND EXISTS(SELECT 1 FROM locks WHERE id='poll' AND token=? AND until_at>?)`,now+120000,now,JSON.stringify(profile),token,job.id,now,now,token,now))===1;
 }
 async accept(job:JobRow,decision:unknown,payload:unknown,now:number,token:string):Promise<void> {
  await this.db.batch([
   this.db.prepare("UPDATE judgments SET status='accepted',decision_json=?,error_code=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='processing' AND claim_token=?").bind(JSON.stringify(decision),now,job.id,token),
   this.db.prepare(`INSERT OR IGNORE INTO outbox(id,judgment_id,user_id,payload_json,created_at) SELECT id,id,user_id,?,? FROM judgments WHERE id=? AND status='accepted' AND claim_token=?`).bind(JSON.stringify(payload),now,job.id,token)
  ]);
 }
 async reserve(id:string,userId:string,day:string,limit:number):Promise<boolean> {
  // D1 batch is transactional. Increment only after reserving an eligible outbox row.
  const result=await this.db.batch([
   this.db.prepare('INSERT OR IGNORE INTO daily_usage(user_id,day,reservations) VALUES(?,?,0)').bind(userId,day),
   this.db.prepare(`UPDATE outbox SET status='sending',reserved_day=? WHERE id=? AND status='pending' AND (SELECT reservations FROM daily_usage WHERE user_id=? AND day=?)<?`).bind(day,id,userId,day,limit),
   this.db.prepare(`UPDATE daily_usage SET reservations=reservations+1 WHERE user_id=? AND day=? AND changes()=1`).bind(userId,day)
  ]);
  return result[1].meta.changes===1;
 }
}
