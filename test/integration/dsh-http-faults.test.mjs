import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {HarnessManager,HarnessRegistry} from '../../dist/index.mjs';
import {createDshProvider} from '../../dist/adapters/dsh.mjs';
import {loadPinnedClient} from '../../dist/adapters/pinned-runtime.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let n=0;n<400;n++){if(await predicate())return;await pause(20);}throw Error('Evidence deadline exceeded');}
const request=runId=>({schemaVersion:2,runId,subject:'test',input:{type:'text',text:runId},permissions:['host:tools'],session:{mode:'ephemeral'},timeoutMs:12000});
/** Real sealed SDK, native worker and HTTP transport; only the model endpoint/tool are controlled. */
async function fixture(t,{mode='ok',execute}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'dsh-http-fault-')));
 const evidence={requests:[],calls:[],failures:[],events:[]},clients=[],gates=[];
 const server=createServer(async(req,res)=>{
  try{
   let body='';for await(const chunk of req)body+=chunk;
   const input=JSON.parse(body);evidence.requests.push(input);
   assert.equal(req.headers.authorization,'Bearer synthetic-fault-key');
   if(mode==='accepted-drop'){res.destroy();return;}
   if(mode==='429'){res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'429 local rate limit',type:'rate_limit_error'}}));return;}
   if(mode==='401'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'401 local auth failure'}}));return;}
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   if(mode==='waiting'){res.write(': waiting\n\n');return;}
   const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fault-fixture',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
   const tool=input.messages.find(m=>m.role==='tool');
   if(mode==='partial-text'||mode==='socket-text'){send({role:'assistant',content:'INCOMPLETE_PREVIEW'});if(mode==='socket-text')setTimeout(()=>res.destroy(),30);else res.end();return;}
   if(mode==='partial-tool'||mode==='socket-tool'){send({role:'assistant',tool_calls:[{index:0,id:'partial',type:'function',function:{name:'receipt',arguments:'{"value":'}}]});if(mode==='socket-tool')setTimeout(()=>res.destroy(),30);else res.end();return;}
   if(execute&&!tool){send({role:'assistant',tool_calls:[{index:0,id:'receipt-'+evidence.requests.length,type:'function',function:{name:'receipt',arguments:'{}'}}]});send({},'tool_calls');}
   else{send({role:'assistant',content:tool?'RECEIPT_RETURNED':'HEALTHY'});send({},'stop');}
   res.end('data: [DONE]\n\n');
  }catch(error){evidence.serverError=error;res.destroy();}
 });
 if(mode==='before-http')server.on('connection',socket=>socket.destroy());
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const runtime=path.resolve('.vendor/dsh-runtime'),Client=await loadPinnedClient(runtime);
 const provider=createDshProvider({runtimeRoot:runtime,resolveModelRoute:()=>({apiKey:'synthetic-fault-key',baseURL:`http://127.0.0.1:${server.address().port}`}),
  loadClient:async()=>class extends Client{constructor(options){super({...options,onFailure:(message,code)=>{evidence.failures.push(code);options.onFailure?.(message,code);}});clients.push(this);}},
  resolveTurn:task=>({sessionKey:task.runId,hostSessionId:task.runId,hostAgentId:task.instanceId,hostLifecycleRevision:task.generation,provider:'deepseek-official',model:'deepseek-v4-flash',assertActive(){},hostTools:execute?[{name:'receipt',description:'Synthetic temporary receipt, never a real business operation',parameters:{type:'object',properties:{}},permissions:['host:tools'],async execute(callId,args,signal){evidence.calls.push({runId:task.runId,callId});return execute({callId,args,signal,root,gates});}}]:[]})});
 const registry=new HarnessRegistry();registry.register(provider);const manager=new HarnessManager(registry);
 for(const id of ['a','b']){await mkdir(path.join(root,id));manager.create({id,provider:'dsh',config:{workspaceRoot:path.join(root,id),sessionPersistenceRoot:path.join(root,'sessions-'+id)},policy:{subjects:['test'],allow:['host:tools']}});}
 t.after(async()=>{
  for(const release of gates)release();
  // Fault injection operates only on ChildProcess handles created by this fixture's client.
  for(const client of clients)if(client.child?.exitCode===null&&client.child.signalCode===null)client.child.kill('SIGCONT');
  await Promise.all(manager.list().map(i=>manager.stop(i.id,{force:true,graceMs:6000})));
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
 });
 await manager.start('a');
 return {root,manager,clients,evidence,run:(id='a',runId=mode,options={})=>manager.runV2(id,request(runId),{onEvent:e=>evidence.events.push(e),...options})};
}
for(const mode of ['before-http','accepted-drop','partial-text','partial-tool','socket-text','socket-tool','401','429'])test('real DSH HTTP fault: '+mode,{timeout:30000},async t=>{
 const f=await fixture(t,{mode,execute:async()=>{throw Error('Incomplete response must never dispatch a tool');}});
 await assert.rejects(f.run(),e=>e.code==='RUN_FAILED');await until(()=>f.manager.snapshot('a').activeRuns===0);
 assert.equal(f.evidence.requests.length,mode==='before-http'?0:1,'Count SDK transport attempts separately from CoNest task dispatch');
 assert.equal(f.evidence.calls.length,0);assert.equal(f.evidence.events.filter(e=>e.type==='run.started').length,1);
 assert(!f.evidence.events.some(e=>e.type==='run.completed'));assert.equal(f.manager.executionFences().length,0);
 assert.equal(f.manager.snapshot('a').state,'ready');assert.equal(f.evidence.serverError,undefined);
 t.diagnostic(JSON.stringify({mode,httpRequests:f.evidence.requests.length,toolCalls:0,localWork:'settled',externalBilling:'not inferred'}));
});
test('real DSH cancellation retains noncooperative tool work until its durable receipt settles',{timeout:30000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let callbackSignal;
 const f=await fixture(t,{execute:async({callId,signal,root,gates})=>{callbackSignal=signal;gates.push(()=>release.resolve());await writeFile(path.join(root,'receipt.json'),JSON.stringify({callId,committed:true}));entered.resolve();await release.promise;return {content:[{type:'text',text:'COMMITTED'}]};}});
 const controller=new AbortController(),run=f.run('a','noncooperative',{signal:controller.signal}),rejected=assert.rejects(run,e=>e.code==='RUN_CANCELLED');
 await entered.promise;controller.abort();await rejected;await until(()=>callbackSignal.aborted);
 assert.equal(f.manager.snapshot('a').activeRuns,1);assert.equal(f.evidence.calls.length,1);
 assert.equal(JSON.parse(await readFile(path.join(f.root,'receipt.json'),'utf8')).committed,true);
 release.resolve();await until(()=>f.manager.snapshot('a').activeRuns===0);
 assert.equal(f.evidence.requests.length,1,'No result sent to model after cancellation');assert.equal(f.manager.executionFences().length,0);
 assert(!f.evidence.events.some(e=>e.type==='run.completed'));
});
test('real DSH IPC disconnect before exit preserves receipt, joins tool work and isolates B',{timeout:40000,skip:process.platform==='win32'?'POSIX pause gives an observable disconnect-before-exit window':false},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await fixture(t,{execute:async({callId,root,gates})=>{gates.push(()=>release.resolve());await writeFile(path.join(root,'receipt.json'),JSON.stringify({callId,committed:true}));entered.resolve();await release.promise;return {content:[{type:'text',text:'COMMITTED'}]};}});
 await f.manager.start('b');
 const run=f.run('a','lost-receipt'),rejected=assert.rejects(run,e=>e.code==='RUN_INTERRUPTED');await entered.promise;
 const child=f.clients[0].child;assert(child&&child.pid!==process.pid);
 child.kill('SIGSTOP');child.disconnect();await rejected;
 assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.equal(f.manager.snapshot('a').lastError,'TRANSPORT_LOST');
 assert.equal(f.evidence.failures[0],'TRANSPORT_LOST');assert.equal(f.manager.snapshot('a').activeRuns,1);
 assert.equal(JSON.parse(await readFile(path.join(f.root,'receipt.json'),'utf8')).committed,true);
 await assert.rejects(f.run('a','no-replay'));
 const exit=once(child,'exit');child.kill('SIGCONT');await exit;
 assert(f.evidence.failures.every(code=>code==='TRANSPORT_LOST'||code==='PROCESS_EXITED'));
 release.resolve();await until(()=>f.manager.snapshot('a').activeRuns===0);
 assert.equal(f.evidence.calls.length,1,'Committed call is never automatically replayed');
 // B uses a new session and the same actual SDK; a fresh callback may run independently.
 const healthy=await f.run('b','isolated');assert.equal(healthy.state,'completed');assert.equal(f.evidence.calls.length,2);
 assert(!f.evidence.events.some(e=>e.runId==='lost-receipt'&&e.type==='run.completed'));
});
test('real DSH observed worker exit has process-exit evidence',{timeout:30000},async t=>{
 const f=await fixture(t);const child=f.clients[0].child,exited=once(child,'exit');
 child.kill('SIGKILL');await exited;await until(()=>f.evidence.failures.includes('PROCESS_EXITED'));
 assert.equal(f.manager.snapshot('a').state,'failed');assert.equal(f.manager.snapshot('a').lastError,'PROCESS_EXITED');
 assert.equal(child.signalCode,'SIGKILL');assert.equal(f.evidence.requests.length,0);
});

