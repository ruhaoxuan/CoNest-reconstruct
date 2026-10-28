import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {HarnessManager} from '../manager.mjs';
import {HarnessRegistry} from '../registry.mjs';
import {LocalStateStore} from '../state-store.mjs';
import {createLabDsh} from '../adapters/dsh-fault-lab.mjs';
import {HarnessError,requireCondition} from '../contracts.mjs';
import {publicText} from '../public-v2.mjs';
import {parseLabAction,parseSavedJob,record,uuid} from './contracts.mjs';
import type {LabJob,CoordinatorSnapshot,Evidence} from './contracts.mjs';
const [root,baseURL,runtime]=process.argv.slice(2);
requireCondition(root&&baseURL&&runtime&&process.send,'LAB_PRIVATE','Private lab coordinator requires explicit owned IPC');
const endpoint=new URL(baseURL);requireCondition(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&endpoint.pathname==='/'&&!endpoint.username&&!endpoint.password,'LAB_PRIVATE','Only the owned localhost fixture is allowed');
const store=await LocalStateStore.open(root),jobs=new Map<string,LabJob>(),controls=new Map<string,AbortController>(),running=new Set<Promise<void>>();
for(const raw of store.restoredJobs()){const job=parseSavedJob(raw);try{const receipt=record(JSON.parse(await readFile(path.join(root,'receipts',job.runId+'.json'),'utf8')));if(receipt.runId===job.runId&&typeof receipt.callId==='string'&&typeof receipt.committedAt==='string'&&!job.events.some(e=>e.type==='tool.receipt-committed'&&e.callId===receipt.callId))job.events.push({at:receipt.committedAt,type:'tool.receipt-committed',runId:job.runId,instanceId:job.instanceId,callId:receipt.callId.slice(0,512)});}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}jobs.set(job.id,job);}
let manager:HarnessManager|undefined,closing=false;
const send=(value:unknown)=>{if(process.connected)process.send!(value);};
const evidence=(e:Evidence)=>{const job=e.runId?jobs.get(e.runId):undefined;if(job){job.events.push(e);if(job.events.length>100)job.events.shift();}send({kind:'evidence',value:e});};
const lab=createLabDsh(runtime,root,baseURL,evidence),registry=new HarnessRegistry();registry.register(lab.provider);
manager=new HarnessManager(registry,{executions:{save:value=>store.saveExecution(value),remove:(value,why)=>store.removeExecution(value,why)},onEvent:event=>store.record(event)});
for(const id of ['a','b']){
 await mkdir(path.join(root,id),{recursive:true});
 manager.createConfigured({id,provider:'dsh',providerConfigVersion:1,providerConfig:{workspaceRoot:path.join(root,id),sessionPersistenceRoot:path.join(root,'sessions-'+id)},policy:{subjects:['lab'],allow:['lab:receipt']},control:{defaultRunTimeoutMs:300000,maxRunTimeoutMs:300000,stopGraceMs:5000}});
}
manager.restoreExecutions(store.executionFences());
// A bounded history update can lag durable execution settlement. Preserve ambiguous legacy history conservatively.
for(const job of jobs.values())if(job.executionState==='unknown'&&!manager.executionFences(job.instanceId).some(f=>f.runId===job.runId))manager.restoreExecutions([{instanceId:job.instanceId,runId:job.runId,generation:'lab-history-recovery',providerId:'dsh',providerVersion:lab.provider.version,subject:'lab',token:randomUUID(),createdAt:new Date().toISOString(),status:'uncertain'}]);
function snapshot():CoordinatorSnapshot{
 const m=manager!;
 for(const job of jobs.values()){
  const fence=m.executionFences(job.instanceId).find(f=>f.runId===job.runId);
  job.executionState=fence?.status==='acknowledged'?'acknowledged-unknown':fence?.status==='uncertain'?'unknown':m.isRunActive(job.instanceId,job.runId)?'active':job.state==='running'?'active':job.executionState==='unknown'?'unknown':'settled';
 }
 return {instances:m.list(),fences:m.executionFences(),jobs:[...jobs.values()],workers:{...lab.workers}};
}
const publish=()=>{if(closing)return;const state=snapshot();store.saveJobs(state.jobs);send({kind:'snapshot',value:state});};
async function command(raw:unknown):Promise<unknown>{
 const v=record(raw);uuid(v.id);
 if(v.action==='state'){const state=snapshot();store.saveJobs(state.jobs);return state;}
 const action=parseLabAction(v),m=manager!;
 if(action.action==='run'){
  requireCondition(jobs.size<100,'LAB_LIMIT','This lab retains at most 100 runs; choose a fresh lab state');
  requireCondition(m.snapshot(action.instanceId).activeRuns===0,'INSTANCE_BUSY','Release previous tool work first');
  requireCondition(!m.snapshot(action.instanceId).admissionBlocked,'RUN_OUTCOME_UNKNOWN','Unknown execution blocks admission');
  if(m.snapshot(action.instanceId).state==='stopped'){await m.start(action.instanceId);lab.ready(action.instanceId);}
  requireCondition(m.snapshot(action.instanceId).state==='ready','INSTANCE_NOT_READY','Recover the instance first');
  const runId=action.id,controller=new AbortController();
  const job:LabJob={id:runId,runId,instanceId:action.instanceId,scenario:action.scenario,state:'running',text:'',executionState:'active',events:[]};jobs.set(runId,job);controls.set(runId,controller);
  try{store.commitJobs(snapshot().jobs);}catch(error){jobs.delete(runId);controls.delete(runId);throw error;}
  const work=m.runV2(action.instanceId,{schemaVersion:2,runId,subject:'lab',input:{type:'text',text:`CONEST_LAB:${runId}:${action.scenario}`},permissions:['lab:receipt'],session:{mode:'ephemeral'}},{signal:controller.signal,onEvent:event=>{evidence({at:event.at,type:event.type,runId,instanceId:action.instanceId});}})
  .then(result=>{job.state='completed';job.text=publicText(result.output);},error=>{const code=error instanceof HarnessError?error.code:'RUN_FAILED';job.state=code==='RUN_CANCELLED'?'cancelled':code==='RUN_INTERRUPTED'?'interrupted':'failed';job.text=code;})
  .finally(()=>{controls.delete(runId);publish();});
  running.add(work);void work.then(()=>running.delete(work),()=>running.delete(work));
  publish();return {accepted:true,runId};
 }
 if(action.action==='cancel'){const control=controls.get(action.runId);requireCondition(control,'LAB_STAGE','Run is no longer active');control.abort();}
 else if(action.action==='release-tool')lab.release(action.runId);
 else if(action.action==='terminate-worker'){await lab.terminate(action.instanceId);/* Explicit termination return is actual exit evidence. */}
 else if(action.action==='restart-instance'){
  requireCondition(m.snapshot(action.instanceId).activeRuns===0,'INSTANCE_BUSY','Release actual tool work first');
  await m.stop(action.instanceId,{force:true,graceMs:5000});m.resetRestartBudget(action.instanceId);await m.start(action.instanceId);lab.ready(action.instanceId);
 }
 else if(action.action==='acknowledge')m.acknowledgeExecution(action.instanceId,action.runId,action.token,'lab-operator',action.acceptRisk);
 else throw new HarnessError('INVALID_REQUEST','Parent-only action');
 publish();return {accepted:true};
}
let queue=Promise.resolve();
process.on('message',raw=>{queue=queue.then(async()=>{const envelope=record(raw);const id=uuid(envelope.id);try{requireCondition(!closing,'LAB_CLOSING','Coordinator is closing');const result=await command(envelope);send({kind:'response',id,ok:true,value:result});}catch(error){send({kind:'response',id,ok:false,error:error instanceof HarnessError?error.code:'LAB_FAILED'});} }).catch(()=>{});});
async function close(){if(closing)return;closing=true;lab.releaseAll();for(const c of controls.values())c.abort();await Promise.allSettled(manager!.list().map(i=>manager!.stop(i.id,{force:true,graceMs:5000})));await Promise.allSettled([...running]);store.commitJobs(snapshot().jobs);store.close();process.exit(0);}
process.once('disconnect',()=>{setTimeout(()=>process.exit(1),10000).unref();void close();});process.once('SIGTERM',()=>{void close();});
send({kind:'ready',value:snapshot()});
