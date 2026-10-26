import { randomUUID } from 'node:crypto';
import { HarnessError, requireCondition } from './contracts.mjs';
export const RPC_VERSION=1;
export const RPC_METHODS:Record<string,{route:string;read?:boolean}>={
  'audit.list':{route:'/api/audit',read:true},'instance.list':{route:'/api/state',read:true},'instance.start':{route:'/api/start'},'instance.stop':{route:'/api/stop'},
  'task.run':{route:'/api/run'},'task.cancel':{route:'/api/cancel'},'access.revoke':{route:'/api/revoke'},'access.restore':{route:'/api/restore'},
  'policy.get':{route:'/api/policy',read:true},'policy.update':{route:'/api/policy'},'config.schema':{route:'/api/schema',read:true},'restart.reset':{route:'/api/reset-restarts'},'credential.revoke':{route:'/api/credential-revoke'},'credential.restore':{route:'/api/credential-restore'},
};
/** No retry: transport loss after a mutation has an uncertain outcome. Keep the
 * same request ID for an explicit status/retry against the server's ledger. */
export class HarnessRpcClient {
  constructor(readonly endpoint:string,private readonly token:()=>string) {
    const url=new URL(endpoint);requireCondition(!url.username&&!url.password&&!url.search&&!url.hash&&
      (url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))), 'INVALID_CONFIG','RPC requires HTTPS or loopback HTTP');
  }
  async request(method:string,params:Record<string,unknown>={},options:{signal?:AbortSignal;id?:string;timeoutMs?:number}={}):Promise<unknown>{
    requireCondition(RPC_METHODS[method],'RPC_METHOD','Unknown RPC method');const id=options.id??randomUUID();
    let response:Response;
    try{response=await fetch(this.endpoint,{method:'POST',redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs??30000)]):AbortSignal.timeout(options.timeoutMs??30000),
      headers:{Authorization:'Bearer '+this.token(),'Content-Type':'application/json'},body:JSON.stringify({version:RPC_VERSION,id,method,params})});}
    catch{throw new HarnessError(RPC_METHODS[method]?.read?'RPC_UNAVAILABLE':'RPC_OUTCOME_UNKNOWN','Request was not replayed');}
    if(response.status===401)throw new HarnessError('RPC_UNAUTHORIZED','RPC credential rejected');
    const text=await response.text();requireCondition(Buffer.byteLength(text)<=25*1024*1024,'RPC_RESPONSE','Response too large');
    let raw:unknown;try{raw=JSON.parse(text);}catch{throw new HarnessError('RPC_RESPONSE','Invalid response');}
    requireCondition(raw&&typeof raw==='object','RPC_RESPONSE','Invalid RPC envelope');const value=raw as Record<string,unknown>;
    requireCondition(value.version===RPC_VERSION&&value.id===id,'RPC_VERSION','Response protocol mismatch');
    if(!response.ok||value.ok!==true){const error=value.error as Record<string,unknown>|undefined;throw new HarnessError(typeof error?.code==='string'?error.code:'RPC_FAILED','RPC failed');}
    return value.result;
  }
}
