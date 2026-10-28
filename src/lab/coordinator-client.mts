import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {HarnessError,requireCondition} from '../contracts.mjs';
import {record} from './contracts.mjs';
import type {CoordinatorSnapshot,Evidence,LabAction} from './contracts.mjs';
/** The lab owns this exact coordinator handle; an action cannot supply a PID or executable. */
export class LabCoordinator {
 private child:ChildProcess|undefined;
 private pending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 state:'stopped'|'starting'|'ready'|'exit-observed'='stopped';
 snapshot:CoordinatorSnapshot={instances:[],fences:[],jobs:[],workers:{}};
 constructor(private readonly root:string,private readonly baseURL:string,private readonly runtime:string,private readonly onEvidence:(e:Evidence)=>void){}
 async start():Promise<void>{
  requireCondition(!this.child||this.child.exitCode!==null||this.child.signalCode!==null,'LAB_STAGE','Coordinator is still owned');this.state='starting';
  const child=fork(fileURLToPath(new URL('./coordinator.mjs',import.meta.url)),[this.root,this.baseURL,this.runtime],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)&&!/^(?:https?|all)_proxy$|^NODE_USE_ENV_PROXY$/i.test(key))),NO_PROXY:'*',no_proxy:'*'}});this.child=child;
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new HarnessError('LAB_START_TIMEOUT','Coordinator startup timed out')),30000);
   const failed=()=>{clearTimeout(timer);reject(new HarnessError('LAB_START_FAILED','Coordinator exited during startup'));};
   child.once('error',failed);
   child.once('exit',()=>{failed();this.state='exit-observed';for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(new HarnessError('LAB_OUTCOME_UNKNOWN','Coordinator exited before confirming this command'));this.pending.delete(id);}this.onEvidence({at:new Date().toISOString(),type:'coordinator.exit-observed'});});
   child.on('message',raw=>{
    try{
     const value=record(raw);
     if(value.kind==='ready'||value.kind==='snapshot'){const v=record(value.value);requireCondition(Array.isArray(v.jobs)&&Array.isArray(v.instances)&&Array.isArray(v.fences),'LAB_PROTOCOL','Invalid snapshot');this.snapshot=v as unknown as CoordinatorSnapshot;if(value.kind==='ready'){clearTimeout(timer);this.state='ready';resolve();}return;}
     if(value.kind==='evidence'){const e=record(value.value);if(typeof e.type==='string'&&typeof e.at==='string')this.onEvidence(e as Evidence);return;}
     if(value.kind==='response'&&typeof value.id==='string'){const p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);clearTimeout(p.timer);if(value.ok)p.resolve(value.value);else p.reject(new HarnessError(typeof value.error==='string'?value.error:'LAB_FAILED','Lab action failed'));}
    }catch{reject(new HarnessError('LAB_PROTOCOL','Invalid coordinator reply'));}
   });
  });
 }
 async request(action:LabAction|{id:string;action:'state'}):Promise<unknown>{
  requireCondition(this.state==='ready'&&this.child?.connected,'LAB_COORDINATOR_DOWN','Restart the coordinator first');
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(action.id);reject(new HarnessError('LAB_OUTCOME_UNKNOWN','Command response timed out; inspect state before taking another action'));},15000);
   this.pending.set(action.id,{resolve,reject,timer});this.child!.send(action,error=>{if(error){this.pending.delete(action.id);clearTimeout(timer);reject(new HarnessError('LAB_OUTCOME_UNKNOWN','Command transport was lost'));}});
  });
 }
 async refresh(){if(this.state==='ready')this.snapshot=await this.request({id:randomUUID(),action:'state'}) as CoordinatorSnapshot;return this.snapshot;}
 async crash(){requireCondition(this.state==='ready'&&this.snapshot.jobs.some(j=>j.state==='running'),'LAB_STAGE','Start a waiting task before crashing');await this.kill('SIGKILL');}
 private async kill(signal:NodeJS.Signals){const child=this.child;if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());if(!child.kill(signal))reject(new HarnessError('LAB_STOP_FAILED','Owned coordinator signal failed'));});}
 async close(){if(!this.child||this.child.exitCode!==null||this.child.signalCode!==null)return;const timer=setTimeout(()=>{void this.kill('SIGKILL');},8000);try{await this.kill('SIGTERM');}finally{clearTimeout(timer);}}
}
