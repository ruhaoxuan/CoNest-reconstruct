import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {startDshFaultLab} from '../../dist/lab/server.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'conest-fault-lab-')));
 let lab=await startDshFaultLab({stateRoot:root,runtimeRoot:path.resolve('.vendor/dsh-runtime'),port:0});
 t.after(async()=>{await lab.close();await rm(root,{recursive:true,force:true});});
 const request=async(route,{token=lab.token,method='GET',data,headers={}}={})=>fetch(lab.url+route,{method,headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});
 const state=async()=>{const response=await request('/api/state');assert.equal(response.status,200,await response.clone().text());return response.json();};
 const act=async(action,expected=200,id=randomUUID())=>{const response=await request('/api/action',{method:'POST',data:{id,...action}});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;};
 const until=async condition=>{for(let n=0;n<200;n++){const s=await state();if(condition(s))return s;await pause(25);}throw Error('Lab observation timed out');};
 const run=(scenario='normal',instanceId='a')=>act({action:'run',instanceId,scenario});
 return {root,get lab(){return lab;},request,state,act,until,run,async restart(){await lab.close();lab=await startDshFaultLab({stateRoot:root,runtimeRoot:path.resolve('.vendor/dsh-runtime'),port:0});}};
}
test('lab security: loopback, scopes, strict actions, durable duplicate receipts and isolated state',{timeout:40000},async t=>{
 const f=await fixture(t);
 const page=await fetch(f.lab.url),html=await page.text();assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert(!html.includes(f.lab.token));
 assert.equal((await f.request('/api/state',{token:''})).status,401);
 const viewer=await f.request('/api/state',{token:f.lab.viewerToken});assert.deepEqual((await viewer.json()).permissions,['lab:read']);
 assert.equal((await f.request('/api/action',{method:'POST',token:f.lab.viewerToken,data:{id:randomUUID(),action:'crash-coordinator'}})).status,403);
 assert.equal((await f.request('/api/state',{headers:{Origin:'http://other.invalid'}})).status,403);
 const {request:wireRequest}=await import('node:http');
 const wrongHost=await new Promise(resolve=>{const req=wireRequest(new URL('/api/state',f.lab.url),{headers:{Host:'other.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.end();});assert.equal(wrongHost,403);
 await f.act({action:'terminate-worker',instanceId:'a',pid:process.pid},400);
 await f.act({action:'run',instanceId:'a',scenario:'normal',baseURL:'https://other.invalid'},400);
 await f.act({action:'run',instanceId:'a',scenario:'shell'},400);
 const id=randomUUID(),body={action:'run',instanceId:'a',scenario:'normal'};
 const [a,b]=await Promise.all([f.act(body,200,id),f.act(body,200,id)]);assert.equal(a.runId,b.runId);
 await f.until(s=>s.jobs.find(j=>j.runId===id)?.state==='completed');
 assert.equal((await f.state()).modelReceipts.filter(r=>r.runId===id).length,1);
 await f.act({...body,scenario:'model-wait'},400,id);
 const text=JSON.stringify(await f.state());assert(!text.includes(f.lab.token));assert(!text.includes(f.lab.viewerToken));assert(!text.includes('synthetic-dsh-lab-key'));
 assert.equal((await stat(path.join(f.root,'connection.json'))).mode&0o777,0o600);
 await f.restart();assert.equal((await f.act(body,200,id)).runId,id);assert.equal((await f.state()).modelReceipts.length,0,'No duplicate dispatch after parent restart');
 const foreign=path.join(f.root,'foreign');await mkdir(foreign);await writeFile(path.join(foreign,'user.txt'),'preserve');
 await assert.rejects(startDshFaultLab({stateRoot:foreign,runtimeRoot:path.resolve('.vendor/dsh-runtime'),port:0}),e=>e.code==='LAB_STATE');assert.equal(await readFile(path.join(foreign,'user.txt'),'utf8'),'preserve');
});
test('lab HTTP controls exercise real truncated streams and reject incomplete tools',{timeout:40000},async t=>{
 const f=await fixture(t);const pending=await f.run('model-wait');
 await f.until(s=>s.modelReceipts.some(r=>r.runId===pending.runId&&r.stage==='streaming'));
 await f.act({action:'cut-stream',runId:pending.runId});
 const failed=await f.until(s=>s.jobs.find(j=>j.runId===pending.runId)?.state==='failed'&&s.instances.find(i=>i.id==='a').activeRuns===0);
 assert(!failed.jobs.find(j=>j.runId===pending.runId).events.some(e=>e.type==='run.completed'));
 const partial=await f.run('partial-tool');const end=await f.until(s=>s.jobs.find(j=>j.runId===partial.runId)?.state==='failed');
 assert.equal(end.jobs.find(j=>j.runId===partial.runId).events.filter(e=>e.type==='tool.receipt-committed').length,0);
 const normal=await f.run();const done=await f.until(s=>s.jobs.find(j=>j.runId===normal.runId)?.state==='completed');assert.match(done.jobs.find(j=>j.runId===normal.runId).text,/真实 DSH/);
});
test('lab durable tool receipt outlives caller cancellation and cannot be released by a viewer',{timeout:40000},async t=>{
 const f=await fixture(t),pending=await f.run('tool-wait');
 await f.until(s=>s.jobs.find(j=>j.runId===pending.runId)?.events.some(e=>e.type==='tool.receipt-committed'));
 const receipt=JSON.parse(await readFile(path.join(f.root,'coordinator','receipts',pending.runId+'.json'),'utf8'));assert.equal(receipt.synthetic,true);
 await f.act({action:'cancel',runId:pending.runId});
 const cancelled=await f.until(s=>s.jobs.find(j=>j.runId===pending.runId)?.state==='cancelled');assert.equal(cancelled.instances.find(i=>i.id==='a').activeRuns,1);
 await f.act({action:'restart-instance',instanceId:'a'},409);
 assert.equal((await f.request('/api/action',{method:'POST',token:f.lab.viewerToken,data:{id:randomUUID(),action:'release-tool',runId:pending.runId}})).status,403);
 const b=await f.run('normal','b');await f.until(s=>s.jobs.find(j=>j.runId===b.runId)?.state==='completed');
 await f.act({action:'release-tool',runId:pending.runId});
 const settled=await f.until(s=>s.instances.find(i=>i.id==='a').activeRuns===0);
 const job=settled.jobs.find(j=>j.runId===pending.runId);assert.equal(job.state,'cancelled');assert.equal(job.executionState,'settled');assert(job.events.some(e=>e.type==='tool.returned'));
 assert.equal(settled.modelReceipts.filter(r=>r.runId===pending.runId).length,1,'Cancelled callback result never drives another model request');
 const closing=await f.run('tool-wait');await f.until(s=>s.jobs.find(j=>j.runId===closing.runId)?.events.some(e=>e.type==='tool.receipt-committed'));
 await f.restart();const history=await f.state();const final=history.jobs.find(j=>j.runId===closing.runId);assert.equal(final.state,'cancelled');assert.equal(final.executionState,'settled');assert(!history.fences.some(e=>e.runId===closing.runId),'Graceful shutdown settles and saves actual callback work');
});
test('lab worker termination is owned, observed and isolated; explicit recovery does not replay',{timeout:40000},async t=>{
 const f=await fixture(t),pending=await f.run('model-wait');await f.until(s=>s.modelReceipts.some(r=>r.runId===pending.runId));
 await f.act({action:'terminate-worker',instanceId:'a'});
 const end=await f.until(s=>s.workers.a==='exit-observed'&&s.instances.find(i=>i.id==='a').activeRuns===0);
 assert.equal(end.instances.find(i=>i.id==='a').lastError,'PROCESS_EXITED');
 assert.equal(end.jobs.find(j=>j.runId===pending.runId).state,'interrupted');
 const b=await f.run('normal','b');await f.until(s=>s.jobs.find(j=>j.runId===b.runId)?.state==='completed');
 await f.act({action:'restart-instance',instanceId:'a'});const normal=await f.run();await f.until(s=>s.jobs.find(j=>j.runId===normal.runId)?.state==='completed');
 assert.equal((await f.state()).modelReceipts.filter(r=>r.runId===pending.runId).length,1);
});
test('lab actual coordinator crash preserves unknown fences, receipts and explicit risk semantics',{timeout:50000},async t=>{
 const f=await fixture(t),pending=await f.run('tool-wait');
 await f.until(s=>s.jobs.find(j=>j.runId===pending.runId)?.events.some(e=>e.type==='tool.receipt-committed'));
 await f.act({action:'crash-coordinator'});const down=await f.state();assert.equal(down.coordinator,'exit-observed');assert.equal(down.jobs.find(j=>j.runId===pending.runId).executionState,'unknown');
 await f.act({action:'restart-coordinator'});const restored=await f.until(s=>s.fences.some(f=>f.runId===pending.runId&&f.status==='uncertain'));
 assert.equal(restored.instances.find(i=>i.id==='a').admissionBlocked,true);assert(restored.jobs.find(j=>j.runId===pending.runId).events.some(e=>e.type==='tool.receipt-committed'));
 const blocked=await f.act({action:'run',instanceId:'a',scenario:'normal'},409);assert.equal(blocked.error,'RUN_OUTCOME_UNKNOWN');
 const fence=restored.fences.find(f=>f.runId===pending.runId);
 await f.act({action:'acknowledge',instanceId:'a',runId:pending.runId,token:fence.token,acceptRisk:false},409);
 assert.equal((await f.request('/api/action',{method:'POST',token:f.lab.viewerToken,data:{id:randomUUID(),action:'acknowledge',instanceId:'a',runId:pending.runId,token:fence.token,acceptRisk:true}})).status,403);
 await f.act({action:'acknowledge',instanceId:'a',runId:pending.runId,token:randomUUID(),acceptRisk:true},409);
 await f.act({action:'acknowledge',instanceId:'a',runId:pending.runId,token:fence.token,acceptRisk:true});
 const acknowledged=await f.state();assert.equal(acknowledged.jobs.find(j=>j.runId===pending.runId).executionState,'acknowledged-unknown');assert.equal(acknowledged.instances.find(i=>i.id==='a').admissionBlocked,false);
 const normal=await f.run();await f.until(s=>s.jobs.find(j=>j.runId===normal.runId)?.state==='completed');
 assert.equal((await f.state()).modelReceipts.filter(r=>r.runId===pending.runId).length,1);
 await f.restart();const persisted=await f.state();assert.equal(persisted.fences.find(f=>f.runId===pending.runId).status,'acknowledged');assert.equal(persisted.jobs.find(j=>j.runId===pending.runId).executionState,'acknowledged-unknown');
});

test('lab example starts without credentials and cleans up its coordinator on shutdown',{timeout:30000},async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'conest-lab-cli-')));
 const child=spawn(process.execPath,['examples/dsh-fault-lab.mjs'],{env:{...process.env,CONEST_LAB_STATE:root,CONEST_LAB_PORT:'0',DEEPSEEK_API_KEY:'',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',NO_PROXY:'',no_proxy:'',NODE_USE_ENV_PROXY:'1'},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});});
 for(let n=0;n<200&&!output.includes('"ready":true');n++){if(child.exitCode!==null)throw Error(errors);await pause(25);}
 assert.match(output,/"ready":true/);const ready=JSON.parse(output.trim());assert.equal(ready.paidInference,false);
 const connection=JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));assert.equal(connection.mode,'dsh-fault-lab');assert(!output.includes(connection.token));
 const response=await fetch(connection.url+'/api/state',{headers:{Authorization:'Bearer '+connection.token}});assert.equal(response.status,200);assert.equal((await response.json()).coordinator,'ready');
 const admitted=await fetch(connection.url+'/api/action',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),action:'run',instanceId:'a',scenario:'normal'})});assert.equal(admitted.status,200);const {runId}=await admitted.json();
 let final;for(let n=0;n<200;n++){final=await (await fetch(connection.url+'/api/state',{headers:{Authorization:'Bearer '+connection.token}})).json();if(final.jobs.find(j=>j.runId===runId)?.state==='completed')break;await pause(25);}
 assert.equal(final.jobs.find(j=>j.runId===runId)?.state,'completed','The lab-owned model route must remain local even with an unavailable ambient proxy');
 child.kill('SIGTERM');assert.equal((await exited)[0],0);
});
