import test from 'node:test';import assert from 'node:assert/strict';
import {HarnessManager,HarnessRegistry,parseTaskResultV2,parseProgressV2} from '../dist/index.mjs';
import {createTestProvider} from '../dist/testing.mjs';
const request={schemaVersion:2,runId:'r',subject:'test',input:{type:'text',text:'hello'},permissions:[],session:{mode:'ephemeral'}};
function fixture(overrides={}){const registry=new HarnessRegistry();registry.register({...createTestProvider(),...overrides});const manager=new HarnessManager(registry);manager.create({id:'a',provider:'test.echo',policy:{subjects:['test']}});return manager;}
test('V2 validates result types, unknown usage, limits and private data instead of guessing provider fields',()=>{
 assert.deepEqual(parseTaskResultV2({schemaVersion:2,content:[{type:'text',text:''}]}),{schemaVersion:2,content:[{type:'text',text:''}]});
 for(const value of [{schemaVersion:2,content:[],token:'private'},{schemaVersion:2,content:[{type:'json',value:Infinity}]},{schemaVersion:2,content:[{type:'text',text:'x'.repeat(64001)}]},{schemaVersion:2,content:[],usage:{source:'provider-reported',inputTokens:NaN}}])assert.throws(()=>parseTaskResultV2(value));
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>parseTaskResultV2({schemaVersion:2,content:[{type:'json',value:cyclic}]}));
 assert.throws(()=>parseProgressV2({kind:'tool.finished',callId:'c',name:'read',status:'completed',token:'private'}));
 assert.throws(()=>parseProgressV2({kind:'text.delta',text:'x'.repeat(8001)}));
});
test('V1 output remains native while V2 output and event envelopes are explicitly normalized',async t=>{
 const manager=fixture();t.after(()=>manager.stop('a'));await manager.start('a');
 assert.deepEqual((await manager.run('a',{runId:'v1',subject:'test',input:'legacy'})).output,{text:'legacy'});
 const events=[];const result=await manager.runV2('a',request,{onEvent:e=>events.push(e)});assert.deepEqual(result.output,{schemaVersion:2,content:[{type:'text',text:'hello'}]});
 assert(events.some(e=>e.type==='run.progress.v2'&&e.data.kind==='notice'));assert(!events.some(e=>e.type==='provider.progress'));
 assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));assert(events.every(e=>e.runId==='r'&&e.instanceId==='a'));
});
test('unsupported session, mediation and confirmed cancellation fail before native invocation',async t=>{
 let invoked=0;const base=createTestProvider('test.echo',{run(){invoked++;}}),manager=fixture(base);t.after(()=>manager.stop('a'));await manager.start('a');
 for(const value of [{...request,session:{mode:'create'}},{...request,requirements:{mediatedTools:true}},{...request,requirements:{confirmedCancellation:true}}])await assert.rejects(manager.runV2('a',value),e=>e.code==='UNSUPPORTED_CAPABILITY');
 assert.equal(invoked,0);assert.equal(manager.executionFences().length,0);
});
test('invalid provider result/event never emits run.completed or exposes its raw secret object',async t=>{
 const manager=fixture({projectResult(){return {schemaVersion:2,content:[],secret:'synthetic-secret'};}});t.after(()=>manager.stop('a'));await manager.start('a');const events=[];
 await assert.rejects(manager.runV2('a',request,{onEvent:e=>events.push(e)}),e=>e.code==='INVALID_PROVIDER_RESULT'&&!e.message.includes('synthetic-secret'));assert(!events.some(e=>e.type==='run.completed'));assert(!JSON.stringify(events).includes('synthetic-secret'));
});

test('invalid public progress remains a failure even when a provider swallows the validation exception',async t=>{
 const base=createTestProvider(),manager=fixture({...base,projectProgress(){return {kind:'tool.finished',name:'read',status:'completed'};},async createInstance(){return {async start(){},async stop(){},async run(_,context){try{context.emit({});}catch{}return {text:'must not succeed'};}};}});t.after(()=>manager.stop('a'));await manager.start('a');const events=[];await assert.rejects(manager.runV2('a',request,{onEvent:e=>events.push(e)}));assert(!events.some(e=>e.type==='run.completed'));
});

test('documented synthetic uncertainty mode passes runtime configuration and produces a retained fence',async t=>{
 const registry=new HarnessRegistry();registry.register(createTestProvider());const manager=new HarnessManager(registry);manager.create({id:'a',provider:'test.echo',config:{mode:'uncertain'},policy:{subjects:['test']}});t.after(()=>manager.stop('a'));await manager.start('a');await assert.rejects(manager.runV2('a',request),e=>e.code==='RUN_OUTCOME_UNKNOWN');assert.equal(manager.snapshot('a').admissionBlocked,true);
});
