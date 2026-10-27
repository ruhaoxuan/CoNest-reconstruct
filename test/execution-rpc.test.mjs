import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {HarnessManager,HarnessRegistry,HarnessRpcClient} from '../dist/index.mjs';import {createTestProvider} from '../dist/testing.mjs';import {LocalStateStore} from '../dist/state-store.mjs';import {startStudio} from '../dist/studio/server.mjs';
test('execution management requires access scope; risk acknowledgment persists without claiming settlement',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'execution-rpc-'));t.after(()=>rm(dir,{recursive:true,force:true}));let store=await LocalStateStore.open(dir);const registry=new HarnessRegistry();registry.register(createTestProvider());
 const manager=new HarnessManager(registry,{executions:{save:r=>store.saveExecution(r),remove:(r,e)=>store.removeExecution(r,e)}});manager.create({id:'a',provider:'test.echo',policy:{subjects:['test']}});manager.restoreExecutions([{instanceId:'a',runId:'lost',generation:'previous',providerId:'test.echo',providerVersion:'0.1.0',subject:'test',token:'fence-token',createdAt:new Date().toISOString(),status:'in-flight'}]);
 store.commitJobs([{id:'old-job',runId:'lost',instanceId:'a',state:'interrupted',startedAt:new Date().toISOString(),text:'previous coordinator stopped',events:[],executionState:'unknown'}]);
 const adminToken=randomUUID(),viewerToken=randomUUID(),studio=await startStudio({manager,store,token:adminToken,additionalTokens:[{token:viewerToken,permissions:['state:read']}],port:0,mode:'proof',submitTask:async()=>({})});t.after(()=>studio.close());
 const admin=new HarnessRpcClient(studio.url+'/rpc',()=>adminToken),viewer=new HarnessRpcClient(studio.url+'/rpc',()=>viewerToken);const fence=(await admin.request('execution.list')).records[0];
 await assert.rejects(viewer.request('execution.acknowledge',{instanceId:'a',runId:'lost',token:fence.token,acceptRisk:true}),e=>e.code==='MANAGEMENT_DENIED');
 await assert.rejects(admin.request('execution.acknowledge',{instanceId:'a',runId:'lost',token:fence.token}),e=>e.code==='INVALID_REQUEST');
 await assert.rejects(admin.request('execution.reconcile',{instanceId:'a',runId:'lost',token:fence.token}),e=>e.code==='UNSUPPORTED_CAPABILITY');
 const result=await admin.request('execution.acknowledge',{instanceId:'a',runId:'lost',token:fence.token,acceptRisk:true});assert.equal(result.executionState,'unknown');const state=await admin.request('instance.list');assert.equal(state.instances[0].admissionBlocked,false);assert.equal(state.jobs[0].executionState,'acknowledged-unknown');assert.equal(store.executionFences()[0].status,'acknowledged');
});
