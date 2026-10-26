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
/** Explicit allowlist: configuration cannot read arbitrary environment variables. */
export function createEnvironmentCredentials(env: NodeJS.ProcessEnv = process.env): CredentialService {
  const known = new Set<string>(),revoked=new Set<string>(),listeners=new Set<(reference:string,change:'revoked'|'rotated'|'restored')=>void>();
  const allowed=(ref:string)=>requireCondition(['env:DEEPSEEK_API_KEY'].includes(ref),'CREDENTIAL_REFERENCE_DENIED','Unsupported credential reference');
  const notify=(ref:string,change:'revoked'|'rotated'|'restored')=>{for(const listener of listeners){try{listener(ref,change);}catch{}}};
  return {
    resolve(reference) {
      requireCondition(['env:DEEPSEEK_API_KEY'].includes(reference), 'CREDENTIAL_REFERENCE_DENIED', 'Unsupported credential reference');
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
      const current = [env.DEEPSEEK_API_KEY].map(v=>v?.trim()).filter((v):v is string=>Boolean(v&&v.length>=8));
      const values = [...known, ...current].sort((a, b) => b.length - a.length);
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
  const unsubscribe=credentials.subscribe?.((ref,change)=>{if(ref===reference)failure?.(change==='revoked'?'CREDENTIAL_REVOKED':'CREDENTIAL_STALE');});
  const check=()=>credentials.assertActive?.(reference,value);
  return {
    setFailureHandler(handler){failure=handler;instance.setFailureHandler?.(handler);},
    async start(context){check();await instance.start(context);check();},
    async run(task,context){check();return instance.run(task,{...context,assertAuthorized(permission,tool){check();context.assertAuthorized(permission,tool);}});},
    async stop(){await instance.stop();unsubscribe?.();},
    ...(instance.terminate?{async terminate(){await instance.terminate!();unsubscribe?.();}}:{}),
  };
}