test('real DSH model request survives as an unknown fence after coordinator crash, never replayed',{timeout:40000},async t=>{
 const {spawn}=await import('node:child_process');
 const {HarnessRpcClient}=await import('../../dist/rpc.mjs');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'dsh-real-recovery-'))),children=[];
 const received=Promise.withResolvers();let connectionClosed=false,requests=0;
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': model accepted; awaiting cancellation\n\n');
  res.once('close',()=>connectionClosed=true);received.resolve();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await mkdir(path.join(root,'workspace'));
 await writeFile(path.join(root,'instances.json'),JSON.stringify({schemaVersion:1,instances:[{id:'dsh',provider:'dsh',providerConfigVersion:1,policy:{subjects:['studio'],allow:['workspace:read']},providerConfig:{workspaceRoot:path.join(root,'workspace'),sessionPersistenceRoot:path.join(root,'sessions'),model:{name:'deepseek-v4-flash',credentialRef:'env:DEEPSEEK_API_KEY'}}}]}));
 t.after(async()=>{
  for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(6000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
 });
 async function launch(){
  const child=spawn(process.execPath,['test/fixtures/dsh-recovery-coordinator.mjs',root,`http://127.0.0.1:${server.address().port}`],{stdio:['ignore','ignore','pipe','ipc']});
  const exited=once(child,'exit');children.push({child,exited});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const result=await Promise.race([once(child,'message'),exited.then(()=>{throw Error('Fixture exited: '+errors);})]);
  return {child,exited,client:new HarnessRpcClient(result[0].url+'/rpc',()=> 'synthetic-private-fixture-token-for-local-tests')};
 }
 const first=await launch();await first.client.request('instance.start',{instanceId:'dsh'});
 const params={instanceId:'dsh',input:'Wait for this local test stream'},id='real-dsh-crash';
 const admitted=await first.client.request('task.run',params,{id});await received.promise;
 assert.equal(requests,1);first.child.kill('SIGKILL');await first.exited;
 await until(()=>connectionClosed);
 const second=await launch(),state=await second.client.request('instance.list');
 assert.equal(state.jobs[0].id,admitted.jobId);assert.equal(state.jobs[0].executionState,'unknown');assert.equal(state.instances[0].admissionBlocked,true);
 const records=(await second.client.request('execution.list')).records;assert.equal(records.length,1);assert.equal(records[0].status,'uncertain');
 await second.client.request('instance.start',{instanceId:'dsh'});
 await assert.rejects(second.client.request('task.run',params),error=>error.code==='RUN_OUTCOME_UNKNOWN');
 assert.deepEqual(await second.client.request('task.run',params,{id}),admitted);assert.equal(requests,1);
 second.child.kill('SIGTERM');assert.equal((await second.exited)[0],0);
 const third=await launch();assert.equal((await third.client.request('execution.list')).records[0].status,'uncertain');assert.equal(requests,1);
 third.child.kill('SIGTERM');assert.equal((await third.exited)[0],0);
});

test('active real DSH worker exit is not downgraded by the failed RPC catch',{timeout:30000},async t=>{
 const f=await fixture(t,{mode:'waiting'});
 const run=f.run(),rejected=assert.rejects(run,e=>e.code==='RUN_INTERRUPTED');
 await until(()=>f.evidence.requests.length===1);
 const child=f.clients[0].child,exited=once(child,'exit');child.kill('SIGKILL');await exited;await rejected;
 await until(()=>f.manager.snapshot('a').activeRuns===0);
 assert(f.evidence.failures.includes('PROCESS_EXITED'));assert.equal(f.manager.snapshot('a').lastError,'PROCESS_EXITED');
 assert.equal(f.evidence.requests.length,1);assert(!f.evidence.events.some(e=>e.type==='run.completed'));
});
