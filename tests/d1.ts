import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
/** Exercises production SQL against SQLite, no Cloudflare account needed. */
export function createDatabase():{db:D1Database; close:()=>void} {
 const sqlite=new DatabaseSync(':memory:');
 const directory=new URL('../migrations/',import.meta.url);
 for(const file of readdirSync(directory).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file,directory),'utf8'));
 class Statement {
  constructor(readonly sql:string,readonly params:unknown[]=[]){}
  bind(...params:unknown[]){return new Statement(this.sql,params);}
  async first(column?:string) {const row=sqlite.prepare(this.sql).get(...this.params as never[])??null;return column&&row?row[column]:row;}
  async all() {return {results:sqlite.prepare(this.sql).all(...this.params as never[]),success:true,meta:{}};}
  async run() {const r=sqlite.prepare(this.sql).run(...this.params as never[]);return {results:[],success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 }
 const db={prepare:(sql:string)=>new Statement(sql),batch:async(stmts:Statement[])=>{sqlite.exec('BEGIN');try {const results=[];for(const s of stmts)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}},exec:async(sql:string)=>{sqlite.exec(sql);return {count:1,duration:0};}} as unknown as D1Database;
 return {db,close:()=>sqlite.close()};
}
