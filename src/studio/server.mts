import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { HarnessEvent } from '../types.mjs';
import type { HarnessManager } from '../manager.mjs';
import { requireCondition } from '../contracts.mjs';
import { page } from './page.mjs';

export type Trace = { at: string; runId: string; sequence: number; type: string; name?: string; callId?: string; status?: string; durationMs?: number; preview?: string; errorCode?: string; previewTruncated?: boolean };
type Job = { runId?: string; cancelRequested: boolean; resultTruncated: boolean; events: Trace[]; droppedEvents: number; id: string; instanceId: string; state: 'running'|'completed'|'cancelled'|'failed'|'timed-out'|'revoked'|'interrupted'; startedAt: string; text: string; controller: AbortController; done: Promise<void> };
export type StudioPermission = 'state:read' | 'instance:control' | 'task:run' | 'task:cancel' | 'access:manage';
export const STUDIO_PERMISSIONS: readonly StudioPermission[] = Object.freeze(['state:read','instance:control','task:run','task:cancel','access:manage']);
export interface StudioOptions {
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
  const jobs=new Map<string,Job>();let closing=false;
  const digest=(s:string)=>createHash('sha256').update(s).digest();
  const nonce=randomUUID();
  const snapshot=(permissions: readonly StudioPermission[])=>({mode:options.mode,permissions,instances:options.manager.list(),jobs:[...jobs.values()].map(({controller,done,...rest})=>({...rest,executionState:rest.runId ? options.manager.isRunActive(rest.instanceId,rest.runId)?'active':'settled' : rest.state==='running'?'pending':'not-admitted'}))});
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    try {
      const port=(server.address() as {port:number}).port;
      const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!hosts.includes(req.headers.host??'')){res.writeHead(403);res.end();return;}
      if(req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`)){res.writeHead(403);res.end();return;}
      const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
      if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page(nonce, options.mode));return;}
      res.setHeader('Content-Type','application/json; charset=utf-8');
      const grant=grants.find(g=>timingSafeEqual(digest(req.headers.authorization??''),digest('Bearer '+g.token)));
      if(!grant){res.writeHead(401);res.end(json({error:'Access token required'}));return;}
      if(closing){res.writeHead(503);res.end(json({error:'Studio is closing'}));return;}
      const permissions=grant.permissions;
      const permission: StudioPermission | undefined = req.method==='GET'&&url.pathname==='/api/state' ? 'state:read' : ({'/api/start':'instance:control','/api/stop':'instance:control','/api/run':'task:run','/api/cancel':'task:cancel','/api/revoke':'access:manage','/api/restore':'access:manage'} as Record<string,StudioPermission>)[url.pathname];
      if(permission&&!permissions.includes(permission)){res.writeHead(403);res.end(json({error:'MANAGEMENT_DENIED'}));return;}
      if(req.method==='GET'&&url.pathname==='/api/state'){res.end(json(snapshot(permissions)));return;}
      if(req.method!=='POST'){res.writeHead(404);res.end('{}');return;}
      requireCondition(req.headers['content-type']?.startsWith('application/json'),'INVALID_REQUEST','JSON content type required');
      const data=await body(req);
      if(url.pathname==='/api/cancel'){
        requireCondition(typeof data.id==='string','INVALID_REQUEST','Job id required');const job=jobs.get(data.id);
        requireCondition(job,'INVALID_REQUEST','Unknown job');if(job.state==='running'){job.cancelRequested=true;job.controller.abort();}
        res.end(json({accepted:true}));return;
      }
      requireCondition(typeof data.instanceId==='string','INVALID_REQUEST','Instance id required');const id=data.instanceId;
      if(url.pathname==='/api/start'){await options.manager.start(id);}
      else if(url.pathname==='/api/stop'){for(const job of jobs.values())if(job.instanceId===id&&job.state==='running'){job.cancelRequested=true;job.controller.abort();}await options.manager.stop(id);}
      else if(url.pathname==='/api/revoke'){options.manager.setTaskAccess(id,false);}
      else if(url.pathname==='/api/restore'){options.manager.setTaskAccess(id,true);}
      else if(url.pathname==='/api/run'){
        requireCondition(options.manager.snapshot(id).state==='ready','INSTANCE_NOT_READY','Start the instance first');
        requireCondition(options.manager.snapshot(id).taskAccess==='enabled','TASK_ACCESS_REVOKED','Task access is revoked');
        requireCondition(options.manager.snapshot(id).activeRuns===0,'INSTANCE_BUSY','Previous work has not settled');
        requireCondition(typeof data.input==='string'&&Buffer.byteLength(data.input)<=8000,'INVALID_REQUEST','Input must be at most 8KB');
        requireCondition(![...jobs.values()].some(j=>j.instanceId===id&&j.state==='running'),'INSTANCE_BUSY','One Studio job per instance at a time');
        if(jobs.size>=100){const oldest=[...jobs.values()].find(j=>j.state!=='running');requireCondition(oldest,'INSTANCE_BUSY','Job limit reached');jobs.delete(oldest.id);}
        const controller=new AbortController();
        const job:Job={cancelRequested:false,resultTruncated:false,events:[],droppedEvents:0,id:randomUUID(),instanceId:id,state:'running',startedAt:new Date().toISOString(),text:'',controller,done:Promise.resolve()};jobs.set(job.id,job);
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
          job.events.push(trace);
        };
        job.done=Promise.resolve().then(()=>options.submitTask(id,data.input as string,controller.signal,onEvent)).then(result=>{
          if(controller.signal.aborted){job.state='cancelled';return;}
          job.state='completed';const text=typeof result==='object'&&result!==null&&'finalText' in result?safe(String(result.finalText)):json(result);job.resultTruncated=text.length>8000;job.text=text.slice(0,8000);
        }).catch((error: unknown)=>{const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'RUN_FAILED';job.state=code==='RUN_REVOKED'?'revoked':code==='RUN_INTERRUPTED'?'interrupted':code==='RUN_TIMEOUT'?'timed-out':controller.signal.aborted||code==='RUN_CANCELLED'?'cancelled':'failed';job.text=code;});
        res.writeHead(202);res.end(json({jobId:job.id}));return;
      }else{res.writeHead(404);res.end('{}');return;}
      res.end(json(permissions.includes('state:read') ? snapshot(permissions) : {accepted:true}));
    }catch(error){res.writeHead(400);res.end(json({error:error instanceof Error&&'code' in error?String(error.code):'INVALID_REQUEST'}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18801,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const port=(server.address() as {port:number}).port;
  return {url:`http://127.0.0.1:${port}`,async close(){
    closing=true;for(const job of jobs.values())job.controller.abort();
    try { await Promise.all(options.manager.list().map(i=>options.manager.stop(i.id))); }
    finally { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  }};
}
