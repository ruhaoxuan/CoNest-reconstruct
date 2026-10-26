import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HarnessRegistry,HarnessManager } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
import { startStudio } from '../dist/studio/server.mjs';
import { instanceView,jobView,groupTools } from '../dist/studio/presentation.mjs';

async function fixture(t,{mode='echo',delayMs=100,timeoutMs=1000}={}){
  const registry=new HarnessRegistry();registry.register(createTestProvider('p5'));const manager=new HarnessManager(registry);
  manager.create({id:'a',provider:'p5',config:{mode,delayMs},policy:{subjects:['studio']}});
  const admin=randomUUID(),viewer=randomUUID(),runner=randomUUID(),controllerToken=randomUUID();
  const studio=await startStudio({manager,token:admin,additionalTokens:[{token:viewer,permissions:['state:read']},{token:runner,permissions:['state:read','task:run']},{token:controllerToken,permissions:['instance:control']}],port:0,mode:'proof',
    async submitTask(id,input,signal,onEvent){return (await manager.run(id,{runId:randomUUID(),subject:'studio',input,timeoutMs},{signal,onEvent})).output;}});
  t.after(()=>studio.close());
  const request=async(route,data,token=admin)=>fetch(studio.url+'/api/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
  const state=async()=> (await request('state')).json();
  const done=async()=>{for(let i=0;i<100;i++){const s=await state();if(s.jobs[0]?.state!=='running')return s.jobs[0];await new Promise(r=>setTimeout(r,5));}throw Error('Timeout');};
  return {manager,request,state,done,admin,viewer,runner,controllerToken};
}
test('read-only and task-only tokens cannot perform unauthorized management actions',async t=>{
  const f=await fixture(t);assert.equal((await f.request('state',undefined,f.viewer)).status,200);
  for(const route of ['start','stop','run','cancel','revoke','restore'])assert.equal((await f.request(route,{instanceId:'a',input:'x',id:'none'},f.viewer)).status,403);
  assert.equal((await f.request('start',{instanceId:'a'},f.runner)).status,403);
  const controlResponse=await f.request('start',{instanceId:'a'},f.controllerToken);assert.deepEqual(await controlResponse.json(),{accepted:true});
  assert.equal((await f.request('state',undefined,f.controllerToken)).status,403);
  assert.equal((await f.request('run',{instanceId:'a',input:'ok'},f.runner)).status,202);assert.equal((await f.done()).state,'completed');
  assert.deepEqual((await(await f.request('state',undefined,f.viewer)).json()).permissions,['state:read']);
});
test('revoked task and noncooperative execution expose separate terminal and settlement states',async t=>{
  const f=await fixture(t,{mode:'ignore-cancel',delayMs:150});await f.request('start',{instanceId:'a'});await f.request('run',{instanceId:'a',input:'wait'});
  for(let i=0;i<30&&!f.manager.snapshot('a').activeRuns;i++)await new Promise(r=>setTimeout(r,2));
  await f.request('revoke',{instanceId:'a'});const job=await f.done();assert.equal(job.state,'revoked');assert.equal(job.executionState,'active');
  assert.equal((await f.request('run',{instanceId:'a',input:'denied'})).status,400);
  await f.request('restore',{instanceId:'a'});assert.equal((await f.request('run',{instanceId:'a',input:'still busy'})).status,400);
  await new Promise(r=>setTimeout(r,180));assert.equal((await f.state()).jobs[0].executionState,'settled');
});
test('deadline reports timed-out instead of a generic failed job',async t=>{
  const f=await fixture(t,{mode:'wait',delayMs:150,timeoutMs:10});await f.request('start',{instanceId:'a'});await f.request('run',{instanceId:'a',input:'wait'});
  assert.equal((await f.done()).state,'timed-out');assert.equal((await f.state()).jobs[0].executionState,'settled');
});
test('presentation derives button permissions and never turns unknown tool settlement into success',()=>{
  const i={enabled:true,state:'failed',resourceState:'unconfirmed',taskAccess:'enabled',activeRuns:0};
  assert.equal(instanceView(i,['instance:control']).start,false);assert.equal(instanceView(i,['instance:control']).stop,true);
  assert.equal(instanceView({...i,state:'ready',resourceState:'held'},['state:read']).run,false);
  assert.equal(jobView({state:'running',cancelRequested:true,executionState:'active'}).status,'已请求取消');
  assert.match(jobView({state:'cancelled',cancelRequested:true,executionState:'active'}).work,/仍在收尾/);
  const events=[{name:'read_file',callId:'c',runId:'r',at:'t',status:'running'},{name:'read_file',callId:'c',runId:'r',at:'t',status:'completed',durationMs:5,previewTruncated:true}];
  assert.equal(groupTools(events,false).length,1);assert.equal(groupTools(events,false)[0].durationMs,5);
  assert.equal(groupTools(events.slice(0,1),true)[0].status,'unconfirmed');
});
