import type { CredentialLease } from '../credentials.mjs';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { freeze, HarnessError, milliseconds, requireCondition, identifier } from '../contracts.mjs';
import type { PrivateLease } from '../provider-services.mjs';
import { validateOpenClawConnectionConfig } from './openclaw-config.mjs';
import { loadOpenClawClient } from './openclaw-client.mjs';
import { OPENCLAW_RELEASE, OPENCLAW_WIRE, OPENCLAW_SCOPES, openClawMilliseconds } from './openclaw-types.mjs';
import type { GatewayClientPort, OpenClawConnectionOptions, OpenClawRequestMap, OpenClawRequestOptions, OpenClawDeviceIdentity, OpenClawGatewayBinding, OpenClawConnectionEvidence } from './openclaw-types.mjs';
import { object, fields } from '../config.mjs';
export type * from './openclaw-types.mjs';
export { validateOpenClawConnectionConfig } from './openclaw-config.mjs';

const failure=(code:string)=>new HarnessError(code,'OpenClaw connection refused or retired: '+code);
function scopes(value:unknown):void {
  requireCondition(Array.isArray(value)&&value.length===OPENCLAW_SCOPES.length&&new Set(value).size===value.length&&OPENCLAW_SCOPES.every(s=>value.includes(s)),
    'OPENCLAW_SCOPE_DENIED','Exactly the registered operator read/write scopes are required');
}
function deviceToken(value:unknown):asserts value is string {
  requireCondition(typeof value==='string'&&value.length>=8&&value.length<=4096&&!/\s/.test(value),'OPENCLAW_DEVICE_AUTH_REQUIRED','A paired device token is required');
}
/** One connection epoch; on any disconnect it is retired, never transparently reconnected.
 * This is a trusted low-level seam, not a production task provider or settlement predicate. */
