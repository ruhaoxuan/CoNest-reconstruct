import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessManager, HarnessRegistry } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';

const task = id => ({runId:id,subject:'operator',input:id});
function manager(provider) {
  const registry=new HarnessRegistry();registry.register(provider);const m=new HarnessManager(registry);
  for(const id of ['a','b'])m.create({id,provider:provider.id,policy:{subjects:['operator']}});
  return m;
}
test('revocation closes admission, invalidates retained authority and never revives an old task',async()=>{
  const entered=Promise.withResolvers(),settle=Promise.withResolvers();let retained;
  const provider={...createTestProvider('revocation'),async createInstance(){return {
    async start(){},async stop(){},async run(request,context){
      retained=context;entered.resolve();if(request.input==='old')await settle.promise;context.assertAuthorized();return {};
    },
  };}};
  const m=manager(provider);await m.start('a');
  const run=m.run('a',task('old'));const rejected=assert.rejects(run,e=>e.code==='RUN_REVOKED');await entered.promise;
  m.setTaskAccess('a',false);await rejected;assert.equal(m.isRunActive('a','old'),true);
  await assert.rejects(m.run('a',task('blocked')),e=>e.code==='TASK_ACCESS_REVOKED');
  m.setTaskAccess('a',true);assert.throws(()=>retained.assertAuthorized());
  settle.resolve();await m.stop('a');assert.equal(m.snapshot('a').resourceState,'released');
  await m.start('a');assert.equal((await m.run('a',task('new'))).state,'completed');await m.stop('a');
});
test('fault marks interrupted, retains ownership and ignores notifications from an old generation',async()=>{
  const entered=Promise.withResolvers();let failure;const old=[];
  const provider={...createTestProvider('fault'),async createInstance(){return {
    setFailureHandler(handler){failure=handler;old.push(handler);},async start(){},async stop(){},
    async run(request,{signal}){if(request.input!=='wait')return {};entered.resolve();await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},
  };}};
  const m=manager(provider);await m.start('a');const aFailure=failure;await m.start('b');
  const run=m.run('a',task('wait'));const rejected=assert.rejects(run,e=>e.code==='RUN_INTERRUPTED');await entered.promise;
  aFailure('PROCESS_EXITED');await rejected;assert.equal(m.snapshot('a').state,'failed');assert.equal(m.snapshot('a').resourceState,'unconfirmed');
  await assert.rejects(m.run('a',task('blocked')));assert.equal((await m.run('b',task('healthy'))).state,'completed');
  await m.stop('a');await new Promise(r=>setTimeout(r,Math.max(1,m.snapshot('a').nextStartAt-Date.now())));await m.start('a');const generation=m.snapshot('a').generation;aFailure('PROCESS_EXITED');
  assert.equal(m.snapshot('a').state,'ready');assert.equal(m.snapshot('a').generation,generation);
  await m.stop('a');await m.stop('b');
});
test('stop deadline covers the stop hook, retains pending cleanup and joins it without double release',async()=>{
  const finish=Promise.withResolvers();let calls=0;
  const m=manager({...createTestProvider('slow-stop'),async createInstance(){return {async start(){},async run(){return {};},async stop(){calls++;await finish.promise;}};}});
  await m.start('a');await assert.rejects(m.stop('a',{graceMs:10}),e=>e.code==='STOP_TIMEOUT');
  assert.equal(m.snapshot('a').resourceState,'unconfirmed');await assert.rejects(m.start('a'),e=>e.code==='INSTANCE_BUSY');
  const joined=m.stop('a',{graceMs:1000});finish.resolve();await joined;
  assert.equal(calls,1);assert.equal(m.snapshot('a').resourceState,'released');assert.equal(m.snapshot('a').state,'stopped');
});
test('late successful cleanup confirms release but does not automatically restart the failed instance',async()=>{
  const finish=Promise.withResolvers();const m=manager({...createTestProvider('late-stop'),async createInstance(){return {async start(){},async run(){return {};},async stop(){await finish.promise;}};}});
  await m.start('a');await assert.rejects(m.stop('a',{graceMs:10}));finish.resolve();await new Promise(r=>setImmediate(r));
  assert.equal(m.snapshot('a').state,'failed');assert.equal(m.snapshot('a').resourceState,'released');await m.stop('a');
});
test('failure during startup cannot be overwritten by a ready transition',async()=>{
  let report;let stopped=0;const m=manager({...createTestProvider('startup-fault'),async createInstance(){return {
    setFailureHandler(handler){report=handler;},async start(){report('PROCESS_EXITED');},async run(){return {};},async stop(){stopped++;},
  };}});
  await assert.rejects(m.start('a'));assert.equal(m.snapshot('a').state,'failed');assert.equal(m.snapshot('a').resourceState,'released');assert.equal(stopped,1);
});
test('attached and remote providers receive only their own detach/stop hook',async()=>{
  for(const ownership of ['attached','remote']){
    let detached=0;const p=createTestProvider('external');
    const m=manager({...p,features:{...p.features,processControl:ownership},async createInstance(){return {async start(){},async run(){return {};},async stop(){detached++;}};}});
    await m.start('a');assert.equal(m.snapshot('a').ownership,ownership);await m.stop('a');assert.equal(detached,1);
  }
});

test('authority checked during a pending stop reports cancellation rather than an ordinary provider failure',async()=>{
  let stopping,reason;
  const m=manager({...createTestProvider('stop-authority'),async createInstance(){return {async start(){},async stop(){},async run(_,context){
    context.emit({phase:'stop-now'});try{context.assertAuthorized();}catch(error){reason=error.code;throw error;}
  }};}});
  await m.start('a');await assert.rejects(m.run('a',task('race'),{onEvent(event){if(event.type==='provider.progress')stopping=m.stop('a');}}),e=>e.code==='RUN_CANCELLED');
  await stopping;assert.equal(reason,'RUN_CANCELLED');assert.equal(m.snapshot('a').resourceState,'released');
});
