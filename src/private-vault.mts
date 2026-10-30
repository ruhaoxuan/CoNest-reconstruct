import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { mkdir, open, lstat } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { freeze, HarnessError, identifier, requireCondition } from './contracts.mjs';
import { canonical } from './publication.mjs';
import { localReference } from './provider-services.mjs';
import type { PrivateLease, PrivateReferenceService } from './provider-services.mjs';
import type { CredentialEpochStore } from './credential-epochs.mjs';
export interface DurablePrivateReferences<T> extends PrivateReferenceService<T> {
  register(reference:`local:${string}`,value:T):PrivateLease<T>;
  replace(reference:`local:${string}`,value:T):PrivateLease<T>;
  revoke(reference:`local:${string}`):void;
}
export interface ScopedSecretLease {
  readonly ownerLease:string;
  readonly subjectLease:string;
  readonly epoch:string;
}
export interface ScopedSecretStore {
  load(ownerLease:string,subjectLease:string):string|undefined;
  store(ownerLease:string,subjectLease:string,value:string):undefined;
  acquire(ownerLease:string,subjectLease:string):ScopedSecretLease|undefined;
  assertActive(lease:ScopedSecretLease):void;
  revoke(ownerLease:string,subjectLease:string):undefined;
  subscribe(listener:(ownerLease:string,subjectLease:string)=>void):()=>void;
}
type RefRow={lease:string;value:string|null;active:number};
type SecretRow={value:string|null;epoch:string;revoked:number};
type CredentialRow={epoch:string;verifier:string|null;revoked:number};
const denied=(code:string)=>new HarnessError(code,'Private state operation refused: '+code);
function json(value:unknown):string {
  let nodes=0;
  const visit=(v:unknown,depth:number):void=>{
    requireCondition(++nodes<=2048&&depth<=12,'PRIVATE_VALUE_INVALID','Private value exceeds nesting or node limit');
    if(v===null||typeof v==='boolean')return;
    if(typeof v==='string'){requireCondition(Buffer.byteLength(v)<=16384,'PRIVATE_VALUE_INVALID','Private text exceeds limit');return;}
    if(typeof v==='number'){requireCondition(Number.isFinite(v),'PRIVATE_VALUE_INVALID','Non-finite private number');return;}
    requireCondition(v&&typeof v==='object'&&(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null),'PRIVATE_VALUE_INVALID','Private values must be JSON');
    requireCondition(Object.keys(v).length<=128,'PRIVATE_VALUE_INVALID','Too many private fields');
    if(Array.isArray(v))requireCondition(Object.keys(v).length===v.length&&Object.keys(v).every((key,index)=>key===String(index)),'PRIVATE_VALUE_INVALID','Private arrays must be dense JSON arrays');
    for(const [key,item] of Object.entries(v)){requireCondition(key.length<=128&&!['__proto__','constructor','prototype'].includes(key),'PRIVATE_VALUE_INVALID','Unsafe private field');visit(item,depth+1);}
  };
  visit(value,0);const text=canonical(value);requireCondition(Buffer.byteLength(text)<=65536,'PRIVATE_VALUE_INVALID','Private value exceeds 64KiB');return text;
}
/** Entry-owned private storage, not part of control.sqlite, public RPC or execution records.
 * Values are permission-protected plaintext, not OS-keychain encryption or a hostile-local-user sandbox. */
