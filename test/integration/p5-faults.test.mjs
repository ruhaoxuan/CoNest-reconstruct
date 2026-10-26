import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,realpath,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessManager,HarnessRegistry } from '../../dist/index.mjs';
import { createDshProvider } from '../../dist/adapters/dsh.mjs';
import { loadPinnedClient } from '../../dist/adapters/pinned-runtime.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(condition){for(let i=0;i<200;i++){if(condition())return;await pause(20);}throw Error('State timeout');}
const request=(id,input='PROOF:IMAGE:')=>({runId:id,subject:'operator',permissions:['host:tools'],input,timeoutMs:15000});
async function fixture(t,execute){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'p5-dsh-fault-'))),runtime=path.resolve('.vendor/conest');
 const Client=await loadPinnedClient(runtime),clients=[];let retained;
 const provider=createDshProvider({runtimeRoot:runtime,proofMode:true,loadClient:async()=>class extends Client{
  constructor(options){super(options);clients.push({client:this,notify:options.onFailure});}
  async extension(call){if(call.operation==='runHarnessAgent')retained=call;return super.extension(call);}
 },resolveTurn(task){const session=randomUUID();return {sessionKey:session,hostSessionId:session,hostAgentId:task.instanceId,hostLifecycleRevision:task.generation,
  provider:'bridge-proof',model:'test',assertActive(){},hostTools:execute?[{name:'bash',description:'Synthetic test callback',parameters:{type:'object'},permissions:['host:tools'],execute}]:[]};}});
 const registry=new HarnessRegistry();registry.register(provider);const manager=new HarnessManager(registry);
 for(const id of ['a','b']){const workspaceRoot=path.join(root,id);await mkdir(workspaceRoot);manager.create({id,provider:'dsh',config:{workspaceRoot,sessionPersistenceRoot:path.join(root,'sessions-'+id)},policy:{subjects:['operator'],allow:['host:tools']}});}
 t.after(async()=>{await Promise.all(manager.list().map(i=>manager.stop(i.id,{graceMs:6000})));await rm(root,{recursive:true,force:true});});
 return {manager,clients,retained:()=>retained};
}
test('owned DSH crash interrupts active work, isolates B, detects idle crash and requires explicit recovery', {timeout:60000},async t=>{
 const entered=Promise.withResolvers();
 const f=await fixture(t,async(_,__,signal)=>{entered.resolve();await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});});
 await f.manager.start('a');await f.manager.start('b');
 const a=f.clients[0],pid=(await a.client.status()).pid;assert.notEqual(pid,process.pid);
 const events=[];const run=f.manager.run('a',request('crash','PROOF:BASH:'),{onEvent:e=>events.push(e)});
 const rejected=assert.rejects(run,e=>e.code==='RUN_INTERRUPTED');await entered.promise;const stale=f.retained();
 // Only this test's private, directly owned worker is fault-injected.
 process.kill(pid,'SIGKILL');await rejected;await until(()=>f.manager.snapshot('a').state==='failed');
 assert(events.some(e=>e.type==='run.interrupted'));await assert.rejects(f.manager.run('a',request('blocked')));
 assert.equal((await f.manager.run('b',request('healthy'))).state,'completed');assert.equal(f.clients.length,2);
 await f.manager.stop('a',{graceMs:6000});await f.manager.start('a');
 a.notify('late old process exit');assert.equal(f.manager.snapshot('a').state,'ready');
 await assert.rejects(stale.callbacks.tool({name:'bash',callId:'late',args:{}},new AbortController().signal));
 assert.equal((await f.manager.run('a',request('recovered'))).state,'completed');
 const restarted=f.clients.at(-1),idlePid=(await restarted.client.status()).pid;
 process.kill(idlePid,'SIGKILL');await until(()=>f.manager.snapshot('a').state==='failed');
 assert.equal(f.manager.snapshot('a').activeRuns,0);assert.equal(f.manager.snapshot('a').ownership,'owned');
 assert.equal((await f.manager.run('b',request('still-healthy'))).state,'completed');
});
test('in-flight revocation cancels a real DSH callback and restored access cannot reuse the old callback', {timeout:60000},async t=>{
 const entered=Promise.withResolvers();let blocking=true,cancelled=false;
 const f=await fixture(t,async(_,__,signal)=>{if(!blocking)return {content:[{type:'text',text:'AFTER_RESTORE'}]};entered.resolve();await new Promise((_,reject)=>{
  const abort=()=>{cancelled=true;reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });});
 await f.manager.start('a');const run=f.manager.run('a',request('old','PROOF:BASH:'));const rejected=assert.rejects(run,e=>e.code==='RUN_REVOKED');
 await entered.promise;const stale=f.retained();f.manager.setTaskAccess('a',false);await rejected;
 await assert.rejects(f.manager.run('a',request('blocked')),e=>e.code==='TASK_ACCESS_REVOKED');
 await until(()=>f.manager.snapshot('a').activeRuns===0);assert.equal(cancelled,true);
 f.manager.setTaskAccess('a',true);await assert.rejects(stale.callbacks.tool({name:'bash',callId:'late',args:{}},new AbortController().signal));
 blocking=false;assert.match((await f.manager.run('a',request('fresh','PROOF:BASH:'))).output.finalText,/AFTER_RESTORE/);
});
