import path from 'node:path';
import {mkdir,open} from 'node:fs/promises';
import {createDshProvider} from './dsh.mjs';
import {loadPinnedClient} from './pinned-runtime.mjs';
import type {RuntimeClient,RuntimeClientConstructor} from './types.mjs';
import type {Evidence} from '../lab/contracts.mjs';
import {uuid} from '../lab/contracts.mjs';
import {requireCondition} from '../contracts.mjs';
/** Explicit lab entry only. Controls close over the clients created here; never user PIDs. */
export function createLabDsh(runtime:string,root:string,baseURL:string,notify:(e:Evidence)=>void){
 const failures=new Map<string,NonNullable<ConstructorParameters<RuntimeClientConstructor>[0]['onFailure']>>();
 const clients=new Map<string,RuntimeClient>(),workers:Record<string,string>={},gates=new Map<string,()=>void>();
 const emit=(type:string,instanceId:string,runId?:string,callId?:string)=>notify({at:new Date().toISOString(),type,instanceId,...(runId?{runId}:{}),...(callId?{callId}:{})});
 const provider=createDshProvider({runtimeRoot:runtime,resolveModelRoute:()=>({baseURL,apiKey:'synthetic-dsh-lab-key'}),
  loadClient:async()=>{
   const Client=await loadPinnedClient(runtime);
   return class extends Client{
    constructor(options:ConstructorParameters<typeof Client>[0]){
     const id=path.basename(options.workspaceRoot);let owned:RuntimeClient|undefined;
     super({...options,onFailure:(message,code)=>{if(clients.get(id)!==owned)return;workers[id]=code==='PROCESS_EXITED'?'exit-observed':'transport-lost';emit(workers[id]!,id);options.onFailure?.(message,code);}});
     owned=this;clients.set(id,this);if(options.onFailure)failures.set(id,options.onFailure);workers[id]='created';
    }
   };
  },
  resolveTurn:task=>({sessionKey:task.runId,hostSessionId:task.runId,hostAgentId:task.instanceId,hostLifecycleRevision:task.generation,provider:'deepseek-official',model:'deepseek-v4-flash',assertActive(){},hostTools:[{
   name:'lab_receipt',description:'Write a synthetic receipt in this isolated lab, then wait for operator release',parameters:{type:'object',properties:{},additionalProperties:false},permissions:['lab:receipt'],
   async execute(callId,_args,signal){
    const runId=uuid(task.runId);emit('tool.started',task.instanceId,runId,callId);
    // Install the release gate before publishing the committed receipt.
    let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});gates.set(runId,release);
    const directory=path.join(root,'receipts');await mkdir(directory,{recursive:true,mode:0o700});
    try{
     const handle=await open(path.join(directory,runId+'.json'),'wx',0o600);
     try{await handle.writeFile(JSON.stringify({runId,callId,committedAt:new Date().toISOString(),synthetic:true}));await handle.sync();}finally{await handle.close();}
     emit('tool.receipt-committed',task.instanceId,runId,callId);
     const aborted=()=>emit('tool.cancel-observed',task.instanceId,runId,callId);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
     try{await gate;}finally{signal.removeEventListener('abort',aborted);}
     emit('tool.returned',task.instanceId,runId,callId);return {content:[{type:'text',text:'SYNTHETIC_RECEIPT_COMMITTED'}]};
    }finally{gates.delete(runId);}
   }
  }]})});
 return {provider,workers,
  ready(id:string){workers[id]='ready';emit('worker.ready',id);},
  release(runId:string){const release=gates.get(runId);requireCondition(release,'LAB_STAGE','No delayed tool for this run');release();},
  releaseAll(){for(const release of gates.values())release();},
  async terminate(id:string){const client=clients.get(id);requireCondition(client?.terminate,'LAB_STAGE','No owned worker');await client.terminate();workers[id]='exit-observed';failures.get(id)?.('Lab-owned worker exit confirmed','PROCESS_EXITED');emit('worker.exit-observed',id);},
 };
}
