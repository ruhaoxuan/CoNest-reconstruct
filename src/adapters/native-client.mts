import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HarnessError, requireCondition } from '../contracts.mjs';
import { nativeMessage, NATIVE_DSH_PROTOCOL } from './native-protocol.mjs';
import type { NativeMessage } from './native-protocol.mjs';
import type { RuntimeCall, RuntimeClient, RuntimeClientConstructor } from './types.mjs';
type Options=ConstructorParameters<RuntimeClientConstructor>[0];
type Pending={resolve:(value:unknown)=>void;reject:(error:unknown)=>void;call?:RuntimeCall;controller:AbortController;clean:()=>void};
/** CoNest-owned IPC. No Gateway, OpenClaw process or upstream Connector protocol. */
export class NativeDshClient implements RuntimeClient {
 private child:ChildProcess|undefined;
 private readonly pending=new Map<string,Pending>();
 private state:'stopped'|'starting'|'ready'|'failed'='stopped';
 private stopping:Promise<void>|undefined;
 constructor(private readonly root:string,private readonly options:Options){}
 async status(){return {state:this.state,pid:this.child?.pid};}
 async start():Promise<void>{
  requireCondition(this.state==='stopped','BRIDGE_UNAVAILABLE','DSH client cannot start in current state');this.state='starting';
  const child=fork(fileURLToPath(new URL('./native-worker.mjs',import.meta.url)),[this.root],{
   cwd:this.options.workspaceRoot,detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],
   // Model credentials are explicit IPC setup values, never inherited by every worker.
   env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key))),execArgv:[]});
  this.child=child;
  await new Promise<void>((resolve,reject)=>{
   let ready=false;
   const timer=setTimeout(()=>{reject(new HarnessError('BRIDGE_UNAVAILABLE','DSH startup timed out'));},this.options.startupTimeoutMs);
   const failed=(error:unknown)=>{clearTimeout(timer);if(!ready)reject(error);};
   child.once('error',failed);
   child.once('exit',()=>{failed(new HarnessError('BRIDGE_EXITED','DSH worker exited'));this.fail();});
   child.once('disconnect',()=>{failed(new HarnessError('BRIDGE_DISCONNECTED','DSH worker disconnected'));if(!this.stopping)this.fail();});
   child.on('message',value=>{
    if(!nativeMessage(value)){this.fail();void this.terminate();return;}
    if(value.kind==='ready') {if(!ready){ready=true;clearTimeout(timer);this.state='ready';resolve();}return;}
    void this.receive(value);
   });
  });
 }
 private fail():void{
  const expected=!!this.stopping||this.state==='stopped';this.state=expected?'stopped':'failed';
  for(const p of this.pending.values()){p.controller.abort();p.clean();p.reject(new HarnessError('BRIDGE_EXITED','DSH worker exited or disconnected'));}this.pending.clear();
  if(!expected)this.options.onFailure?.('DSH worker exited or disconnected');
 }
 private send(value:NativeMessage):void{
  requireCondition(this.child?.connected,'BRIDGE_DISCONNECTED','DSH IPC unavailable');
  requireCondition(Buffer.byteLength(JSON.stringify(value))<=16*1024*1024,'PAYLOAD_TOO_LARGE','DSH IPC payload exceeds limit');
  this.child.send(value,error=>{if(error)this.fail();});
 }
 private async receive(value:NativeMessage):Promise<void>{
  if(value.kind==='result'){
   const p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);p.clean();p.controller.abort();
   if(value.ok)p.resolve(value.value);else p.reject(new HarnessError('DSH_RUN_FAILED','DSH operation failed'));return;
  }
  if(value.kind!=='callback')return;
  const p=this.pending.get(value.parent),callback=p?.call?.callbacks?.[value.name];
  if(!p||!callback||p.controller.signal.aborted){try{this.send({kind:'callback-result',id:value.id,ok:false});}catch{}return;}
  try{const result=await callback(value.value,p.controller.signal);p.controller.signal.throwIfAborted();this.send({kind:'callback-result',id:value.id,ok:true,value:result});}
  catch{try{this.send({kind:'callback-result',id:value.id,ok:false});}catch{}}
 }
 async extension(call:RuntimeCall):Promise<unknown>{return this.request(call.operation,call);}
 private request(operation:RuntimeCall['operation']|'stop',call?:RuntimeCall):Promise<unknown>{
  requireCondition(this.state==='ready','BRIDGE_UNAVAILABLE','DSH worker is not ready');
  const id=randomUUID(),controller=new AbortController();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>abort(new HarnessError('RUN_TIMEOUT','DSH operation timed out')),call?.timeoutMs??this.options.startupTimeoutMs);
   const onAbort=()=>abort(call?.signal?.reason??new HarnessError('RUN_CANCELLED','Cancelled'));
   const clean=()=>{clearTimeout(timer);call?.signal?.removeEventListener('abort',onAbort);};
   const abort=(error:unknown)=>{if(!this.pending.has(id))return;this.pending.delete(id);controller.abort(error);clean();try{this.send({kind:'abort',id});}catch{}reject(error);};
   this.pending.set(id,{resolve,reject,call,controller,clean});call?.signal?.addEventListener('abort',onAbort,{once:true});
   if(call?.signal?.aborted){onAbort();return;}
   try{this.send({kind:'call',version:NATIVE_DSH_PROTOCOL,id,operation,...(call?{setup:call.setup,args:call.args}:{})});}
   catch(error){this.pending.delete(id);clean();reject(error);}
  });
 }
 async stop():Promise<void>{
  if(this.stopping)return this.stopping;
  if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null){this.state='stopped';return;}
  const child=this.child;
  this.stopping=(async()=>{
   const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
   try{
    // Rejecting on timeout keeps ownership; manager may explicitly escalate owned termination.
    if(this.state==='ready')await this.request('stop',{operation:'start',setup:{workspaceRoot:this.options.workspaceRoot,sessionPersistenceRoot:'',enableBridgeProofAdapter:false},timeoutMs:this.options.shutdownTimeoutMs});
    if(child.exitCode===null&&child.signalCode===null){child.disconnect();await exited;}
    this.state='stopped';
   }finally{this.stopping=undefined;}
  })();return this.stopping;
 }
 async terminate():Promise<void>{
  const child=this.child;if(!child||child.exitCode!==null||child.signalCode!==null){this.state='stopped';return;}
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  // Only the ChildProcess created here, never a configured PID or a remote service.
  this.stopping=exited;
  try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid!,'SIGKILL');await exited;this.state='stopped';}
  finally{this.stopping=undefined;}
 }
}
