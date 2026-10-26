import { createServer, type IncomingMessage } from 'node:http';
import { RPC_METHODS, RPC_VERSION } from '../rpc.mjs';
import { canonical } from '../publication.mjs';
import { identifier } from '../contracts.mjs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { HarnessEvent } from '../types.mjs';
import type { HarnessManager } from '../manager.mjs';
import { requireCondition } from '../contracts.mjs';
import type { LocalStateStore } from '../state-store.mjs';
import { page } from './page.mjs';

export type Trace = { at: string; runId: string; sequence: number; type: string; name?: string; callId?: string; status?: string; durationMs?: number; preview?: string; errorCode?: string; previewTruncated?: boolean };
type Job = { historical?:boolean;storedExecutionState?:string; recovered?: boolean; runId?: string; cancelRequested: boolean; resultTruncated: boolean; events: Trace[]; droppedEvents: number; id: string; instanceId: string; state: 'running'|'completed'|'cancelled'|'failed'|'timed-out'|'revoked'|'interrupted'; startedAt: string; text: string; controller: AbortController; done: Promise<void> };
export type StudioPermission = 'state:read' | 'instance:control' | 'task:run' | 'task:cancel' | 'access:manage';
export const STUDIO_PERMISSIONS: readonly StudioPermission[] = Object.freeze(['state:read','instance:control','task:run','task:cancel','access:manage']);
export interface StudioOptions {
  store?: LocalStateStore;
  credentialControl?: (reference:string,revoked:boolean)=>Promise<void>;
  additionalTokens?: readonly { token: string; permissions: readonly StudioPermission[] }[];
  manager: HarnessManager;
  token: string;
  port?: number;
  mode: 'proof' | 'live';
  redact?: (text: string) => string;
  submitTask(instanceId: string, input: string, signal: AbortSignal, onEvent?: (event: HarnessEvent) => void): Promise<unknown>;
}
async function body(req: IncomingMessage): Promise<Record<string,unknown>> {
  let text='';for await(const chunk of req){text+=String(chunk);requireCondition(Buffer.byteLength(text)<=16000,'INVALID_REQUEST','Request exceeds 16KB');}
  const value:unknown=JSON.parse(text || '{}');requireCondition(value!==null && typeof value==='object'&&!Array.isArray(value),'INVALID_REQUEST','Expected JSON object');
  return value as Record<string,unknown>;
}
export async function startStudio(options: StudioOptions) {
  requireCondition(options.token.length>=32,'INVALID_REQUEST','Studio token must contain at least 32 characters');
  const safe = (text: string) => options.redact?.(text) ?? text;
  const json = (value: unknown) => safe(JSON.stringify(value));
  const grants = [{token:options.token,permissions:STUDIO_PERMISSIONS},...(options.additionalTokens ?? [])].map(g=>({token:g.token,permissions:[...g.permissions]}));
  requireCondition(new Set(grants.map(g=>g.token)).size===grants.length && grants.every(g=>g.token.length>=32&&g.permissions.every(p=>STUDIO_PERMISSIONS.includes(p))), 'INVALID_REQUEST', 'Invalid Studio token grant');
  const rpcCache=new Map<string,{fingerprint:string,response?:string,completed?:boolean}>();
  const jobs=new Map<string,Job>();let closing=false;
  for(const raw of options.store?.restoredJobs()??[]){const value=raw as Job;requireCondition(typeof value.id==='string'&&typeof value.instanceId==='string'&&Array.isArray(value.events),'STATE_INVALID','Invalid stored job');jobs.set(value.id,{...value,controller:new AbortController(),done:Promise.resolve(),historical:true,recovered:value.recovered===true,storedExecutionState:(value as unknown as {executionState?:string}).executionState??'unknown'});}
  const execution=(job:Job):string=>job.historical?job.storedExecutionState??'unknown':job.runId&&options.manager.isRunUncertain(job.instanceId,job.runId)?'unknown':job.runId?options.manager.isRunActive(job.instanceId,job.runId)?'active':'settled':job.state==='running'?'pending':'not-admitted';
  const saved=()=>[...jobs.values()].map(job=>{const {controller,done,...rest}=job;return {...rest,executionState:execution(job)};});
  const persist=()=>options.store?.saveJobs(saved());
  const digest=(s:string)=>createHash('sha256').update(s).digest();
  const nonce=randomUUID();
  const snapshot=(permissions: readonly StudioPermission[])=>({mode:options.mode,permissions,storage:options.store?.status(),instances:options.manager.list(),jobs:saved()});
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    let rpcId:string|undefined,ledgerKey:string|undefined,ledgerEntry:{fingerprint:string,response?:string,completed?:boolean}|undefined;
    const encode=(value:unknown)=>{
      const encoded=json(rpcId?{version:RPC_VERSION,id:rpcId,...(res.statusCode>=400?{ok:false,error:{code:value&&typeof value==='object'&&'error' in value?String(value.error):'RPC_FAILED'}}:{ok:true,result:value})}:value);
      if(ledgerKey&&ledgerEntry){options.store?.recordControl({type:'rpc.response',requestId:rpcId,status:res.statusCode});ledgerEntry.completed=true;ledgerEntry.response=encoded;try{options.store?.finishRpc(ledgerKey,encoded);}catch{res.statusCode=503;return json({version:RPC_VERSION,id:rpcId,ok:false,error:{code:'RPC_OUTCOME_UNKNOWN'}});}}
      return encoded;
    };
    try {
      const port=(server.address() as {port:number}).port;
      const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!hosts.includes(req.headers.host??'')){res.writeHead(403);res.end();return;}
      if(req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`)){res.writeHead(403);res.end();return;}
      let url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
      if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page(nonce, options.mode));return;}
      res.setHeader('Content-Type','application/json; charset=utf-8');
      const grant=grants.find(g=>timingSafeEqual(digest(req.headers.authorization??''),digest('Bearer '+g.token)));
      if(!grant){res.writeHead(401);res.end(encode({error:'Access token required'}));return;}
      if(closing){res.writeHead(503);res.end(encode({error:'Studio is closing'}));return;}
      let rpcBody:Record<string,unknown>|undefined;
      const permissions=grant.permissions;
      let method=req.method;
      if(method==='POST'&&url.pathname==='/rpc'){
        requireCondition(req.headers['content-type']?.startsWith('application/json'),'INVALID_REQUEST','JSON content type required');const envelope=await body(req);rpcId=identifier(envelope.id,'RPC request id');
        requireCondition(envelope.version===RPC_VERSION,'RPC_VERSION','Unsupported RPC version');
        requireCondition(typeof envelope.method==='string'&&RPC_METHODS[envelope.method],'RPC_METHOD','Unknown RPC method');
        const route=RPC_METHODS[envelope.method]!;
        requireCondition(envelope.params!==null&&typeof envelope.params==='object'&&!Array.isArray(envelope.params),'INVALID_REQUEST','RPC params object required');
        rpcBody=envelope.params as Record<string,unknown>;url=new URL(route.route,`http://127.0.0.1:${port}`);method=route.read?'GET':'POST';
        if(route.read&&typeof rpcBody.instanceId==='string')url.searchParams.set('instanceId',rpcBody.instanceId);if(route.read&&rpcBody.limit!==undefined)url.searchParams.set('limit',String(rpcBody.limit));
      }

      const permission: StudioPermission | undefined = method==='GET'&&['/api/state','/api/schema','/api/audit'].includes(url.pathname) ? 'state:read' : ({'/api/start':'instance:control','/api/stop':'instance:control','/api/run':'task:run','/api/cancel':'task:cancel','/api/revoke':'access:manage','/api/restore':'access:manage','/api/policy':'access:manage','/api/reset-restarts':'access:manage','/api/credential-revoke':'access:manage','/api/credential-restore':'access:manage'} as Record<string,StudioPermission>)[url.pathname];
      if(permission&&!permissions.includes(permission)){res.writeHead(403);res.end(encode({error:'MANAGEMENT_DENIED'}));return;}
      if(rpcBody&&method==='POST'){
        ledgerKey=[...permissions].sort().join(',')+':'+rpcId;const fingerprint=createHash('sha256').update(canonical({route:url.pathname,params:rpcBody})).digest('hex');
        const existing=rpcCache.get(ledgerKey);if(existing){requireCondition(existing.fingerprint===fingerprint,'RPC_CONFLICT','Request ID conflict');requireCondition(existing.response,existing.completed?'RPC_RECEIPT_EXPIRED':'RPC_OUTCOME_UNKNOWN','Request cannot be replayed');res.end(existing.response);return;}
        const stored=options.store?.reserveRpc(ledgerKey,fingerprint);if(stored?.response){res.end(stored.response);return;}
        requireCondition(!stored?.expired,'RPC_RECEIPT_EXPIRED','Request already executed; response history expired');
        requireCondition(!stored?.pending,'RPC_OUTCOME_UNKNOWN','Previous coordinator did not confirm outcome');
        requireCondition(rpcCache.size<50000,'RPC_LEDGER_FULL','Request ledger full');if([...rpcCache.values()].filter(v=>v.response).length>=512){const old=[...rpcCache.values()].find(v=>v.response);if(old)old.response=undefined;}
        ledgerEntry={fingerprint};rpcCache.set(ledgerKey,ledgerEntry);options.store?.recordControl({type:'rpc.request',requestId:rpcId,method:url.pathname,instanceId:typeof rpcBody.instanceId==='string'?rpcBody.instanceId:undefined});
      }
      if(method==='GET'&&url.pathname==='/api/audit'){const limit=Number(url.searchParams.get('limit')??100);requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=5000,'INVALID_REQUEST','Audit limit must be 1..5000');options.store?.flush();res.end(encode({available:Boolean(options.store),records:options.store?.audit(limit)??[]}));return;}
      if(method==='GET'&&url.pathname==='/api/schema'){res.end(encode(options.manager.configSchema()));return;}
      if(method==='GET'&&url.pathname==='/api/policy'){res.end(encode({policy:options.manager.policy(url.searchParams.get('instanceId')??'')}));return;}
      if(method==='GET'&&url.pathname==='/api/state'){res.end(encode(snapshot(permissions)));return;}
      if(method!=='POST'){res.writeHead(404);res.end('{}');return;}
      requireCondition(req.headers['content-type']?.startsWith('application/json'),'INVALID_REQUEST','JSON content type required');
      const data=rpcBody??await body(req);
      if(url.pathname==='/api/cancel'){
        requireCondition(typeof data.id==='string','INVALID_REQUEST','Job id required');const job=jobs.get(data.id);
        requireCondition(job,'INVALID_REQUEST','Unknown job');if(job.state==='running'){job.cancelRequested=true;job.controller.abort();}
        res.end(encode({accepted:true}));return;
      }
      if(['/api/credential-revoke','/api/credential-restore'].includes(url.pathname)){requireCondition(options.credentialControl&&typeof data.reference==='string','INVALID_REQUEST','Credential reference required');await options.credentialControl(data.reference,url.pathname.endsWith('revoke'));res.end(encode({accepted:true}));return;}
      requireCondition(typeof data.instanceId==='string','INVALID_REQUEST','Instance id required');const id=data.instanceId;
      if(url.pathname==='/api/start'){await options.manager.start(id);}
      else if(url.pathname==='/api/stop'){for(const job of jobs.values())if(job.instanceId===id&&job.state==='running'){job.cancelRequested=true;job.controller.abort();}await options.manager.stop(id,{force:data.force===true});}
      else if(url.pathname==='/api/revoke'){await options.manager.updateAccess(id,false);}
      else if(url.pathname==='/api/restore'){await options.manager.updateAccess(id,true);}
      else if(url.pathname==='/api/policy'){await options.manager.updatePolicy(id,data.policy);}
      else if(url.pathname==='/api/reset-restarts'){options.manager.resetRestartBudget(id);}
      else if(url.pathname==='/api/run'){
        requireCondition(options.manager.snapshot(id).state==='ready','INSTANCE_NOT_READY','Start the instance first');
        requireCondition(options.manager.snapshot(id).taskAccess==='enabled','TASK_ACCESS_REVOKED','Task access is revoked');
        requireCondition(options.manager.snapshot(id).activeRuns===0,'INSTANCE_BUSY','Previous work has not settled');
        requireCondition(typeof data.input==='string'&&Buffer.byteLength(data.input)<=8000,'INVALID_REQUEST','Input must be at most 8KB');
        requireCondition(![...jobs.values()].some(j=>j.instanceId===id&&j.state==='running'),'INSTANCE_BUSY','One Studio job per instance at a time');
        if(jobs.size>=100){const oldest=[...jobs.values()].find(j=>j.state!=='running');requireCondition(oldest,'INSTANCE_BUSY','Job limit reached');jobs.delete(oldest.id);}
        const controller=new AbortController();
        const job:Job={cancelRequested:false,resultTruncated:false,events:[],droppedEvents:0,id:randomUUID(),instanceId:id,state:'running',startedAt:new Date().toISOString(),text:'',controller,done:Promise.resolve()};jobs.set(job.id,job);try{options.store?.commitJobs(saved());}catch(error){jobs.delete(job.id);throw error;}
        const onEvent = (event: HarnessEvent) => {
          if(event.type==='run.started')job.runId=event.runId;
          const trace: Trace = { at: event.at, runId: event.runId, sequence: event.sequence, type: event.type };
          if (event.type === 'provider.progress') {
            const data = event.data;
            if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'tool') return;
            const value = data as Record<string, unknown>;
            if (typeof value.name !== 'string' || typeof value.callId !== 'string' ||
                !['running','completed','failed','cancelled'].includes(String(value.status))) return;
            trace.name = safe(value.name.slice(0, 128)); trace.callId = value.callId.slice(0, 128); trace.status = String(value.status);
            if (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)) trace.durationMs = value.durationMs;
            if (value.previewTruncated === true) trace.previewTruncated = true;
            if (typeof value.preview === 'string') trace.preview = safe(value.preview).slice(0, 2000);
            if (typeof value.errorCode === 'string') trace.errorCode = /^[A-Z_]{1,64}$/.test(value.errorCode) ? value.errorCode : 'TOOL_FAILED';
          }
          if (job.events.length >= 100) { job.events.shift(); job.droppedEvents++; }
          job.events.push(trace);persist();
        };
        job.done=Promise.resolve().then(()=>options.submitTask(id,data.input as string,controller.signal,onEvent)).then(result=>{
          if(controller.signal.aborted){job.state='cancelled';return;}
          job.state='completed';const text=typeof result==='object'&&result!==null&&'finalText' in result?safe(String(result.finalText)):json(result);job.resultTruncated=text.length>8000;job.text=text.slice(0,8000);
        }).catch((error: unknown)=>{const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'RUN_FAILED';job.state=code==='RUN_REVOKED'?'revoked':code==='RUN_INTERRUPTED'?'interrupted':code==='RUN_TIMEOUT'?'timed-out':controller.signal.aborted||code==='RUN_CANCELLED'?'cancelled':'failed';job.text=code;}).finally(persist);
        res.writeHead(202);res.end(encode({jobId:job.id}));return;
      }else{res.writeHead(404);res.end('{}');return;}
      res.end(encode(rpcId?(permissions.includes('state:read')?{accepted:true,instance:options.manager.snapshot(id)}:{accepted:true}):permissions.includes('state:read') ? snapshot(permissions) : {accepted:true}));
    }catch(error){res.writeHead(400);res.end(encode({error:error instanceof Error&&'code' in error?String(error.code):'INVALID_REQUEST'}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18801,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const port=(server.address() as {port:number}).port;
  return {url:`http://127.0.0.1:${port}`,async close(){
    closing=true;for(const job of jobs.values())job.controller.abort();
    try { await Promise.all(options.manager.list().map(i=>options.manager.stop(i.id))); }
    finally { persist();options.store?.flush();options.store?.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  }};
}
