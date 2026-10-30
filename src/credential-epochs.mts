import { randomUUID } from 'node:crypto';
import { freeze, requireCondition } from './contracts.mjs';
export interface CredentialLease {
  readonly reference: string;
  readonly epoch: string;
  readonly persistence: 'configured' | 'memory-only';
}
/** Trusted synchronous backend. Stored verifiers and secret values are not lease metadata. */
export interface CredentialEpochStore {
  readonly persistence: CredentialLease['persistence'];
  observe(reference:string,value:string):string;
  assertActive(reference:string,epoch:string,value:string):void;
  rotate(reference:string,value:string):undefined;
  revoke(reference:string):undefined;
  restore(reference:string):undefined;
}
export function createMemoryCredentialEpochs():CredentialEpochStore {
  const rows=new Map<string,{epoch:string;value:string|undefined;revoked:boolean}>();
  const change=(ref:string,value:string|undefined,revoked:boolean)=>rows.set(ref,{epoch:randomUUID(),value,revoked});
  return {
    persistence:'memory-only',
    observe(ref,value){const old=rows.get(ref);requireCondition(!old?.revoked,'CREDENTIAL_REVOKED','Credential is revoked');if(!old||old.value!==value)change(ref,value,false);return rows.get(ref)!.epoch;},
    assertActive(ref,epoch,value){const old=rows.get(ref);requireCondition(!old?.revoked,'CREDENTIAL_REVOKED','Credential is revoked');requireCondition(old?.epoch===epoch&&old.value===value,'CREDENTIAL_STALE','Credential lease changed');},
    rotate(ref,value){change(ref,value,rows.get(ref)?.revoked??false);},
    revoke(ref){change(ref,rows.get(ref)?.value,true);},
    restore(ref){change(ref,rows.get(ref)?.value,false);},
  };
}
export function credentialLease(reference:string,epoch:string,persistence:CredentialLease['persistence']):CredentialLease {
  return freeze({reference,epoch,persistence});
}
