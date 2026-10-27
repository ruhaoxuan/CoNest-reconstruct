import test from 'node:test';import assert from 'node:assert/strict';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function settled(f){for(let i=0;i<300;i++){if(f.manager.snapshot('a').activeRuns===0)return;await pause(20);}throw Error('Native invocation did not settle');}
/** The same assertions run against synthetic and real DSH factories. */
export function harnessConformance(name,fixture){
 test(name+': normalized public result and correlated events',{timeout:30000},async t=>{
  const f=await fixture(t,'normal'),events=[];await f.manager.start('a');const result=await f.manager.runV2('a',f.request('normal'),{onEvent:e=>events.push(e)});
  assert.equal(result.output.schemaVersion,2);assert(result.output.content.some(c=>c.type==='text'&&c.text.includes('CONFORMANCE_OK')));assert(!('finalText'in result.output));
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));assert(events.every(e=>e.instanceId==='a'&&e.runId==='normal'));assert(events.some(e=>e.type==='run.completed'));
 });
 test(name+': admission and capability refusal precede execution',{timeout:30000},async t=>{
  const f=await fixture(t,'normal');await f.manager.start('a');await assert.rejects(f.manager.runV2('a',{...f.request('wrong-subject'),subject:'foreign'}),e=>e.code==='SUBJECT_DENIED');
  await assert.rejects(f.manager.runV2('a',{...f.request('unsupported'),session:{mode:'create'}}),e=>e.code==='UNSUPPORTED_CAPABILITY');assert.equal(f.contexts.length,0);assert.equal(f.manager.executionFences().length,0);
 });
 for(const revoke of [false,true])test(name+(revoke?': in-flight revocation':': cancellation joins actual work'),{timeout:30000},async t=>{
  const f=await fixture(t,'wait');await f.manager.start('a');const controller=new AbortController();const run=f.manager.runV2('a',f.request('waiting'),{signal:controller.signal});const rejected=assert.rejects(run,e=>e.code===(revoke?'RUN_REVOKED':'RUN_CANCELLED'));
  await f.entered;if(revoke)f.manager.setTaskAccess('a',false);else controller.abort();await rejected;await settled(f);assert.equal(f.manager.snapshot('a').admissionBlocked,false);assert.equal(f.manager.executionFences().length,0);
  const old=f.contexts[0];assert.throws(()=>old.markUncertain(),e=>e.code==='CALLBACK_EXPIRED');
 });
 test(name+': stopping A preserves B and retired callbacks cannot publish',{timeout:30000},async t=>{
  const f=await fixture(t,'normal');await f.manager.start('a');await f.manager.start('b');const events=[];await f.manager.runV2('a',f.request('old'),{onEvent:e=>events.push(e)});const old=f.contexts[0],count=events.length;
  await f.manager.stop('a');old.emit({kind:'tool',callId:'late',name:'read',status:'completed'});assert.equal(events.length,count);
  const result=await f.manager.runV2('b',f.request('independent'));assert.equal(result.state,'completed');assert.equal(f.manager.snapshot('b').state,'ready');
 });
}
