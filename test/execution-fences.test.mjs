import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {HarnessManager,HarnessRegistry} from '../dist/index.mjs';import {createTestProvider} from '../dist/testing.mjs';import {LocalStateStore} from '../dist/state-store.mjs';
const task={runId:'uncertain',subject:'test',input:'synthetic-sensitive-task'};
function fixture(store,options={}){const registry=new HarnessRegistry();let context;const base=createTestProvider('remote');registry.register({...base,features:{cooperativeCancel:true,processControl:'attached'},async createInstance(){return {async start(){},async stop(){},async run(_,ctx){context=ctx;if(options.normal)return {text:'ok'};ctx.markUncertain();return {text:'must not be completed'};},...(options.reconcile?{reconcileExecution:options.reconcile}:{})};}});const manager=new HarnessManager(registry,store?{executions:{save:r=>store.saveExecution(r),remove:(r,e)=>store.removeExecution(r,e)}}:{});manager.create({id:'a',provider:'remote',policy:{subjects:['test']}});return {manager,context:()=>context};}
async function root(t){const dir=await mkdtemp(path.join(os.tmpdir(),'execution-fences-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('uncertainty blocks admission after native promise settles, normal stop, restart and access restore',async t=>{
 const dir=await root(t);let store=await LocalStateStore.open(dir),f=fixture(store);await f.manager.start('a');await assert.rejects(f.manager.run('a',task),e=>e.code==='RUN_OUTCOME_UNKNOWN');
 assert.equal(f.manager.snapshot('a').activeRuns,0);assert.equal(f.manager.snapshot('a').admissionBlocked,true);const fence=f.manager.executionFences()[0];await f.manager.stop('a');assert.equal(f.manager.snapshot('a').resourceState,'unconfirmed');store.close();
 store=await LocalStateStore.open(dir);f=fixture(store,{normal:true});f.manager.restoreExecutions(store.executionFences());t.after(async()=>{await f.manager.stop('a');store.close();});await f.manager.start('a');f.manager.setTaskAccess('a',false);f.manager.setTaskAccess('a',true);
 await assert.rejects(f.manager.run('a',{...task,runId:'later'}),e=>e.code==='RUN_OUTCOME_UNKNOWN');
 assert.throws(()=>f.manager.acknowledgeExecution('a',fence.runId,'wrong','operator',true),e=>e.code==='EXECUTION_CONFLICT');assert.throws(()=>f.manager.acknowledgeExecution('a',fence.runId,fence.token,'operator',false));
 const accepted=f.manager.acknowledgeExecution('a',fence.runId,fence.token,'operator',true);assert.equal(accepted.executionState,'unknown');assert.equal(f.manager.isRunUncertain('a',task.runId),true);assert.equal(f.manager.snapshot('a').admissionBlocked,false);
 assert.equal((await f.manager.run('a',{...task,runId:'fresh'})).state,'completed');assert.equal(store.executionFences()[0].status,'acknowledged');assert(!JSON.stringify(store.audit()).includes('synthetic-sensitive-task'));
});
test('dispatch intent survives a crash before markUncertain and ordinary successful work clears the journal',async t=>{
 const dir=await root(t);let store=await LocalStateStore.open(dir);let f=fixture(store,{normal:true});await f.manager.start('a');await f.manager.run('a',task);assert.equal(store.executionFences().length,0);await f.manager.stop('a');
 store.saveExecution({instanceId:'a',runId:'lost',generation:'generation',providerId:'remote',providerVersion:'1',subject:'test',token:'token',createdAt:new Date().toISOString(),status:'in-flight'});store.close();store=await LocalStateStore.open(dir);f=fixture(store);t.after(()=>store.close());f.manager.restoreExecutions(store.executionFences());assert.equal(f.manager.snapshot('a').admissionBlocked,true);assert.equal(store.executionFences()[0].status,'uncertain');
});
test('journal admission/settlement failures fail closed; no native task runs before committed intent',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir),f=fixture(store,{normal:true});t.after(async()=>{await f.manager.stop('a');store.close();});await f.manager.start('a');const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('DROP TABLE executions');db.close();
 await assert.rejects(f.manager.run('a',task),e=>e.code==='STATE_WRITE_FAILED');assert.equal(f.context(),undefined);assert.equal(f.manager.snapshot('a').admissionBlocked,true);
});
test('provider reconciliation confirms a precise fence; unknown/running and unsupported replies leave it blocked',async t=>{
 let status='unknown';const f=fixture(undefined,{reconcile:async()=>({status})});t.after(()=>f.manager.stop('a'));await f.manager.start('a');await assert.rejects(f.manager.run('a',task));const fence=f.manager.executionFences()[0];
 assert.equal((await f.manager.reconcileExecution('a',fence.runId,fence.token)).status,'unknown');assert.equal(f.manager.snapshot('a').admissionBlocked,true);status='running';await f.manager.reconcileExecution('a',fence.runId,fence.token);assert.equal(f.manager.snapshot('a').admissionBlocked,true);status='settled';await f.manager.reconcileExecution('a',fence.runId,fence.token);assert.equal(f.manager.snapshot('a').admissionBlocked,false);assert.equal(f.manager.isRunUncertain('a',task.runId),false);
});
test('expired context cannot create a new fence after an ordinary task settled',async t=>{
 const f=fixture(undefined,{normal:true});t.after(()=>f.manager.stop('a'));await f.manager.start('a');await f.manager.run('a',task);assert.throws(()=>f.context().markUncertain(),e=>e.code==='CALLBACK_EXPIRED');assert.equal(f.manager.executionFences().length,0);
});
test('failed settlement COMMIT retains the dispatch intent for recovery',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir);let executed=0;const registry=new HarnessRegistry(),base=createTestProvider('normal',{run(){executed++;const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('DROP TABLE audit');db.close();}});registry.register(base);
 const manager=new HarnessManager(registry,{executions:{save:r=>store.saveExecution(r),remove:(r,e)=>store.removeExecution(r,e)}});manager.create({id:'a',provider:'normal',policy:{subjects:['test']}});await manager.start('a');await assert.rejects(manager.run('a',task),e=>e.code==='RUN_OUTCOME_UNKNOWN');assert.equal(executed,1);assert.equal(manager.snapshot('a').admissionBlocked,true);assert.equal(store.executionFences()[0].status,'in-flight');await manager.stop('a');store.close();
 const reopened=await LocalStateStore.open(dir);t.after(()=>reopened.close());const recovered=fixture(reopened,{normal:true});recovered.manager.restoreExecutions(reopened.executionFences());assert.equal(recovered.manager.snapshot('a').admissionBlocked,true);
});

