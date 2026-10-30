import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessRegistry,HarnessManager} from '../dist/index.mjs';
import {LocalStateStore} from '../dist/state-store.mjs';
import {createTestProvider} from '../dist/testing.mjs';
async function root(t){const p=await mkdtemp(path.join(os.tmpdir(),'conest-admission-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
function provider(run){return {...createTestProvider('admission'),async createInstance(){return {async start(){},async stop(){},run};}};}
const spec={id:'a',provider:'admission',providerConfigVersion:1,policy:{subjects:['alice'],allow:[]},providerConfig:{}};
const request={schemaVersion:2,runId:'r',subject:'alice',input:{type:'text',text:'hello'},session:{mode:'ephemeral'}};
test('provider receives immutable admission from the exact committed fence and none of it leaks to public output',async t=>{
 const store=await LocalStateStore.open(await root(t));t.after(()=>store.close());const registry=new HarnessRegistry();let observed;
 registry.register(provider(async(task,ctx)=>{observed=ctx.admission;const [saved]=store.executionFences();assert(saved);assert.deepEqual(observed,{instanceId:task.instanceId,runId:task.runId,generation:task.generation,subject:task.subject,fenceId:saved.token,configRevision:saved.configRevision,providerId:saved.providerId,providerVersion:saved.providerVersion,persistence:'configured'});assert(Object.isFrozen(observed));assert.throws(()=>{observed.subject='foreign';});return {text:'hello'};}));
 const options={executions:{save:r=>store.saveExecution(r),remove:(r,e)=>store.removeExecution(r,e)}},manager=new HarnessManager(registry,options);manager.createConfigured(spec);options.executions=undefined;await manager.start('a');t.after(()=>manager.stop('a'));
 const events=[];const result=await manager.runV2('a',request,{onEvent:e=>events.push(e)});for(const data of [result,events,manager.snapshot('a'),store.restoredJobs(),store.audit()]){assert(!JSON.stringify(data).includes(observed.fenceId));assert(!/"admission"\s*:/.test(JSON.stringify(data)));}assert.equal(manager.executionFences().length,0);
});
test('memory-only admission is explicit and legacy providers still accept manually supplied contexts',async t=>{
 let admission;const registry=new HarnessRegistry();registry.register(provider(async(_,context)=>{admission=context.admission;return {text:'ok'};}));const manager=new HarnessManager(registry);manager.createConfigured(spec);await manager.start('a');t.after(()=>manager.stop('a'));await manager.run('a',{runId:'r',subject:'alice',input:'hello'});assert.equal(admission.persistence,'memory-only');
 const legacy=await createTestProvider().createInstance({mode:'echo',delayMs:1,failStart:false});await legacy.start();assert.equal((await legacy.run({input:'legacy'},{signal:new AbortController().signal,emit(){},markUncertain(){},assertAuthorized(){}})).text,'legacy');await legacy.stop();
});
test('failed core commit cannot reach provider dispatch or issue admission metadata',async t=>{
 let calls=0;const registry=new HarnessRegistry();registry.register(provider(async()=>{calls++;return {text:'wrong'};}));const manager=new HarnessManager(registry,{executions:{save(){throw new Error('synthetic disk failure');},remove(){return undefined;}}});manager.createConfigured(spec);await manager.start('a');t.after(()=>manager.stop('a'));await assert.rejects(manager.runV2('a',request));assert.equal(calls,0);assert.equal(manager.snapshot('a').admissionBlocked,true);
});
