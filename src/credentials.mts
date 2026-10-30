import type { HarnessInstance, InstanceFailureCode } from './types.mjs';
import { requireCondition } from './contracts.mjs';
import { credentialLease, createMemoryCredentialEpochs } from './credential-epochs.mjs';
import type { CredentialEpochStore, CredentialLease } from './credential-epochs.mjs';
export type { CredentialEpochStore, CredentialLease } from './credential-epochs.mjs';

export interface CredentialService {
  resolve(reference: string): string;
  redact(text: string): string;
  assertActive?(reference:string,value:string):void;
  acquire?(reference:string):CredentialLease;
  assertLease?(lease:CredentialLease):void;
  subscribe?(listener:(reference:string,change:'revoked'|'rotated'|'restored')=>void):()=>void;
  revoke?(reference:string):void;
  restore?(reference:string):void;
  rotate?(reference:string,value:string):void;
}
export interface EnvironmentCredentialService extends CredentialService {
  remember(value: string): void;
  acquire(reference:string):CredentialLease;
  assertLease(lease:CredentialLease):void;
}
export interface EnvironmentCredentialOptions {
  /** Trusted startup registration only. Instance JSON cannot extend this list. */
  readonly references?: readonly `env:${string}`[];
  readonly epochs?: CredentialEpochStore;
}
/** Defaults stay in memory; a trusted private backend explicitly enables stable epochs. */
export function createEnvironmentCredentials(env: NodeJS.ProcessEnv = process.env, options: EnvironmentCredentialOptions = {}): EnvironmentCredentialService {
  const references = new Set(options.references ?? ['env:DEEPSEEK_API_KEY']);
  requireCondition(references.size <= 64 && [...references].every(ref => /^env:[A-Z][A-Z0-9_]{0,63}$/.test(ref)),
    'CREDENTIAL_REFERENCE_DENIED', 'Invalid trusted credential registration');
  const epochs=options.epochs??createMemoryCredentialEpochs(),issued=new WeakSet<object>();
  requireCondition(['configured','memory-only'].includes(epochs.persistence),'CREDENTIAL_BACKEND_INVALID','Invalid credential persistence mode');
  const synchronous=(value:unknown)=>{if(value!==undefined){if(value&&typeof value==='object'&&'then'in value)void Promise.resolve(value).catch(()=>{});requireCondition(false,'CREDENTIAL_BACKEND_INVALID','Credential commits and checks must be synchronous');}};
  const epochValue=(value:unknown):string=>{if(value&&typeof value==='object'&&'then'in value)void Promise.resolve(value).catch(()=>{});requireCondition(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value),'CREDENTIAL_BACKEND_INVALID','Credential epochs must be bounded opaque identifiers');return value;};
  const known = new Set<string>(),revoked=new Set<string>(),listeners=new Set<(reference:string,change:'revoked'|'rotated'|'restored')=>void>();
  const allowed=(ref:string)=>requireCondition(references.has(ref as `env:${string}`),'CREDENTIAL_REFERENCE_DENIED','Unsupported credential reference');
  const notify=(ref:string,change:'revoked'|'rotated'|'restored')=>{for(const listener of listeners){try{listener(ref,change);}catch{}}};
  const valid:(value:unknown)=>asserts value is string=value=>requireCondition(typeof value==='string'&&value.length>=8&&value.length<=4096&&!/\s/.test(value),'CREDENTIAL_UNAVAILABLE','Invalid referenced credential');
  const read=(reference:string)=>{allowed(reference);requireCondition(!revoked.has(reference),'CREDENTIAL_REVOKED','Credential is revoked');const value=env[reference.slice(4)]?.trim();valid(value);known.add(value);return value;};
  for(const ref of references){const value=env[ref.slice(4)]?.trim();if(value&&value.length>=8)known.add(value);}
  return {
    remember(value){requireCondition(typeof value==='string'&&value.length>=8&&value.length<=16384,'CREDENTIAL_UNAVAILABLE','Invalid redaction registration');known.add(value);},
    resolve(reference){const value=read(reference);epochValue(epochs.observe(reference,value));return value;},
    acquire(reference){const value=read(reference),lease=credentialLease(reference,epochValue(epochs.observe(reference,value)),epochs.persistence);issued.add(lease);return lease;},
    assertLease(lease){requireCondition(issued.has(lease),'CREDENTIAL_STALE','Unissued credential lease');const value=read(lease.reference);synchronous(epochs.assertActive(lease.reference,lease.epoch,value));},
    assertActive(reference,value){const current=read(reference);requireCondition(current===value,'CREDENTIAL_STALE','Credential changed; recreate the instance');epochValue(epochs.observe(reference,current));},
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    revoke(reference){allowed(reference);try{synchronous(epochs.revoke(reference));}finally{revoked.add(reference);notify(reference,'revoked');}},
    restore(reference){allowed(reference);synchronous(epochs.restore(reference));revoked.delete(reference);notify(reference,'restored');},
    rotate(reference,value){
      allowed(reference);valid(value);const old=env[reference.slice(4)]?.trim();if(old)known.add(old);known.add(value);
      try{synchronous(epochs.rotate(reference,value));env[reference.slice(4)]=value;}catch(error){revoked.add(reference);notify(reference,'revoked');throw error;}
      notify(reference,'rotated');
    },
    redact(text) {
      for(const ref of references){const value=env[ref.slice(4)]?.trim();if(value&&value.length>=8)known.add(value);}
      let safe=text;
      for(const value of [...known].sort((a,b)=>b.length-a.length)){
        const escaped=JSON.stringify(value).slice(1,-1),double=JSON.stringify(escaped).slice(1,-1);
        for(const variant of [...new Set([double,escaped,value])].sort((a,b)=>b.length-a.length))safe=safe.split(variant).join('[REDACTED]');
      }
      return safe;
    },
  };
}

/** Rotation invalidates the instance, not just the next API header. No running
 * inference is replayed with a replacement secret. Stop/recreate to get a new lease. */
export function guardCredentialInstance<T>(instance:HarnessInstance<T>,credentials:CredentialService,reference:string,value:string):HarnessInstance<T>{
  const lease=credentials.acquire?.(reference);
  let failure:((code:InstanceFailureCode)=>void)|undefined;
  let invalid:InstanceFailureCode|undefined;
  const unsubscribe=credentials.subscribe?.((ref,change)=>{if(ref===reference){invalid=invalid==='CREDENTIAL_REVOKED'||change==='revoked'?'CREDENTIAL_REVOKED':'CREDENTIAL_STALE';failure?.(invalid);}});
  const check=()=>{requireCondition(!invalid,invalid??'CREDENTIAL_STALE','Credential lease was retired; recreate the instance');credentials.assertActive?.(reference,value);if(lease)credentials.assertLease?.(lease);};
  return {
    setFailureHandler(handler){failure=handler;instance.setFailureHandler?.(handler);if(invalid)handler?.(invalid);},
    async start(context){check();await instance.start(context);check();},
    async run(task,context){check();const result=await instance.run(task,{...context,emit(data){check();context.emit(data);},assertAuthorized(permission,tool){check();context.assertAuthorized(permission,tool);}});check();return result;},
    ...(instance.reconcileExecution?{async reconcileExecution(record,context){check();const result=await instance.reconcileExecution!(record,context);check();return result;}}:{}),
    async stop(){await instance.stop();unsubscribe?.();},
    ...(instance.terminate?{async terminate(){await instance.terminate!();unsubscribe?.();}}:{}),
  };
}
