import { randomUUID } from 'node:crypto';
import { freeze, identifier, requireCondition } from './contracts.mjs';

/** Adapter-private non-secret JSON. Neither records nor reference values are public snapshots. */
export type PrivateJson = null | boolean | number | string | readonly PrivateJson[] | { readonly [key: string]: PrivateJson };
export interface PrivateRecordKey {
  readonly instanceId: string;
  readonly runId: string;
  readonly generation: string;
}
export interface PrivateRecord {
  readonly key: PrivateRecordKey;
  readonly revision: number;
  readonly value: PrivateJson;
}
/** Synchronous durable CAS. A Promise is not an acknowledged persistence boundary. */
export interface ProviderRecordStore {
  read(key: PrivateRecordKey): PrivateRecord | undefined;
  write(key: PrivateRecordKey, expectedRevision: number | null, value: PrivateJson): PrivateRecord;
}
export type PrivateRunLookup = {readonly status:'none'} | {readonly status:'unique';readonly record:PrivateRecord} | {readonly status:'ambiguous'};
/** Stronger capability required by adapters which retain submission identities across generations. */
export interface UniqueProviderRecordStore extends ProviderRecordStore {
  lookupRun(instanceId:string,runId:string):PrivateRunLookup;
  reserveRun(key:PrivateRecordKey,value:PrivateJson):PrivateRecord;
}
export interface PrivateLease<T> {
  readonly reference: `local:${string}`;
  readonly lease: string;
  readonly value: T;
}
export interface PrivateReferenceService<T> {
  acquire(reference: `local:${string}`): PrivateLease<T>;
  assertActive(lease: PrivateLease<T>): void;
}
/** Supplied by the trusted entry, never selected from arbitrary paths or package names. */
export interface ProviderPrivateServices<Identity, Binding> {
  readonly records: ProviderRecordStore;
  readonly identities: PrivateReferenceService<Identity>;
  readonly bindings: PrivateReferenceService<Binding>;
}
export interface PrivateReferenceRegistry<T> extends PrivateReferenceService<T> {
  replace(reference: `local:${string}`, value: T): void;
  revoke(reference: `local:${string}`): void;
}
export function localReference(reference: string): void {
  requireCondition(/^local:[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(reference), 'PRIVATE_REFERENCE_DENIED', 'Invalid local reference');
}
/** Identity/key material stays in the entry-owned service, never the public configuration or ledger. */
export function createPrivateReferences<T>(entries: readonly { readonly reference: `local:${string}`; readonly value: T }[]): PrivateReferenceRegistry<T> {
  requireCondition(entries.length <= 128, 'PRIVATE_REFERENCE_DENIED', 'Too many private references');
  const records = new Map<string, PrivateLease<T>>();
  for (const { reference, value } of entries) {
    localReference(reference);
    requireCondition(!records.has(reference), 'PRIVATE_REFERENCE_DENIED', 'Duplicate private reference');
    records.set(reference, Object.freeze({reference, lease: randomUUID(), value: freeze(structuredClone(value))}));
  }
  return {
    acquire(reference) { localReference(reference); const value=records.get(reference); requireCondition(value,'PRIVATE_REFERENCE_DENIED','Unregistered private reference'); return value; },
    assertActive(lease) { requireCondition(records.get(lease.reference)===lease,'PRIVATE_LEASE_STALE','Private identity or binding changed'); },
    replace(reference,value) { localReference(reference); requireCondition(records.has(reference),'PRIVATE_REFERENCE_DENIED','Replacement requires a registered reference'); records.set(reference,Object.freeze({reference,lease:randomUUID(),value:freeze(structuredClone(value))})); },
    revoke(reference) { localReference(reference); requireCondition(records.has(reference),'PRIVATE_REFERENCE_DENIED','Unregistered private reference'); records.delete(reference); },
  };
}
export function privateRecordKey(value: PrivateRecordKey): PrivateRecordKey {
  return freeze({instanceId:identifier(value.instanceId,'instanceId'),runId:identifier(value.runId,'runId'),generation:identifier(value.generation,'generation')});
}
/** Validate before persistence. Known secrets and credential-shaped fields fail closed, not silently redacted. */
export function privateRecordValue(value: PrivateJson, redact: (text:string)=>string): PrivateJson {
  const visit=(node:unknown,depth:number):void=>{
    requireCondition(depth<=12,'PRIVATE_RECORD_INVALID','Private record exceeds nesting limit');
    if(node===null||typeof node==='boolean')return;
    if(typeof node==='string'){requireCondition(node.length<=8192,'PRIVATE_RECORD_INVALID','Private text exceeds limit');return;}
    if(typeof node==='number'){requireCondition(Number.isFinite(node),'PRIVATE_RECORD_INVALID','Invalid private number');return;}
    requireCondition(node!==null&&typeof node==='object'&&(Array.isArray(node)||Object.getPrototypeOf(node)===Object.prototype||Object.getPrototypeOf(node)===null),'PRIVATE_RECORD_INVALID','Private record must contain JSON only');
    requireCondition(Object.keys(node).length<=128,'PRIVATE_RECORD_INVALID','Private record has too many entries');
    for(const [key,child] of Object.entries(node)){
      requireCondition(key.length<=128&&!/^(?:__proto__|constructor|prototype|.*(?:token|password|secret)|apiKey|privateKey(?:Pem)?|authorization|headers)$/i.test(key),'PRIVATE_RECORD_SECRET','Credential fields belong in an identity service');
      visit(child,depth+1);
    }
  };
  visit(value,0);
  const text=JSON.stringify(value);
  requireCondition(text!==undefined&&Buffer.byteLength(text)<=32768,'PRIVATE_RECORD_INVALID','Private record exceeds 32KiB');
  requireCondition(redact(text)===text,'PRIVATE_RECORD_SECRET','Private record contains credential material');
  return freeze(JSON.parse(text) as PrivateJson);
}

export interface ProviderResourceBudget {
  /** Idempotent release is called only after acquisition failed or actual transport cleanup. */
  acquire(): () => void;
}
/** Trusted shared limit across adapter instances; the caller owns the budget's scope. */
export function createProviderResourceBudget(limit:number):ProviderResourceBudget {
  requireCondition(Number.isSafeInteger(limit)&&limit>=1&&limit<=64,'PRIVATE_RESOURCE_LIMIT','Resource limit must be 1..64');
  let held=0;
  return {acquire(){requireCondition(held<limit,'PRIVATE_RESOURCE_LIMIT','Provider connection budget exhausted');held++;let released=false;return ()=>{if(!released){released=true;held--;}};}};
}
