import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessManager,HarnessRegistry } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(factory,ownership='owned'){
 const registry=new HarnessRegistry();registry.register({...createTestProvider('lifecycle'),features:{cooperativeCancel:true,processControl:ownership,hardTermination:ownership==='owned'},createInstance:factory});
 const manager=new HarnessManager(registry);
 manager.createConfigured({id:'a',provider:'lifecycle',providerConfigVersion:1,policy:{subjects:['test']},providerConfig:{},
  control:{createTimeoutMs:15,startTimeoutMs:15,stopGraceMs:15,terminateTimeoutMs:100,restart:{maxFailures:2,windowMs:1000,baseDelayMs:10,maxDelayMs:20}}});
 return manager;
}
test('timed-out creation stays quarantined until a late allocation is disposed',async()=>{
 const gate=Promise.withResolvers();let stops=0;
 const m=fixture(async()=>gate.promise);
 await assert.rejects(m.start('a'),e=>e.code==='CREATE_TIMEOUT');assert.equal(m.snapshot('a').resourceState,'unconfirmed');
 await assert.rejects(m.start('a'),e=>e.code==='INSTANCE_BUSY');
 gate.resolve({async start(){},async stop(){stops++;},async run(){return {};}});
 await delay(5);assert.equal(stops,1);assert.equal(m.snapshot('a').resourceState,'released');await m.stop('a');
});
test('startup watchdog terminates only an owned instance and retains an attached instance',async()=>{
 for(const ownership of ['owned','attached']){
  let terminated=0;const m=fixture(async()=>({async start(){await new Promise(()=>{});},async stop(){await new Promise(()=>{});},async terminate(){terminated++;},async run(){return {};}}),ownership);
  await assert.rejects(m.start('a'));
  assert.equal(terminated,ownership==='owned'?1:0);assert.equal(m.snapshot('a').resourceState,ownership==='owned'?'released':'unconfirmed');
 }
});
test('force stop uses owned termination and waits for actual callback settlement',async()=>{
 const entered=Promise.withResolvers(),settle=Promise.withResolvers();let terminated=0;
 const m=fixture(async()=>({async start(){},async run(){entered.resolve();return settle.promise;},async stop(){await new Promise(()=>{});},async terminate(){terminated++;settle.resolve({});}}));
 await m.start('a');const run=m.run('a',{runId:'work',subject:'test',input:'wait'});const cancelled=assert.rejects(run,e=>e.code==='RUN_CANCELLED');await entered.promise;
 await m.stop('a',{force:true,graceMs:10});await cancelled;assert.equal(terminated,1);assert.equal(m.snapshot('a').activeRuns,0);assert.equal(m.snapshot('a').resourceState,'released');
});
test('bounded restart budget has exponential delay and explicit operator reset',async()=>{
 const m=fixture(async()=>({async start(){throw Error('fail');},async stop(){},async run(){return {};}}));
 await assert.rejects(m.start('a'));await assert.rejects(m.start('a'),e=>e.code==='RESTART_BACKOFF');
 await delay(15);await assert.rejects(m.start('a'));await delay(25);await assert.rejects(m.start('a'),e=>e.code==='RESTART_LIMIT');
 m.resetRestartBudget('a');assert.equal(m.snapshot('a').restartFailures,0);
});
test('a stop request cancels a hanging startup without waiting for its full deadline',async()=>{
 const entered=Promise.withResolvers();let stops=0;const m=fixture(async()=>({async start(){entered.resolve();await new Promise(()=>{});},async stop(){stops++;},async run(){return {};}}));
 const start=m.start('a');const rejected=assert.rejects(start,e=>e.code==='START_CANCELLED');await entered.promise;await m.stop('a');await rejected;
 assert.equal(stops,1);assert.equal(m.snapshot('a').resourceState,'released');
});
