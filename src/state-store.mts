import { privateRecordKey, privateRecordValue } from './provider-services.mjs';
import type { PrivateJson, PrivateRecordKey, PrivateRecord, UniqueProviderRecordStore } from './provider-services.mjs';
import { identifier } from './contracts.mjs';
import { parseExecutionFence } from './execution-journal.mjs';
import type { ExecutionFence } from './execution-journal.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, requireCondition } from './contracts.mjs';
import type { AuthorizationRecord } from './manager.mjs';
import type { HarnessEvent } from './types.mjs';

/** SQLite transactions/WAL release locks on process death. A live coordinator lease
 * prevents two workbenches from managing the same state directory simultaneously. */
export class LocalStateStore {
  #db: DatabaseSync;
  #lease = randomUUID();
  #redact: (text:string)=>string;
  #status: 'healthy'|'failed' = 'healthy';
  #auditQueue: string[]=[];
  #jobs: unknown[]|undefined;
  #timer: ReturnType<typeof setTimeout>|undefined;
  #closed=false;
  static async open(directory:string,redact:(text:string)=>string=text=>text):Promise<LocalStateStore>{
    await mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,'control.sqlite');const handle=await open(file,'a',0o600);await handle.close();
    return new LocalStateStore(file,redact);
  }
  private constructor(file:string,redact:(text:string)=>string){
    this.#redact=redact;this.#db=new DatabaseSync(file);
    try{
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS authorization(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(reference TEXT PRIMARY KEY,revoked INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS rpc(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT,completed INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL);');
      this.#db.exec('BEGIN IMMEDIATE');
      const owner=this.#db.prepare('SELECT pid FROM lease WHERE id=1').get() as {pid:number}|undefined;
      let alive=false;
      if(owner){try{process.kill(owner.pid,0);alive=true;}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ESRCH'))alive=true;}}
      requireCondition(!alive,'STATE_IN_USE','Another coordinator owns this state directory');
      this.#db.prepare('INSERT OR REPLACE INTO lease(id,pid,token) VALUES(1,?,?)').run(process.pid,this.#lease);
      this.#db.exec('COMMIT');
      this.#db.exec('CREATE TABLE IF NOT EXISTS executions(instance_id TEXT NOT NULL,run_id TEXT NOT NULL,token TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(instance_id,run_id))');
      this.#db.exec('CREATE TABLE IF NOT EXISTS provider_records(provider TEXT NOT NULL,instance_id TEXT NOT NULL,run_id TEXT NOT NULL,generation TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(provider,instance_id,run_id,generation))');
      this.#db.exec('CREATE TABLE IF NOT EXISTS provider_run_reservations(provider TEXT NOT NULL,instance_id TEXT NOT NULL,run_id TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(provider,instance_id,run_id))');
      const columns=this.#db.prepare('PRAGMA table_info(rpc)').all() as {name:string}[];
      if(!columns.some(c=>c.name==='completed'))this.#db.exec('ALTER TABLE rpc ADD COLUMN completed INTEGER NOT NULL DEFAULT 0');
      this.#db.exec('UPDATE rpc SET completed=1 WHERE response IS NOT NULL');
    }catch(error){try{this.#db.exec('ROLLBACK');}catch{}try{this.#db.prepare('DELETE FROM lease WHERE token=?').run(this.#lease);}catch{}this.#db.close();throw error;}
  }
  status(){return {status:this.#status,pendingAudit:this.#auditQueue.length};}
  authorizations():Record<string,AuthorizationRecord>{
    const rows=this.#db.prepare('SELECT id,value FROM authorization').all() as {id:string;value:string}[];
    return Object.fromEntries(rows.map(row=>[row.id,JSON.parse(row.value) as AuthorizationRecord]));
  }
  async saveAuthorization(id:string,value:AuthorizationRecord):Promise<void>{
    try{
      this.#assertLease();this.#db.exec('BEGIN IMMEDIATE');
      this.#db.prepare('INSERT OR REPLACE INTO authorization(id,value) VALUES(?,?)').run(id,this.#redact(JSON.stringify(value)));
      this.#db.prepare('INSERT INTO audit(value) VALUES(?)').run(JSON.stringify({at:new Date().toISOString(),type:'authorization.updated',instanceId:id}));
      this.#db.exec('DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT 5000); COMMIT');
    }catch{try{this.#db.exec('ROLLBACK');}catch{}this.#status='failed';throw new HarnessError('STATE_WRITE_FAILED','Authorization was not durably saved');}
  }
  executionFences():ExecutionFence[]{
    this.#assertLease();return (this.#db.prepare('SELECT value FROM executions').all() as {value:string}[]).map(row=>parseExecutionFence(JSON.parse(row.value)));
  }
  saveExecution(record:ExecutionFence):undefined{
    try{
      this.#assertLease();const value=parseExecutionFence(record);this.#db.exec('BEGIN IMMEDIATE');
      const existing=this.#db.prepare('SELECT token FROM executions WHERE instance_id=? AND run_id=?').get(value.instanceId,value.runId) as {token:string}|undefined;
      requireCondition(!existing||existing.token===value.token,'EXECUTION_CONFLICT','Execution identity changed');
      requireCondition(Boolean(existing)||(this.#db.prepare('SELECT count(*) AS n FROM executions').get() as {n:number}).n<5000,'EXECUTION_LEDGER_FULL','Execution ledger is full');
      this.#db.prepare('INSERT OR REPLACE INTO executions(instance_id,run_id,token,value) VALUES(?,?,?,?)').run(value.instanceId,value.runId,value.token,JSON.stringify(value));
      this.#db.prepare('INSERT INTO audit(value) VALUES(?)').run(JSON.stringify({at:new Date().toISOString(),type:'execution.'+value.status,instanceId:value.instanceId,runId:value.runId,actor:value.acknowledgedBy}));
      this.#db.exec('DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT 5000); COMMIT');
    }catch(error){try{this.#db.exec('ROLLBACK');}catch{}this.#status='failed';throw error instanceof HarnessError?error:new HarnessError('STATE_WRITE_FAILED','Execution journal not committed');}
  }
  removeExecution(record:ExecutionFence,evidence:'normal-settlement'|'provider-confirmed'):undefined{
    try{
      this.#assertLease();this.#db.exec('BEGIN IMMEDIATE');
      const existing=this.#db.prepare('SELECT token FROM executions WHERE instance_id=? AND run_id=?').get(record.instanceId,record.runId) as {token:string}|undefined;
      requireCondition(existing?.token===record.token,'EXECUTION_CONFLICT','Execution identity changed');
      this.#db.prepare('DELETE FROM executions WHERE instance_id=? AND run_id=? AND token=?').run(record.instanceId,record.runId,record.token);
      this.#db.prepare('INSERT INTO audit(value) VALUES(?)').run(JSON.stringify({at:new Date().toISOString(),type:'execution.'+evidence,instanceId:record.instanceId,runId:record.runId}));
      this.#db.exec('DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT 5000); COMMIT');
    }catch(error){try{this.#db.exec('ROLLBACK');}catch{}this.#status='failed';throw error instanceof HarnessError?error:new HarnessError('STATE_WRITE_FAILED','Execution settlement not committed');}
  }
  /** Trusted adapter-only capability. Excluded from jobs, snapshots, audit and RPC. */
  providerRecords(providerId:string):UniqueProviderRecordStore {
    const provider=identifier(providerId,'providerId');
    return {
      read:key=>{
        this.#assertLease();const k=privateRecordKey(key);
        const row=this.#db.prepare('SELECT revision,value FROM provider_records WHERE provider=? AND instance_id=? AND run_id=? AND generation=?').get(provider,k.instanceId,k.runId,k.generation) as {revision:number;value:string}|undefined;
        return row?{key:k,revision:row.revision,value:privateRecordValue(JSON.parse(row.value),this.#redact)}:undefined;
      },
      lookupRun:(instanceId,runId)=>{
        this.#assertLease();identifier(instanceId,'instanceId');identifier(runId,'runId');
        const rows=this.#db.prepare('SELECT generation,revision,value FROM provider_records WHERE provider=? AND instance_id=? AND run_id=? LIMIT 2').all(provider,instanceId,runId) as {generation:string;revision:number;value:string}[];
        const claimed=this.#db.prepare('SELECT generation FROM provider_run_reservations WHERE provider=? AND instance_id=? AND run_id=?').get(provider,instanceId,runId) as {generation:string}|undefined;
        if(rows.length===0)return {status:claimed?'ambiguous':'none'};
        if(rows.length!==1||(claimed&&claimed.generation!==rows[0]!.generation))return {status:'ambiguous'};
        const row=rows[0]!;return {status:'unique',record:{key:privateRecordKey({instanceId,runId,generation:row.generation}),revision:row.revision,value:privateRecordValue(JSON.parse(row.value),this.#redact)}};
      },
      reserveRun:(key,value)=>this.#writePrivate(provider,key,null,value,true),
      write:(key,revision,value)=>this.#writePrivate(provider,key,revision,value,false),
    };
  }
  #writePrivate(provider:string,key:PrivateRecordKey,expectedRevision:number|null,value:PrivateJson,reserve:boolean):PrivateRecord {
    this.#assertLease();const k=privateRecordKey(key),safe=privateRecordValue(value,this.#redact);
    requireCondition(expectedRevision===null||(Number.isSafeInteger(expectedRevision)&&expectedRevision>0&&expectedRevision<Number.MAX_SAFE_INTEGER),'PRIVATE_RECORD_CONFLICT','Invalid expected revision');
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const claimed=this.#db.prepare('SELECT generation FROM provider_run_reservations WHERE provider=? AND instance_id=? AND run_id=?').get(provider,k.instanceId,k.runId) as {generation:string}|undefined;
      if(reserve){
        const prior=this.#db.prepare('SELECT 1 FROM provider_records WHERE provider=? AND instance_id=? AND run_id=? LIMIT 1').get(provider,k.instanceId,k.runId);
        requireCondition(!claimed&&!prior,'PRIVATE_RUN_EXISTS','Public execution identity is already retained');
        requireCondition((this.#db.prepare('SELECT count(*) AS n FROM provider_run_reservations').get() as {n:number}).n<5000,'PRIVATE_RECORD_FULL','Private reservation ledger is full');
        this.#db.prepare('INSERT INTO provider_run_reservations(provider,instance_id,run_id,generation) VALUES(?,?,?,?)').run(provider,k.instanceId,k.runId,k.generation);
      }else requireCondition(!claimed||claimed.generation===k.generation,'PRIVATE_RUN_EXISTS','Another generation owns this public execution');
      const old=this.#db.prepare('SELECT revision FROM provider_records WHERE provider=? AND instance_id=? AND run_id=? AND generation=?').get(provider,k.instanceId,k.runId,k.generation) as {revision:number}|undefined;
      requireCondition(reserve||!claimed||old,'PRIVATE_RUN_EXISTS','A retained reservation cannot recreate a missing mapping');
      requireCondition((old?.revision??null)===expectedRevision,'PRIVATE_RECORD_CONFLICT','Private record changed');
      requireCondition(Boolean(old)||(this.#db.prepare('SELECT count(*) AS n FROM provider_records').get() as {n:number}).n<5000,'PRIVATE_RECORD_FULL','Private ledger is full; records are never automatically evicted');
      const revision=(expectedRevision??0)+1;
      this.#db.prepare('INSERT OR REPLACE INTO provider_records(provider,instance_id,run_id,generation,revision,value) VALUES(?,?,?,?,?,?)').run(provider,k.instanceId,k.runId,k.generation,revision,JSON.stringify(safe));
      this.#db.exec('COMMIT');return {key:k,revision,value:safe};
    }catch(error){try{this.#db.exec('ROLLBACK');}catch{}if(error instanceof HarnessError)throw error;this.#status='failed';throw new HarnessError('STATE_WRITE_FAILED','Private provider record was not committed');}
  }
  credentialRevocations():string[]{return (this.#db.prepare('SELECT reference FROM credentials WHERE revoked=1').all() as {reference:string}[]).map(row=>row.reference);}
  async setCredentialRevoked(reference:string,revoked:boolean):Promise<void>{
    this.#assertLease();try{this.#db.prepare('INSERT OR REPLACE INTO credentials(reference,revoked) VALUES(?,?)').run(reference,revoked?1:0);}catch{this.#status='failed';throw new HarnessError('STATE_WRITE_FAILED','Credential state not saved');}
  }
  reserveRpc(id:string,fingerprint:string):{response?:string;pending?:boolean;expired?:boolean}{
    this.#assertLease();const old=this.#db.prepare('SELECT fingerprint,response,completed FROM rpc WHERE id=?').get(id) as {fingerprint:string;response:string|null;completed:number}|undefined;
    if(old){requireCondition(old.fingerprint===fingerprint,'RPC_CONFLICT','Request ID reused with different parameters');return old.response?{response:old.response}:old.completed?{expired:true}:{pending:true};}
    requireCondition((this.#db.prepare('SELECT count(*) AS n FROM rpc').get() as {n:number}).n<50000,'RPC_LEDGER_FULL','Request tombstone ledger is full; explicit state migration required');
    this.#db.prepare('INSERT INTO rpc(id,fingerprint) VALUES(?,?)').run(id,fingerprint);return {};
  }
  finishRpc(id:string,response:string):void{try{this.#db.prepare('UPDATE rpc SET response=?,completed=1 WHERE id=?').run(this.#redact(response),id);this.#db.exec('UPDATE rpc SET response=NULL WHERE completed=1 AND id NOT IN (SELECT id FROM rpc WHERE response IS NOT NULL ORDER BY rowid DESC LIMIT 512)');}catch{this.#status='failed';throw new HarnessError('STATE_WRITE_FAILED','RPC response not saved');}}
  restoredJobs():unknown[]{
    const row=this.#db.prepare('SELECT value FROM jobs WHERE id=1').get() as {value:string}|undefined;
    if(!row)return [];
    const jobs:unknown=JSON.parse(row.value);requireCondition(Array.isArray(jobs)&&jobs.length<=100,'STATE_INVALID','Invalid saved job history');
    return jobs.map(raw=>{
      requireCondition(raw&&typeof raw==='object','STATE_INVALID','Invalid saved job');
      const job=raw as Record<string,unknown>;
      const settled=job.executionState==='settled'||job.executionState==='not-admitted'||(job.executionState===undefined&&job.state==='completed');
      return {...job,recovered:!settled,executionState:settled?(job.executionState??'settled'):'unknown',...(job.state==='running'?{state:'interrupted',text:'COORDINATOR_RESTARTED'}:{})};
    });
  }
  commitJobs(jobs:unknown[]):void{
    try{this.#assertLease();this.#db.prepare('INSERT OR REPLACE INTO jobs(id,value) VALUES(1,?)').run(this.#redact(JSON.stringify(jobs.slice(-100))));this.#jobs=undefined;}
    catch{this.#status='failed';throw new HarnessError('STATE_WRITE_FAILED','Task admission was not saved; task was not dispatched');}
  }
  saveJobs(jobs:unknown[]):void{this.#jobs=jobs.slice(-100);this.#schedule();}
  record(event:HarnessEvent):void{
    // Never retain prompts, headers, result previews or credential values in audit.
    const raw=(event.type==='provider.progress'||event.type==='run.progress.v2')&&event.data&&typeof event.data==='object'?event.data as Record<string,unknown>:undefined;
    if(event.type==='provider.progress'&&raw?.kind!=='tool')return;
    if(event.type==='run.progress.v2'&&!['tool.started','tool.finished'].includes(String(raw?.kind)))return;
    const value=this.#redact(JSON.stringify({at:event.at,type:event.type,instanceId:event.instanceId,generation:event.generation,runId:event.runId,sequence:event.sequence,subject:event.subject,permissions:event.permissions,tools:event.tools,publicationRevision:event.publicationRevision,
      ...(raw?{tool:String(raw.name).slice(0,128),status:raw.kind==='tool.started'?'running':String(raw.status).slice(0,64)}:{})}));
    if(this.#auditQueue.length>=1000){this.#status='failed';return;}
    this.#auditQueue.push(value);this.#schedule();
  }
  recordControl(value:{type:string;requestId?:string;method?:string;instanceId?:string;status?:number}):void{if(this.#auditQueue.length>=1000){this.#status='failed';return;}this.#auditQueue.push(this.#redact(JSON.stringify({at:new Date().toISOString(),...value})));this.#schedule();}
  #schedule(){if(this.#closed)return;if(!this.#timer){this.#timer=setTimeout(()=>{this.#timer=undefined;this.flush();},50);this.#timer.unref();}}
  #assertLease(){
    requireCondition(!this.#closed,'STATE_CLOSED','State store is closed');
    const row=this.#db.prepare('SELECT token FROM lease WHERE id=1').get() as {token:string}|undefined;
    requireCondition(row?.token===this.#lease,'STATE_LEASE_LOST','Coordinator lease changed');
  }
  flush():void{
    if(this.#closed)return;
    const events=this.#auditQueue.splice(0),jobs=this.#jobs;this.#jobs=undefined;
    try{
      this.#assertLease();this.#db.exec('BEGIN IMMEDIATE');
      const insert=this.#db.prepare('INSERT INTO audit(value) VALUES(?)');for(const event of events)insert.run(event);
      if(jobs)this.#db.prepare('INSERT OR REPLACE INTO jobs(id,value) VALUES(1,?)').run(this.#redact(JSON.stringify(jobs)));
      this.#db.exec('DELETE FROM audit WHERE seq NOT IN (SELECT seq FROM audit ORDER BY seq DESC LIMIT 5000); COMMIT');
    }catch{try{this.#db.exec('ROLLBACK');}catch{}this.#status='failed';}
  }
  audit(limit=100):unknown[]{return (this.#db.prepare('SELECT value FROM audit ORDER BY seq DESC LIMIT ?').all(Math.min(5000,Math.max(1,limit))) as {value:string}[]).map(row=>JSON.parse(row.value));}
  close():void{
    if(this.#closed)return;clearTimeout(this.#timer);this.flush();
    try{this.#db.prepare('DELETE FROM lease WHERE id=1 AND token=?').run(this.#lease);}finally{this.#closed=true;this.#db.close();}
  }
}