test('provider confirmation is retained across restart and changed configuration cannot reconcile another route',async t=>{
 const dir=await root(t);let store=await LocalStateStore.open(dir),f=fixture(store,{reconcile:async()=>({status:'settled'})});await f.manager.start('a');await assert.rejects(f.manager.run('a',task));const fence=f.manager.executionFences()[0];await f.manager.reconcileExecution('a',fence.runId,fence.token);await f.manager.stop('a');store.close();
 store=await LocalStateStore.open(dir);f=fixture(store,{normal:true});t.after(()=>store.close());f.manager.restoreExecutions(store.executionFences());assert.equal(f.manager.executionState('a',task.runId),'confirmed-ended');assert.equal(f.manager.isRunUncertain('a',task.runId),false);assert.equal(f.manager.snapshot('a').admissionBlocked,false);
 const changed=fixture(undefined,{reconcile:async()=>{throw Error('Must not query another route');}});t.after(()=>changed.manager.stop('a'));changed.manager.restoreExecutions([{...fence,configRevision:'0'.repeat(64),status:'uncertain'}]);await changed.manager.start('a');await assert.rejects(changed.manager.reconcileExecution('a',task.runId,fence.token),e=>e.code==='EXECUTION_CONFLICT');assert.equal(changed.manager.snapshot('a').admissionBlocked,true);
});

test('untyped asynchronous persistence cannot dispatch a task before a committed synchronous intent',async t=>{
 let dispatched=0;const registry=new HarnessRegistry();registry.register(createTestProvider('sync',{run(){dispatched++;}}));const manager=new HarnessManager(registry,{executions:{async save(){throw Error('Delayed persistence failure');},remove(){}}});manager.create({id:'a',provider:'sync',policy:{subjects:['test']}});t.after(()=>manager.stop('a'));await manager.start('a');await assert.rejects(manager.run('a',task),e=>e.code==='INVALID_PERSISTENCE');assert.equal(dispatched,0);assert.equal(manager.snapshot('a').admissionBlocked,true);await new Promise(r=>setImmediate(r));
});
