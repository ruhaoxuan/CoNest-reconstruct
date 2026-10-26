import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { nativeMessage, NATIVE_DSH_PROTOCOL } from './native-protocol.mjs';
import type { NativeHost, NativeMessage } from './native-protocol.mjs';
import { requireCondition } from '../contracts.mjs';
const root=process.argv[2];requireCondition(root&&process.send,'BRIDGE_UNAVAILABLE','Private SDK worker requires a runtime and IPC');
const module:unknown=await import(pathToFileURL(path.join(root,'dist/studio/cordis-bridge-host.js')).href);
requireCondition(module&&typeof module==='object'&&'CordisBridgeHost' in module&&typeof module.CordisBridgeHost==='function','RUNTIME_MISMATCH','Native DSH host missing');
const Host=module.CordisBridgeHost as new()=>NativeHost,host=new Host();
const runs=new Map<string,AbortController>();
const callbacks=new Map<string,{parent:string;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>();
const send=(value:NativeMessage)=>{if(process.connected)process.send!(value);};
function callback(parent:string,name:string,value:unknown):Promise<unknown>{
 const signal=runs.get(parent)?.signal;if(!signal||signal.aborted)return Promise.reject(new Error('Expired turn'));
 const id=randomUUID();return new Promise((resolve,reject)=>{callbacks.set(id,{parent,resolve,reject});send({kind:'callback',id,parent,name,value});});
}
function abort(id:string):void{runs.get(id)?.abort();for(const [key,c] of callbacks)if(c.parent===id){callbacks.delete(key);c.reject(new Error('Cancelled'));}}
process.on('message',value=>{void receive(value).catch(()=>{process.exitCode=1;process.disconnect();});});
async function receive(value:unknown):Promise<void>{
 requireCondition(nativeMessage(value),'INVALID_REQUEST','Malformed private IPC');
 if(value.kind==='abort'){abort(value.id);return;}
 if(value.kind==='callback-result'){const c=callbacks.get(value.id);if(!c)return;callbacks.delete(value.id);if(value.ok)c.resolve(value.value);else c.reject(new Error('Host callback rejected'));return;}
 if(value.kind!=='call')return;
 const controller=new AbortController();requireCondition(!runs.has(value.id),'INVALID_REQUEST','Duplicate private request');runs.set(value.id,controller);
 try{
  let result:unknown;
  if(value.operation==='stop'){for(const id of runs.keys())if(id!==value.id)abort(id);await host.stop();}
  else if(value.operation==='start'){requireCondition(value.setup,'INVALID_REQUEST','Missing setup');await host.start(value.setup);}
  else if(value.operation==='endHarnessSession')await host.endHarnessSession(value.args??{});
  else{
   const args=value.args??{};const raw=args.hostTools;requireCondition(Array.isArray(raw),'INVALID_REQUEST','Explicit tool surface required');
   const tools=raw.map(value=>{requireCondition(value&&typeof value==='object'&&typeof value.name==='string','INVALID_REQUEST','Malformed tool');const tool=value as Record<string,unknown>;return {...tool,execute:(callId:string,args:unknown)=>callback(valueId,'tool',{name:tool.name,callId,args})};});
   const valueId=value.id;
   result=await host.runHarnessAgent({...args,hostTools:tools,signal:controller.signal,
    onEvent:(event:unknown)=>callback(value.id,'event',event),approvalRequester:(request:unknown)=>callback(value.id,'approval',request)});
  }
  send({kind:'result',id:value.id,ok:true,value:result});
 }catch{send({kind:'result',id:value.id,ok:false});}
 finally{abort(value.id);runs.delete(value.id);}
}
process.once('disconnect',()=>{setTimeout(()=>process.exit(1),5000).unref();for(const id of runs.keys())abort(id);void host.stop().finally(()=>process.exit());});
send({kind:'ready',version:NATIVE_DSH_PROTOCOL});
