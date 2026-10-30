import type { HarnessInstance, InstanceFailureCode } from './types.mjs';
import { requireCondition } from './contracts.mjs';

export interface CredentialService {
  resolve(reference: string): string;
  redact(text: string): string;
  assertActive?(reference:string,value:string):void;
  subscribe?(listener:(reference:string,change:'revoked'|'rotated'|'restored')=>void):()=>void;
  revoke?(reference:string):void;
  restore?(reference:string):void;
  rotate?(reference:string,value:string):void;
}
export interface EnvironmentCredentialService extends CredentialService {
  /** Trusted redaction registration; does not make a value resolvable by configuration. */
  remember(value: string): void;
}
export interface EnvironmentCredentialOptions {
  /** Trusted startup registration only. Untrusted instance JSON cannot extend this list. */
  readonly references?: readonly `env:${string}`[];
}
/** Explicit allowlist: configuration cannot read arbitrary environment variables. */
export function createEnvironmentCredentials(env: NodeJS.ProcessEnv = process.env, options: EnvironmentCredentialOptions = {}): EnvironmentCredentialService {
  const references = new Set(options.references ?? ['env:DEEPSEEK_API_KEY']);
  requireCondition(references.size <= 64 && [...references].every(ref => /^env:[A-Z][A-Z0-9_]{0,63}$/.test(ref)),
    'CREDENTIAL_REFERENCE_DENIED', 'Invalid trusted credential registration');
  const known = new Set<string>(),revoked=new Set<string>(),listeners=new Set<(reference:string,change:'revoked'|'rotated'|'restored')=>void>();
  const allowed=(ref:string)=>requireCondition(references.has(ref as `env:${string}`),'CREDENTIAL_REFERENCE_DENIED','Unsupported credential reference');
  const notify=(ref:string,change:'revoked'|'rotated'|'restored')=>{for(const listener of listeners){try{listener(ref,change);}catch{}}};
  for(const ref of references){const value=env[ref.slice(4)]?.trim();if(value&&value.length>=8)known.add(value);}
  return {
    remember(value){requireCondition(typeof value==='string'&&value.length>=8&&value.length<=16384,'CREDENTIAL_UNAVAILABLE','Invalid redaction registration');known.add(value);},
    resolve(reference) {
      allowed(reference);
      requireCondition(!revoked.has(reference),'CREDENTIAL_REVOKED','Credential is revoked');
      const value = env[reference.slice(4)]?.trim();
      requireCondition(value && value.length >= 8 && value.length <= 4096 && !/\s/.test(value),
        'CREDENTIAL_UNAVAILABLE', 'Set the referenced credential in the launching environment');
      known.add(value); return value;
    },
    assertActive(reference,value){allowed(reference);requireCondition(!revoked.has(reference),'CREDENTIAL_REVOKED','Credential revoked');requireCondition(env[reference.slice(4)]?.trim()===value,'CREDENTIAL_STALE','Credential changed; restart the instance');},
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    revoke(reference){allowed(reference);revoked.add(reference);notify(reference,'revoked');},
    restore(reference){allowed(reference);revoked.delete(reference);notify(reference,'restored');},
    rotate(reference,value){allowed(reference);requireCondition(value.length>=8&&value.length<=4096&&!/\s/.test(value),'CREDENTIAL_UNAVAILABLE','Invalid credential');const old=env[reference.slice(4)]?.trim();if(old)known.add(old);env[reference.slice(4)]=value;known.add(value);notify(reference,'rotated');},
    redact(text) {
      // Redact both current and previously resolved credentials (including after rotation).
      const current = [...references].map(ref=>env[ref.slice(4)]?.trim()).filter((v):v is string=>Boolean(v&&v.length>=8));
      for(const value of current)known.add(value);
      const values = [...known].sort((a, b) => b.length - a.length);
      let safe = text;
      for (const value of values) {const escaped=JSON.stringify(value).slice(1,-1),double=JSON.stringify(escaped).slice(1,-1);for(const variant of [...new Set([double,escaped,value])].sort((a,b)=>b.length-a.length))safe=safe.split(variant).join('[REDACTED]');}
      return safe;
    },
  };
}

/** Rotation invalidates the instance, not just the next API header. No running
 * inference is replayed with a replacement secret. Stop/recreate to get a new lease. */
export function guardCredentialInstance<T>(instance:HarnessInstance<T>,credentials:CredentialService,reference:string,value:string):HarnessInstance<T>{
  let failure:((code:InstanceFailureCode)=>void)|undefined;
  let invalid:InstanceFailureCode|undefined;
  const unsubscribe=credentials.subscribe?.((ref,change)=>{if(ref===reference){invalid=invalid==='CREDENTIAL_REVOKED'||change==='revoked'?'CREDENTIAL_REVOKED':'CREDENTIAL_STALE';failure?.(invalid);}});
  const check=()=>{requireCondition(!invalid,invalid??'CREDENTIAL_STALE','Credential lease was retired; recreate the instance');credentials.assertActive?.(reference,value);};
  return {
    setFailureHandler(handler){failure=handler;instance.setFailureHandler?.(handler);if(invalid)handler?.(invalid);},
    async start(context){check();await instance.start(context);check();},
    async run(task,context){check();const result=await instance.run(task,{...context,emit(data){check();context.emit(data);},assertAuthorized(permission,tool){check();context.assertAuthorized(permission,tool);}});check();return result;},
    ...(instance.reconcileExecution?{async reconcileExecution(record,context){check();const result=await instance.reconcileExecution!(record,context);check();return result;}}:{}),
    async stop(){await instance.stop();unsubscribe?.();},
    ...(instance.terminate?{async terminate(){await instance.terminate!();unsubscribe?.();}}:{}),
  };
}
