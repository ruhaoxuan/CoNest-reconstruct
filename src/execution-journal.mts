import { randomUUID } from 'node:crypto';
import { freeze, identifier, requireCondition } from './contracts.mjs';
export interface ExecutionFence {
 readonly instanceId:string;readonly runId:string;readonly generation:string;
 readonly configRevision?:string;readonly providerId:string;readonly providerVersion:string;readonly subject:string;
 readonly token:string;readonly createdAt:string;
 readonly status:'in-flight'|'uncertain'|'acknowledged'|'confirmed-ended';
 readonly acknowledgedBy?:string;
}
export interface ExecutionPersistence {
 save(record:ExecutionFence):undefined;
 remove(record:ExecutionFence,evidence:'normal-settlement'|'provider-confirmed'):undefined;
}
export function parseExecutionFence(raw:unknown):ExecutionFence {
 requireCondition(raw!==null&&typeof raw==='object'&&!Array.isArray(raw),'STATE_INVALID','Invalid execution journal');
 const v=raw as Record<string,unknown>;
 requireCondition(Object.keys(v).every(k=>['instanceId','runId','generation','providerId','providerVersion','subject','token','createdAt','status','acknowledgedBy','configRevision'].includes(k)),'STATE_INVALID','Unexpected execution metadata');
 for(const key of ['instanceId','runId','generation','providerId','subject','token'])identifier(v[key],key);
 requireCondition(typeof v.providerVersion==='string'&&v.providerVersion.length>0&&v.providerVersion.length<=128&&typeof v.createdAt==='string'&&Number.isFinite(Date.parse(v.createdAt)),'STATE_INVALID','Invalid execution metadata');
 requireCondition(['in-flight','uncertain','acknowledged','confirmed-ended'].includes(String(v.status)),'STATE_INVALID','Invalid execution state');
 if(v.configRevision!==undefined)requireCondition(typeof v.configRevision==='string'&&/^[a-f0-9]{64}$/.test(v.configRevision),'STATE_INVALID','Invalid configuration identity');
 if(v.acknowledgedBy!==undefined)identifier(v.acknowledgedBy,'acknowledgedBy');
 return freeze(structuredClone(v)) as unknown as ExecutionFence;
}
/** Synchronous durable admission is deliberate: no native submission before COMMIT. */
export class ExecutionJournal {
 #records=new Map<string,ExecutionFence>();
 constructor(private readonly persistence?:ExecutionPersistence){}
 #synchronous(value:unknown){if(value!==undefined){if(value&&typeof value==='object'&&'then' in value)void Promise.resolve(value).catch(()=>{});requireCondition(false,'INVALID_PERSISTENCE','Execution commits must be synchronous');}}
 #save(record:ExecutionFence){this.#synchronous(this.persistence?.save(record));}
 #remove(record:ExecutionFence){this.#synchronous(this.persistence?.remove(record,'normal-settlement'));}
 #key(id:string,runId:string){return JSON.stringify([id,runId]);}
 list(id?:string):ExecutionFence[]{return [...this.#records.values()].filter(r=>id===undefined||r.instanceId===id).map(r=>structuredClone(r));}
 get(id:string,runId:string){return this.#records.get(this.#key(id,runId));}
 blocked(id:string){return this.list(id).some(r=>r.status==='uncertain');}
 restore(values:readonly unknown[]){requireCondition(this.#records.size+values.length<=5000,'EXECUTION_LEDGER_FULL','Execution ledger exceeds limit');for(const value of values){const record=parseExecutionFence(value),key=this.#key(record.instanceId,record.runId);requireCondition(!this.#records.has(key),'STATE_INVALID','Duplicate restored execution');const restored=freeze({...record,status:record.status==='in-flight'?'uncertain' as const:record.status});this.#records.set(key,restored);this.#save(restored);}}
 admit(meta:Omit<ExecutionFence,'status'|'token'|'createdAt'>):ExecutionFence {
  requireCondition(!this.blocked(meta.instanceId),'RUN_OUTCOME_UNKNOWN','Reconcile uncertain work before admission');
  const key=this.#key(meta.instanceId,meta.runId);requireCondition(!this.#records.has(key),'DUPLICATE_RUN','Execution identity is retained');
  requireCondition(this.#records.size<5000,'EXECUTION_LEDGER_FULL','Execution ledger requires explicit maintenance');
  const record=parseExecutionFence({...meta,status:'in-flight',token:randomUUID(),createdAt:new Date().toISOString()});
  this.#records.set(key,record);
  try{this.#save(record);}catch(error){this.#records.set(key,freeze({...record,status:'uncertain'}));throw error;}
  return record;
 }
 current(record:ExecutionFence){return this.get(record.instanceId,record.runId)?.token===record.token;}
 uncertain(record:ExecutionFence):void{
  requireCondition(this.current(record),'CALLBACK_EXPIRED','Execution no longer belongs to this invocation');
  const next=freeze({...record,status:'uncertain' as const});this.#records.set(this.#key(record.instanceId,record.runId),next);
  this.#save(next);
 }
 settle(record:ExecutionFence):boolean{
  if(!this.current(record)||this.get(record.instanceId,record.runId)?.status!=='in-flight')return false;
  try{this.#remove(record);this.#records.delete(this.#key(record.instanceId,record.runId));return true;}
  catch{this.#records.set(this.#key(record.instanceId,record.runId),freeze({...record,status:'uncertain'}));return false;}
 }
 acknowledge(id:string,runId:string,token:string,actor:string):void{
  const record=this.get(id,runId);requireCondition(record?.token===token&&record.status==='uncertain','EXECUTION_CONFLICT','Execution fence changed');identifier(actor,'actor');
  const next=freeze({...record,status:'acknowledged' as const,acknowledgedBy:actor});this.#save(next);this.#records.set(this.#key(id,runId),next);
 }
 confirm(id:string,runId:string,token:string):void{
  const record=this.get(id,runId);requireCondition(record?.token===token&&['uncertain','acknowledged'].includes(record.status),'EXECUTION_CONFLICT','Execution fence changed');
  const next=freeze({...record,status:'confirmed-ended' as const});this.#save(next);this.#records.set(this.#key(id,runId),next);
 }
}