export class LocalPrivateVault {
  #db:DatabaseSync;
  #owner=randomUUID();
  #closed=false;
  #failed=false;
  #key:string;
  #remember:(value:string)=>void;
  #listeners=new Map<string,Set<(owner:string,subject:string)=>void>>();
  static async open(directory:string,options:{readonly remember:(value:string)=>void}):Promise<LocalPrivateVault> {
    requireCondition(path.isAbsolute(directory)&&typeof options.remember==='function','PRIVATE_VAULT_PATH','An absolute private directory and redactor are required');
    await mkdir(directory,{recursive:true,mode:0o700});
    const dir=await lstat(directory);
    requireCondition(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0&&(process.getuid===undefined||dir.uid===process.getuid()),'PRIVATE_VAULT_PERMISSIONS','Private directory must be owner-only');
    const file=path.join(directory,'private.sqlite');let fresh=false;
    let handle;
    try{handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);fresh=true;}
    catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw denied('PRIVATE_VAULT_PATH');handle=await open(file,constants.O_RDWR|constants.O_NOFOLLOW).catch(()=>{throw denied('PRIVATE_VAULT_PATH');});}
    try{const stat=await handle.stat();requireCondition(stat.isFile()&&stat.nlink===1&&(stat.mode&0o077)===0&&(process.getuid===undefined||stat.uid===process.getuid()),'PRIVATE_VAULT_PERMISSIONS','Private file must be owner-only and unshared');}finally{await handle.close();}
    return new LocalPrivateVault(file,fresh,options.remember);
  }
  private constructor(file:string,fresh:boolean,remember:(value:string)=>void) {
    this.#remember=remember;this.#db=new DatabaseSync(file);this.#key='';
    try{
      if(!fresh){
        const marker=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_meta'").get();
        requireCondition(marker,'PRIVATE_VAULT_INVALID','Unrecognized or incomplete private database');
        const meta=this.#db.prepare('SELECT kind,hmac_key FROM vault_meta WHERE id=1').get() as {kind:string;hmac_key:string}|undefined;
        requireCondition(meta?.kind==='conest-private-v1'&&/^[a-f0-9]{64}$/.test(meta.hmac_key),'PRIVATE_VAULT_INVALID','Invalid private database marker');this.#key=meta.hmac_key;
      }
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      if(fresh){
        this.#key=randomBytes(32).toString('hex');this.#db.exec('BEGIN IMMEDIATE; CREATE TABLE vault_meta(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,hmac_key TEXT NOT NULL); CREATE TABLE vault_owner(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL); CREATE TABLE private_refs(namespace TEXT NOT NULL,reference TEXT NOT NULL,lease TEXT NOT NULL UNIQUE,value TEXT,active INTEGER NOT NULL,PRIMARY KEY(namespace,reference)); CREATE TABLE scoped_secrets(namespace TEXT NOT NULL,owner TEXT NOT NULL,subject TEXT NOT NULL,value TEXT,epoch TEXT NOT NULL,revoked INTEGER NOT NULL,PRIMARY KEY(namespace,owner,subject)); CREATE TABLE credential_epochs(reference TEXT PRIMARY KEY,epoch TEXT NOT NULL,verifier TEXT,revoked INTEGER NOT NULL);');
        this.#db.prepare('INSERT INTO vault_meta(id,kind,hmac_key) VALUES(1,?,?)').run('conest-private-v1',this.#key);this.#db.exec('COMMIT');
      }
      this.#db.exec('BEGIN IMMEDIATE');
      const owner=this.#db.prepare('SELECT pid FROM vault_owner WHERE id=1').get() as {pid:number}|undefined;
      let alive=false;if(owner){try{process.kill(owner.pid,0);alive=true;}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='ESRCH')alive=true;}}
      requireCondition(!alive,'PRIVATE_VAULT_IN_USE','Another coordinator owns the private database');
      this.#db.prepare('INSERT OR REPLACE INTO vault_owner(id,pid,token) VALUES(1,?,?)').run(process.pid,this.#owner);this.#db.exec('COMMIT');
    }catch(error){try{this.#db.exec('ROLLBACK');}catch{}this.#db.close();throw error instanceof HarnessError?error:denied('PRIVATE_VAULT_INVALID');}
  }
  #assertOwner():void {
    requireCondition(!this.#closed,'PRIVATE_VAULT_CLOSED','Private database is closed');requireCondition(!this.#failed,'PRIVATE_VAULT_FAILED','Private database needs operator review');
    try{const row=this.#db.prepare('SELECT token FROM vault_owner WHERE id=1').get() as {token:string}|undefined;requireCondition(row?.token===this.#owner,'PRIVATE_VAULT_LEASE_LOST','Private coordinator lease changed');}
    catch(error){throw error instanceof HarnessError?error:denied('PRIVATE_VAULT_INVALID');}
  }
  #transaction<T>(work:()=>T):T {
    this.#assertOwner();try{this.#db.exec('BEGIN IMMEDIATE');const result=work();this.#db.exec('COMMIT');return result;}
    catch(error){try{this.#db.exec('ROLLBACK');}catch{}if(error instanceof HarnessError)throw error;this.#failed=true;throw denied('PRIVATE_VAULT_WRITE_FAILED');}
  }
  #ref(namespace:string,reference:string):RefRow|undefined {
    this.#assertOwner();localReference(reference);try{return this.#db.prepare('SELECT lease,value,active FROM private_refs WHERE namespace=? AND reference=?').get(namespace,reference) as RefRow|undefined;}catch{throw denied('PRIVATE_VAULT_INVALID');}
  }
  #activeLease(lease:string):void {
    identifier(lease,'private lease');const row=this.#db.prepare('SELECT active FROM private_refs WHERE lease=?').get(lease) as {active:number}|undefined;requireCondition(row?.active===1,'PRIVATE_LEASE_STALE','Private scope was replaced or revoked');
  }
  #secret(namespace:string,owner:string,subject:string):SecretRow|undefined {
    this.#assertOwner();this.#activeLease(owner);this.#activeLease(subject);
    try{return this.#db.prepare('SELECT value,epoch,revoked FROM scoped_secrets WHERE namespace=? AND owner=? AND subject=?').get(namespace,owner,subject) as SecretRow|undefined;}catch{throw denied('PRIVATE_VAULT_INVALID');}
  }
  #note(value:string):void {try{const result:unknown=this.#remember(value);if(result!==undefined){if(result&&typeof result==='object'&&'then'in result)void Promise.resolve(result).catch(()=>{});throw denied('PRIVATE_REDACTION_FAILED');}}catch{throw denied('PRIVATE_REDACTION_FAILED');}}
  references<T>(namespace:string,options:{readonly secretValues:(value:T)=>readonly string[]}):DurablePrivateReferences<T> {
    this.#assertOwner();identifier(namespace,'private namespace');requireCondition(typeof options.secretValues==='function','PRIVATE_VALUE_INVALID','Declare private redaction values');
    const issued=new WeakSet<object>();
    const note=(value:T)=>{let values:readonly string[];try{values=options.secretValues(value);}catch{throw denied('PRIVATE_VALUE_INVALID');}requireCondition(Array.isArray(values)&&values.length<=128,'PRIVATE_VALUE_INVALID','Invalid redaction registration');for(const secret of values){requireCondition(typeof secret==='string'&&secret.length>=8&&secret.length<=16384,'PRIVATE_VALUE_INVALID','Invalid secret registration');this.#note(secret);}};
    const acquire=(reference:`local:${string}`):PrivateLease<T>=>{
      const row=this.#ref(namespace,reference);requireCondition(row&&row.active===1&&row.value!==null,'PRIVATE_REFERENCE_DENIED','Private reference is unavailable');
      let value:T;try{value=JSON.parse(row.value) as T;json(value);}catch{throw denied('PRIVATE_VAULT_INVALID');}note(value);
      const result=freeze({reference,lease:row.lease,value});issued.add(result);return result;
    };
    return {
      acquire,
      assertActive:lease=>{requireCondition(issued.has(lease),'PRIVATE_LEASE_STALE','Unissued private lease');const row=this.#ref(namespace,lease.reference);requireCondition(row?.active===1&&row.lease===lease.lease,'PRIVATE_LEASE_STALE','Private reference changed');},
      register:(reference,value)=>{
        localReference(reference);const text=json(value);note(value);
        this.#transaction(()=>{const old=this.#ref(namespace,reference);if(old){requireCondition(old.active===1&&old.value===text,'PRIVATE_REFERENCE_CONFLICT','Use explicit replacement for a changed or revoked identity');return;}
          requireCondition((this.#db.prepare('SELECT count(*) AS n FROM private_refs').get() as {n:number}).n<256,'PRIVATE_VAULT_FULL','Private reference capacity exhausted');
          this.#db.prepare('INSERT INTO private_refs(namespace,reference,lease,value,active) VALUES(?,?,?,?,1)').run(namespace,reference,randomUUID(),text);
        });return acquire(reference);
      },
      replace:(reference,value)=>{
        localReference(reference);const text=json(value);note(value);
        this.#transaction(()=>{requireCondition(this.#ref(namespace,reference),'PRIVATE_REFERENCE_DENIED','Replacement requires an existing reference');this.#db.prepare('UPDATE private_refs SET lease=?,value=?,active=1 WHERE namespace=? AND reference=?').run(randomUUID(),text,namespace,reference);});return acquire(reference);
      },
      revoke:reference=>{this.#transaction(()=>{const old=this.#ref(namespace,reference);requireCondition(old,'PRIVATE_REFERENCE_DENIED','Unknown private reference');this.#db.prepare('UPDATE private_refs SET active=0,value=NULL WHERE namespace=? AND reference=?').run(namespace,reference);});},
    };
  }
  scopedSecrets(namespace:string):ScopedSecretStore {
    this.#assertOwner();identifier(namespace,'private namespace');const issued=new WeakSet<object>();
    const notify=(owner:string,subject:string)=>{for(const listener of this.#listeners.get(namespace)??[]){try{void Promise.resolve(listener(owner,subject)).catch(()=>{});}catch{}}};
    return {
      load:(owner,subject)=>{const row=this.#secret(namespace,owner,subject);if(!row)return undefined;requireCondition(!row.revoked,'CREDENTIAL_REVOKED','Scoped credential was explicitly revoked');requireCondition(typeof row.value==='string','PRIVATE_VAULT_INVALID','Missing scoped secret');this.#note(row.value);return row.value;},
      store:(owner,subject,value)=>{
        requireCondition(typeof value==='string'&&value.length>=8&&value.length<=4096&&!/\s/.test(value),'CREDENTIAL_UNAVAILABLE','Invalid scoped credential');this.#note(value);let changed=false;
        this.#transaction(()=>{const old=this.#secret(namespace,owner,subject);if(old?.value===value&&!old.revoked)return;
          requireCondition(old||(this.#db.prepare('SELECT count(*) AS n FROM scoped_secrets').get() as {n:number}).n<5000,'PRIVATE_VAULT_FULL','Scoped credential capacity exhausted');
          this.#db.prepare('INSERT OR REPLACE INTO scoped_secrets(namespace,owner,subject,value,epoch,revoked) VALUES(?,?,?,?,?,0)').run(namespace,owner,subject,value,randomUUID());changed=true;
        });if(changed)notify(owner,subject);
      },
      acquire:(owner,subject)=>{const row=this.#secret(namespace,owner,subject);if(!row||row.revoked)return undefined;const lease=freeze({ownerLease:owner,subjectLease:subject,epoch:row.epoch});issued.add(lease);return lease;},
      assertActive:lease=>{requireCondition(issued.has(lease),'CREDENTIAL_STALE','Unissued scoped credential lease');const row=this.#secret(namespace,lease.ownerLease,lease.subjectLease);requireCondition(row&&!row.revoked&&row.epoch===lease.epoch,'CREDENTIAL_STALE','Scoped credential changed');},
      revoke:(owner,subject)=>{this.#transaction(()=>{requireCondition(this.#secret(namespace,owner,subject),'CREDENTIAL_UNAVAILABLE','Unknown scoped credential');this.#db.prepare('UPDATE scoped_secrets SET value=NULL,revoked=1,epoch=? WHERE namespace=? AND owner=? AND subject=?').run(randomUUID(),namespace,owner,subject);});notify(owner,subject);},
      subscribe:listener=>{this.#assertOwner();const listeners=this.#listeners.get(namespace)??new Set<(owner:string,subject:string)=>void>();this.#listeners.set(namespace,listeners);listeners.add(listener);return ()=>listeners.delete(listener);},
    };
  }
  credentialEpochs():CredentialEpochStore {
    this.#assertOwner();
    const ref=(reference:string)=>requireCondition(/^env:[A-Z][A-Z0-9_]{0,63}$/.test(reference),'CREDENTIAL_REFERENCE_DENIED','Invalid environment credential reference');
    const digest=(reference:string,value:string)=>{requireCondition(typeof value==='string'&&value.length>=8&&value.length<=4096&&!/\s/.test(value),'CREDENTIAL_UNAVAILABLE','Invalid credential');this.#note(value);return createHmac('sha256',Buffer.from(this.#key,'hex')).update(JSON.stringify([reference,value])).digest('hex');};
    const read=(reference:string)=>{this.#assertOwner();ref(reference);try{return this.#db.prepare('SELECT epoch,verifier,revoked FROM credential_epochs WHERE reference=?').get(reference) as CredentialRow|undefined;}catch{throw denied('PRIVATE_VAULT_INVALID');}};
    const save=(reference:string,verifier:string|null,revoked:boolean)=>{
      const old=read(reference);requireCondition(old||(this.#db.prepare('SELECT count(*) AS n FROM credential_epochs').get() as {n:number}).n<64,'PRIVATE_VAULT_FULL','Credential reference capacity exhausted');
      this.#db.prepare('INSERT OR REPLACE INTO credential_epochs(reference,epoch,verifier,revoked) VALUES(?,?,?,?)').run(reference,randomUUID(),verifier,revoked?1:0);
    };
    return {
      persistence:'configured',
      observe:(reference,value)=>this.#transaction(()=>{const fingerprint=digest(reference,value),old=read(reference);requireCondition(!old?.revoked,'CREDENTIAL_REVOKED','Credential is revoked');if(!old||old.verifier!==fingerprint)save(reference,fingerprint,false);return read(reference)!.epoch;}),
      assertActive:(reference,epoch,value)=>{const old=read(reference);requireCondition(!old?.revoked,'CREDENTIAL_REVOKED','Credential is revoked');requireCondition(old?.epoch===epoch&&old.verifier===digest(reference,value),'CREDENTIAL_STALE','Credential epoch differs');},
      rotate:(reference,value)=>{this.#transaction(()=>save(reference,digest(reference,value),read(reference)?.revoked===1));},
      revoke:reference=>{this.#transaction(()=>save(reference,read(reference)?.verifier??null,true));},
      restore:reference=>{this.#transaction(()=>save(reference,read(reference)?.verifier??null,false));},
    };
  }
  close():void {
    if(this.#closed)return;this.#listeners.clear();
    try{this.#db.prepare('DELETE FROM vault_owner WHERE token=?').run(this.#owner);}finally{this.#closed=true;this.#db.close();this.#key='';}
  }
}
