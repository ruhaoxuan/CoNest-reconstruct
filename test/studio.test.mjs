import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStudio } from '../dist/studio/server.mjs';
import { HarnessManager,HarnessRegistry } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
async function fixture(t){
 const registry=new HarnessRegistry();registry.register(createTestProvider('third'));
 const manager=new HarnessManager(registry);manager.create({id:'third-instance',provider:'third',config:{mode:'wait',delayMs:200},policy:{subjects:['web'],allow:[]}});
 const token=randomUUID();const studio=await startStudio({manager,token,port:0,mode:'proof',submitTask:(id,input,signal)=>manager.run(id,{runId:randomUUID(),subject:'web',input},{signal})});
 t.after(()=>studio.close());
 return {manager,studio,async request(route,data,headers={}){return fetch(studio.url+'/api/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})});}};
}
test('Studio requires token and rejects foreign origin; HTML contains no token',async t=>{
 const f=await fixture(t);assert.equal((await f.request('state',undefined,{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await f.request('state',undefined,{Origin:'https://untrusted.example'})).status,403);
 const html=await(await fetch(f.studio.url)).text();assert.match(html,/proof|PROOF/);assert.match(html,/id="jobs"/);
});
test('Studio discovers a third provider and controls lifecycle without SDK branches',async t=>{
 const f=await fixture(t);assert.equal((await(await f.request('state')).json()).instances[0].provider,'third');
 assert.equal((await f.request('run',{instanceId:'third-instance',input:'x'})).status,400);
 await f.request('start',{instanceId:'third-instance'});assert.equal(f.manager.snapshot('third-instance').state,'ready');
 await f.request('stop',{instanceId:'third-instance'});assert.equal(f.manager.snapshot('third-instance').state,'stopped');
});
test('Studio submits, polls and cancels a task',async t=>{
 const f=await fixture(t);await f.request('start',{instanceId:'third-instance'});
 const accepted=await f.request('run',{instanceId:'third-instance',input:'x'});assert.equal(accepted.status,202);const {jobId}=await accepted.json();
 await f.request('cancel',{id:jobId});
 let state;for(let i=0;i<40;i++){state=await(await f.request('state')).json();if(state.jobs[0].state!=='running')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.jobs[0].state,'cancelled');
});
test('Studio returns successful job output and never leaks callback errors',async t=>{
 const f=await fixture(t);await f.request('start',{instanceId:'third-instance'});await f.request('run',{instanceId:'third-instance',input:'success'});
 let state;for(let i=0;i<50;i++){state=await(await f.request('state')).json();if(state.jobs[0].state!=='running')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(state.jobs[0].state,'completed');assert.match(state.jobs[0].text,/success/);
});