export class OpenClawConnection {
  #options:OpenClawConnectionOptions;
  #config:ReturnType<typeof validateOpenClawConnectionConfig>;
  #identity:PrivateLease<OpenClawDeviceIdentity>|undefined;
  #binding:PrivateLease<OpenClawGatewayBinding>|undefined;
  #credential:string|undefined;
  #credentialLease:CredentialLease|undefined;
  #evidence:OpenClawConnectionEvidence|undefined;
  #deviceUnsubscribe:(()=>void)|undefined;
  #client:GatewayClientPort|undefined;
  #started=false;
  #ready=false;
  #ended=false;
  #epoch=randomUUID();
  #abort=new AbortController();
  #unsubscribe:(()=>void)|undefined;
  #rejectReady:((error:Error)=>void)|undefined;
  #draining:Promise<void>|undefined;
  #releaseConnection:(()=>void)|undefined;
  #used=new Set<string>();
  #inflight=0;
  readonly #handshakeMs:number;
  readonly #closeMs:number;
  constructor(options:OpenClawConnectionOptions) {
    this.#config=validateOpenClawConnectionConfig(options.config);
    this.#options=options;
    this.#handshakeMs=milliseconds(options.handshakeTimeoutMs??10000,'handshake timeout');
    this.#closeMs=milliseconds(options.closeTimeoutMs??1000,'connection close timeout');
  }
  #check():void {
    requireCondition(!this.#ended,'OPENCLAW_CONNECTION_RETIRED','Connection epoch is retired');
    requireCondition(this.#identity&&this.#binding&&this.#credential,'OPENCLAW_NOT_READY','Connection is not initialized');
    try {
      this.#options.identities.assertActive(this.#identity);this.#options.bindings.assertActive(this.#binding);
      this.#options.credentials.assertActive!(this.#config.credentialRef,this.#credential);
      if(this.#credentialLease)this.#options.credentials.assertLease(this.#credentialLease);
    } catch(error) {const safe=error instanceof HarnessError?error:failure('PRIVATE_LEASE_STALE');this.#retire(safe);throw safe;}
  }
  #retire(error?:HarnessError):void {
    if(this.#ended)return;
    this.#ended=true;this.#ready=false;this.#epoch=randomUUID();
    this.#abort.abort(error??failure('OPENCLAW_CONNECTION_RETIRED'));
    this.#rejectReady?.(error??failure('OPENCLAW_CONNECTION_RETIRED'));
    this.#unsubscribe?.();this.#unsubscribe=undefined;this.#deviceUnsubscribe?.();this.#deviceUnsubscribe=undefined;
    try{this.#client?.stop();}catch{} // Synchronous retirement prevents the SDK's reconnect supervisor.
    if(error){try{this.#options.onFailure?.(error.code);}catch{}}
  }
  async #drain():Promise<void> {
    if(!this.#draining)this.#draining=(async()=>{
      const client=this.#client;if(!client){this.#releaseConnection?.();this.#releaseConnection=undefined;return;}
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{const drained=await Promise.race([client.stopAndWait({timeoutMs:this.#closeMs}).then(()=>{this.#releaseConnection?.();this.#releaseConnection=undefined;return true;}),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),this.#closeMs);})]);void drained;}catch{}finally{clearTimeout(timer);}
    })();
    await this.#draining;
  }
  async start(context?:{readonly signal:AbortSignal}):Promise<void> {
    requireCondition(!this.#started&&!this.#ended,'OPENCLAW_CONNECTION_RETIRED','Create a fresh connection for another epoch');this.#started=true;
    const {credentials,identities,bindings,deviceTokens}=this.#options;
    requireCondition(typeof credentials.assertActive==='function'&&typeof credentials.subscribe==='function'&&typeof credentials.remember==='function'&&typeof credentials.acquire==='function'&&typeof credentials.assertLease==='function','CREDENTIAL_SERVICE_REQUIRED','A revocable credential service with redaction registration is required');
    this.#identity=identities.acquire(this.#config.identityRef);this.#binding=bindings.acquire(this.#config.gatewayBindingRef);
    const binding=this.#binding.value;
    requireCondition(binding.endpoint===this.#config.endpoint&&binding.agentId===this.#config.agentId&&binding.releaseProfile===this.#config.releaseProfile,'OPENCLAW_BINDING_MISMATCH','The trusted Gateway binding does not match the connection');
    this.#credential=credentials.resolve(this.#config.credentialRef);this.#credentialLease=credentials.acquire(this.#config.credentialRef);
    const identity=this.#identity.value;
    requireCondition(typeof identity.privateKeyPem==='string'&&identity.privateKeyPem.length<=8192&&typeof identity.publicKeyPem==='string'&&identity.publicKeyPem.length<=8192,'OPENCLAW_IDENTITY_INVALID','Invalid device key material');
    let publicRaw:string;
    try {
      const pub=createPublicKey(identity.publicKeyPem),priv=createPrivateKey(identity.privateKeyPem),jwk=pub.export({format:'jwk'});
      requireCondition(pub.asymmetricKeyType==='ed25519'&&priv.asymmetricKeyType==='ed25519'&&typeof jwk.x==='string','OPENCLAW_IDENTITY_INVALID','An Ed25519 device identity is required');
      publicRaw=jwk.x;
      requireCondition(createHash('sha256').update(Buffer.from(publicRaw,'base64url')).digest('hex')===identity.deviceId&&verify(null,Buffer.from('conest-identity-check'),pub,sign(null,Buffer.from('conest-identity-check'),priv)),'OPENCLAW_IDENTITY_INVALID','Device key binding mismatch');
    }catch{throw failure('OPENCLAW_IDENTITY_INVALID');}
    credentials.remember(identity.privateKeyPem);
    const token=deviceTokens.load(this.#binding.lease,this.#identity.lease);
    if(token!==undefined){deviceToken(token);credentials.remember(token);}
    let resolveReady!:()=>void;let rejectReady!:(error:Error)=>void;
    this.#releaseConnection=this.#options.connections.acquire();
    const readyPromise=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});this.#rejectReady=rejectReady;
    const epoch=this.#epoch;
    const current=()=>!this.#ended&&this.#epoch===epoch;
    const stopOnError=(error:unknown)=>this.#retire(error instanceof HarnessError?error:failure('OPENCLAW_HANDSHAKE_REJECTED'));
    const onAbort=()=>this.#retire(failure('OPENCLAW_CONNECT_ABORTED'));
    const timer=setTimeout(()=>this.#retire(failure('OPENCLAW_HANDSHAKE_TIMEOUT')),this.#handshakeMs);
    context?.signal.addEventListener('abort',onAbort,{once:true});
    this.#unsubscribe=credentials.subscribe((reference,change)=>{if(reference===this.#config.credentialRef)this.#retire(failure(change==='revoked'?'CREDENTIAL_REVOKED':'CREDENTIAL_STALE'));});
    if(context?.signal.aborted)onAbort();
    void (async()=>{
      const Client=await (this.#options.loadClient??loadOpenClawClient)(this.#options.runtimeRoot);
      if(!current())return;this.#check();
      this.#client=new Client({
        url:this.#config.endpoint,...(token?{deviceToken:token}:{bootstrapToken:this.#credential!}),deviceIdentity:identity,
        env:{},clientName:'gateway-client',clientDisplayName:'CoNest attached transport',clientVersion:'0.4.0',platform:process.platform,mode:'backend',role:'operator',
        scopes:[...OPENCLAW_SCOPES],caps:['tool-events'],minProtocol:OPENCLAW_WIRE,maxProtocol:OPENCLAW_WIRE,requestTimeoutMs:10000,connectChallengeTimeoutMs:this.#handshakeMs,
        hostDeps:{
          signDevicePayload:(key,payload)=>{this.#check();requireCondition(key===identity.privateKeyPem,'OPENCLAW_IDENTITY_INVALID','Unexpected signing key');return sign(null,Buffer.from(payload),key).toString('base64url');},
          publicKeyRawBase64UrlFromPem:key=>{requireCondition(key===identity.publicKeyPem,'OPENCLAW_IDENTITY_INVALID','Unexpected public key');return publicRaw;},
          loadDeviceAuthToken:()=>null,storeDeviceAuthToken:()=>{},clearDeviceAuthToken:()=>{},
          beforeConnect:()=>this.#check(),redactForLog:text=>credentials.redact(text),
        },
        onHelloOk:hello=>{
          if(!current())return;
          try {
            this.#check();const h=object(hello,'hello'),server=object(h.server,'server'),features=object(h.features,'features'),auth=object(h.auth,'auth');
            requireCondition(h.type==='hello-ok'&&h.protocol===OPENCLAW_WIRE,'OPENCLAW_PROTOCOL_MISMATCH','Unsupported wire protocol');
            if(server.bootId!==undefined)identifier(server.bootId,'Gateway boot identity');
            requireCondition(server.version===OPENCLAW_RELEASE,'OPENCLAW_VERSION_MISMATCH','The Gateway version must match the fixed profile exactly');
            requireCondition(typeof server.connId==='string'&&server.connId.length>0&&server.connId.length<=256,'OPENCLAW_HANDSHAKE_REJECTED','Missing connection identity');
            requireCondition(auth.role==='operator','OPENCLAW_SCOPE_DENIED','Operator role required');scopes(auth.scopes);
            requireCondition(Array.isArray(features.methods)&&['agent','agent.wait','chat.abort','health'].every(m=>(features.methods as unknown[]).includes(m)),'OPENCLAW_METHOD_UNAVAILABLE','Required native methods unavailable');
            const paired=auth.deviceToken??token;deviceToken(paired);credentials.remember(paired);
            this.#check();deviceTokens.store(this.#binding!.lease,this.#identity!.lease,paired);this.#check();
            this.#evidence=freeze({releaseProfile:this.#config.releaseProfile,protocol:OPENCLAW_WIRE,peerVersion:OPENCLAW_RELEASE,connectionEpoch:epoch,...(server.bootId===undefined?{}:{gatewayBootId:server.bootId as string}),identityRef:this.#config.identityRef,identityLease:this.#identity!.lease,gatewayBindingRef:this.#config.gatewayBindingRef,gatewayBindingLease:this.#binding!.lease,credentialLease:this.#credentialLease!});
            this.#deviceUnsubscribe=deviceTokens.subscribe?.((binding,identity)=>{if(binding===this.#binding?.lease&&identity===this.#identity?.lease)this.#retire(failure('CREDENTIAL_STALE'));});
            this.#ready=true;resolveReady();
          }catch(error){stopOnError(error);}
        },
        onConnectError:error=>{
          if(!current())return;
          // Expose only closed diagnostic codes; native errors may contain credentials.
          const details='details' in error&&error.details&&typeof error.details==='object'?error.details as Record<string,unknown>:{};
          const code=String(details.code??'');
          this.#retire(failure(code==='PAIRING_REQUIRED'?'OPENCLAW_PAIRING_REQUIRED':code.includes('SCOPE')?'OPENCLAW_SCOPE_DENIED':'OPENCLAW_HANDSHAKE_REJECTED'));
        },
        onClose:()=>{if(current())this.#retire(failure('TRANSPORT_LOST'));this.#releaseConnection?.();this.#releaseConnection=undefined;},
        onEvent:event=>{if(current()&&this.#ready){try{this.#check();this.#options.onEvent?.(event);}catch(error){stopOnError(error);}}},
        onGap:gap=>{if(current()&&this.#ready){try{this.#check();this.#options.onGap?.(gap);}catch(error){stopOnError(error);}}},
      });
      if(!current()){this.#client.stop();return;}
      this.#client.start();
    })().catch(stopOnError);
    try {await readyPromise;}catch(error){await this.#drain();throw error;}finally{clearTimeout(timer);context?.signal.removeEventListener('abort',onAbort);this.#rejectReady=undefined;}
  }
  async request<M extends keyof OpenClawRequestMap>(method:M,raw:OpenClawRequestMap[M],options:OpenClawRequestOptions):Promise<unknown> {
    this.#check();requireCondition(this.#ready&&this.#client,'OPENCLAW_NOT_READY','Handshake must complete before requests');
    const timeoutMs=openClawMilliseconds(options.timeoutMs);
    requireCondition(options.signal instanceof AbortSignal,'INVALID_REQUEST','A caller abort signal is required');options.signal.throwIfAborted();
    requireCondition(['agent','agent.wait','chat.abort','health'].includes(method),'OPENCLAW_METHOD_DENIED','Native method is not allowed');
    const params=object(raw,'native request');
    if(method==='agent'){
      fields(params,['message','idempotencyKey','agentId','sessionKey','deliver','timeout'],'agent');
      requireCondition(typeof params.message==='string'&&params.message.length>0&&params.message.length<=32768&&!/^\s*\//.test(params.message),'INVALID_REQUEST','A bounded ordinary agent prompt is required');
      identifier(params.idempotencyKey,'native run ID');
      requireCondition(params.deliver===false&&typeof params.timeout==='number'&&Number.isSafeInteger(params.timeout)&&params.timeout>=1&&params.timeout<=300,'INVALID_REQUEST','Native timeout uses bounded seconds and delivery is disabled');
      requireCondition(options.expectFinal===true,'INVALID_REQUEST','Agent requests require a bounded correlated final');
    }else if(method==='agent.wait'){
      fields(params,['runId','timeoutMs'],'agent.wait');identifier(params.runId,'native run ID');milliseconds(params.timeoutMs,'native wait timeout');
      requireCondition((params.timeoutMs as number)<=timeoutMs,'INVALID_REQUEST','Native wait must fit within the transport deadline');
    }else if(method==='chat.abort'){
      fields(params,['sessionKey','agentId','runId'],'chat.abort');identifier(params.runId,'native run ID');
    }else fields(params,[],'health');
    if(method==='agent'||method==='chat.abort')requireCondition(params.agentId===this.#config.agentId&&typeof params.sessionKey==='string'&&params.sessionKey.startsWith('agent:'+this.#config.agentId+':conest-')&&/^[a-zA-Z0-9:_-]{1,256}$/.test(params.sessionKey),'OPENCLAW_SESSION_DENIED','Only a dedicated CoNest session on the bound agent is allowed');
    const frozen=structuredClone(params),epoch=this.#epoch;
    const combined=AbortSignal.any([options.signal,this.#abort.signal,AbortSignal.timeout(timeoutMs)]);
    let active=true;
    const valid=()=>{requireCondition(active&&epoch===this.#epoch,'OPENCLAW_CONNECTION_RETIRED','Stale request callback');this.#check();combined.throwIfAborted();};
    const notify=(fn:(()=>void)|undefined)=>{try{valid();fn?.();}catch(error){if(active&&!combined.aborted)this.#retire(error instanceof HarnessError?error:failure('OPENCLAW_CALLBACK_FAILED'));}};
    requireCondition(this.#inflight<16,'OPENCLAW_REQUEST_LIMIT','Concurrent request capacity exhausted');
    if(method==='agent'){
      const key=params.idempotencyKey as string;
      requireCondition(!this.#used.has(key),'OPENCLAW_REPLAY_DENIED','A native submission key cannot be reused in this connection');
      requireCondition(this.#used.size<5000,'OPENCLAW_REQUEST_LIMIT','Submission key capacity exhausted');this.#used.add(key);
    }
    this.#inflight++;
    let onAbort:(()=>void)|undefined;
    try {
      const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(failure(this.#ended?'OPENCLAW_CONNECTION_RETIRED':options.signal.aborted?'OPENCLAW_REQUEST_ABORTED':'OPENCLAW_REQUEST_TIMEOUT'));combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();});
      valid();
      const response=await Promise.race([this.#client.request(method,frozen,{timeoutMs,signal:combined,expectFinal:options.expectFinal,onSent:()=>notify(options.onSent),onAccepted:value=>notify(()=>options.onAccepted?.(value))}),aborted]);
      valid();return response;
    }catch(error){if(error instanceof HarnessError)throw error;if(error&&typeof error==='object'&&'code' in error&&error.code==='CLIENT_TIMEOUT')throw failure('OPENCLAW_REQUEST_TIMEOUT');throw failure('OPENCLAW_REQUEST_FAILED');}
    finally {active=false;this.#inflight--;if(onAbort)combined.removeEventListener('abort',onAbort);}
  }
  evidence():OpenClawConnectionEvidence {this.#check();requireCondition(this.#ready&&this.#evidence,'OPENCLAW_NOT_READY','Handshake must complete before reading connection evidence');return freeze(structuredClone(this.#evidence));}
  async close():Promise<void> {this.#retire();await this.#drain();}
}
