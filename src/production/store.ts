import {quotaDay, type Job} from './core';

export interface Sql { exec(query: string, ...bindings: any[]): {toArray(): any[]} }
export interface Catchup {cutoff:string;messages:number;allowance:number;remaining:number;completedAt?:number}
export class Ledger {
  constructor(private sql:Sql) {
    sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, stage TEXT NOT NULL, received TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(stage,due,received)');
    sql.exec('CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, id TEXT NOT NULL, stage TEXT NOT NULL, data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS budgets (day TEXT PRIMARY KEY, calls INTEGER NOT NULL, backfill INTEGER NOT NULL)');
  }
  get<T>(key:string,fallback:T):T {const r=this.sql.exec('SELECT value FROM settings WHERE key=?',key).toArray()[0];return r?JSON.parse(r.value):fallback;}
  set(key:string,value:unknown){this.sql.exec('INSERT OR REPLACE INTO settings VALUES (?,?)',key,JSON.stringify(value));}
  job(id:string):Job|undefined {const r=this.sql.exec('SELECT data FROM jobs WHERE id=?',id).toArray()[0];return r?JSON.parse(r.data):undefined;}
  save(job:Job){
    const data=JSON.stringify(job);
    this.sql.exec('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?)',job.id,job.stage,job.receivedAt,job.due,data);
    this.sql.exec('INSERT INTO events(time,id,stage,data) VALUES (?,?,?,?)',job.updatedAt,job.id,job.stage,data);
  }
  counts(){return this.sql.exec('SELECT stage,COUNT(*) AS count FROM jobs GROUP BY stage').toArray();}
  jobs(limit=100){return this.sql.exec('SELECT data FROM jobs ORDER BY json_extract(data,\'$.updatedAt\') DESC LIMIT ?',limit).toArray().map(r=>JSON.parse(r.data) as Job);}
  audit(after:number){return this.sql.exec('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 100',after).toArray();}
  budget(now:number){
    const b=this.sql.exec('SELECT calls,backfill FROM budgets WHERE day=?',quotaDay(now)).toArray()[0]??{calls:0,backfill:0};
    const extra=this.get('catchupUsage:'+quotaDay(now),{calls:0,backfill:0});
    return {...b,catchupCalls:extra.calls,regularCalls:b.calls-extra.calls,regularBackfill:b.backfill-extra.backfill};
  }
  startCatchup(now:number):Catchup {
    const existing=this.get<Catchup|null>('catchup',null);if(existing)return existing;
    const cutoff=new Date(now).toISOString(),since=new Date(now-30*86400_000).toISOString();
    const jobs=this.sql.exec("SELECT data FROM jobs WHERE stage IN ('pending','retry') AND received>=? AND received<=?",since,cutoff).toArray().map(r=>JSON.parse(r.data) as Job).filter(j=>j.attempts<3);
    const allowance=jobs.reduce((sum,j)=>sum+3-j.attempts,0);
    const catchup={cutoff,messages:jobs.length,allowance,remaining:allowance};this.set('catchup',catchup);return catchup;
  }
  finishCatchup(now:number){
    const c=this.get<Catchup|null>('catchup',null);if(!c||c.completedAt)return;
    const unfinished=this.sql.exec("SELECT 1 FROM jobs WHERE stage IN ('pending','retry','classifying','planned','patching','patched','moving','moved','stripping') AND received<=? LIMIT 1",c.cutoff).toArray().length;
    if(!unfinished)this.set('catchup',{...c,remaining:0,completedAt:now});
  }
  reserve(now:number,backfill:boolean,limit:number,receivedAt?:string):boolean {
    const b=this.budget(now);
    const c=this.get<Catchup|null>('catchup',null);
    const extra=!!(c&&c.remaining>0&&receivedAt&&receivedAt<=c.cutoff);
    if(!extra&&(b.regularCalls>=limit || (backfill&&b.regularBackfill>=Math.max(1,Math.floor(limit/2)))))return false;
    // Synchronous read/write inside the single coordinator: no await between budget check and reservation.
    this.sql.exec('INSERT OR REPLACE INTO budgets VALUES (?,?,?)',quotaDay(now),b.calls+1,b.backfill+(backfill?1:0));
    if(extra){
      this.set('catchup',{...c!,remaining:c!.remaining-1});
      const key='catchupUsage:'+quotaDay(now),usage=this.get(key,{calls:0,backfill:0});
      this.set(key,{calls:usage.calls+1,backfill:usage.backfill+(backfill?1:0)});
    }
    return true;
  }
  next(now:number,launchAt:number,limit:number):Job|undefined {
    const recovery=this.sql.exec("SELECT data FROM jobs WHERE stage IN ('planned','patching','patched','moving','moved','stripping','classifying') AND due<=? ORDER BY due LIMIT 1",now).toArray()[0];
    if(recovery)return JSON.parse(recovery.data);
    const b=this.budget(now),c=this.get<Catchup|null>('catchup',null);
    const cutoff=c&&c.remaining>0?c.cutoff:'';
    const earliest=b.regularBackfill>=Math.max(1,Math.floor(limit/2))?new Date(launchAt).toISOString():'';
    const r=this.sql.exec("SELECT data FROM jobs WHERE stage IN ('pending','retry') AND due<=? AND (received<=? OR (? AND received>=?)) ORDER BY received DESC LIMIT 1",now,cutoff,b.regularCalls<limit?1:0,earliest).toArray()[0];return r?JSON.parse(r.data):undefined;
  }
}
