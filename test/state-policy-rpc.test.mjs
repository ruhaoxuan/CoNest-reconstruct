import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HarnessManager,HarnessRegistry } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
import { LocalStateStore } from '../dist/state-store.mjs';
import { startStudio } from '../dist/studio/server.mjs';
import { HarnessRpcClient } from '../dist/rpc.mjs';
import { createEnvironmentCredentials,guardCredentialInstance } from '../dist/credentials.mjs';
async function root(t){const dir=await mkdtemp(path.join(os.tmpdir(),'conest-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const raw={id:'a',provider:'test',providerConfigVersion:1,policy:{subjects:['studio','other'],allow:['read','search'],tools:['read_file','search_text']},providerConfig:{}};
function fixture(options={}){const registry=new HarnessRegistry(),p=createTestProvider('test');registry.register({...p,features:{...p.features,externalToolMediation:true}});const manager=new HarnessManager(registry,options);manager.createConfigured(raw);return {manager,registry};}
test('SQLite preserves revocation and bounded history, excludes secrets from audit, and rejects a live second owner',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir,s=>s.replaceAll('synthetic-secret','[REDACTED]'));
 const {manager}=fixture({persistAuthorization:(id,value)=>store.saveAuthorization(id,value)});
 await manager.updateAccess('a',false);await manager.updatePolicy('a',{subjects:['studio'],allow:['read'],deny:[],tools:['read_file']});
 store.saveJobs([{id:'j',instanceId:'a',state:'running',events:[],text:'synthetic-secret'}]);
 store.record({type:'provider.progress',instanceId:'a',runId:'r',generation:'g',sequence:1,at:'now',data:{kind:'tool',name:'read_file',status:'completed',preview:'synthetic-secret'}});store.flush();
 await assert.rejects(LocalStateStore.open(dir),e=>e.code==='STATE_IN_USE');assert.equal((await stat(path.join(dir,'control.sqlite'))).mode&0o777,0o600);store.close();
 const reopened=await LocalStateStore.open(dir);t.after(()=>reopened.close());
 const restored=fixture();restored.manager.restoreAuthorization('a',reopened.authorizations().a);
 assert.equal(restored.manager.snapshot('a').taskAccess,'revoked');assert.deepEqual(restored.manager.policy('a').tools,['read_file']);
 const job=reopened.restoredJobs()[0];assert.equal(job.state,'interrupted');assert.equal(job.recovered,true);assert.doesNotMatch(JSON.stringify(reopened.audit()),/synthetic-secret|preview/);
});
test('dead coordinator lease recovers without replay and transactional authorization failure cannot grant access',async t=>{
 const dir=await root(t),module=path.resolve('dist/state-store.mjs');
 const script=`import {LocalStateStore} from ${JSON.stringify('file://'+module)};const s=await LocalStateStore.open(process.argv[1]);s.saveJobs([{id:'old',instanceId:'a',state:'running',events:[]}]);s.flush();process.exit(0);`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script,dir],{encoding:'utf8'}).status,0);
 const store=await LocalStateStore.open(dir);t.after(()=>store.close());assert.equal(store.restoredJobs()[0].state,'interrupted');
 const {manager}=fixture({persistAuthorization:(id,value)=>store.saveAuthorization(id,value)});await manager.updateAccess('a',false);
 const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('DROP TABLE audit');db.close();
 await assert.rejects(manager.updateAccess('a',true),e=>e.code==='STATE_WRITE_FAILED');assert.equal(manager.snapshot('a').taskAccess,'revoked');assert.equal(store.status().status,'failed');
});
test('dynamic policy cannot widen configured subjects, permissions or tools; later revocation wins over an asynchronous restore',async()=>{
 const gate=Promise.withResolvers();let blocking=false;
 const {manager}=fixture({persistAuthorization:async()=>{if(blocking)await gate.promise;}});
 for(const policy of [{subjects:['unlisted'],allow:[],deny:[]},{subjects:['studio'],allow:['write'],deny:[]},{subjects:['studio'],allow:['read'],deny:[],tools:['shell']}])await assert.rejects(manager.updatePolicy('a',policy),e=>e.code==='POLICY_CEILING');
 await manager.updateAccess('a',false);blocking=true;const restore=manager.updateAccess('a',true);await new Promise(r=>setImmediate(r));const revoke=manager.updateAccess('a',false);gate.resolve();await restore;await revoke;
 assert.equal(manager.snapshot('a').taskAccess,'revoked');
});
test('RPC dispatch checks version, permissions and mutation idempotency including after restart',async t=>{
 const dir=await root(t),token=randomUUID();let store=await LocalStateStore.open(dir);let {manager}=fixture();
 let studio=await startStudio({manager,store,token,port:0,mode:'proof',submitTask:async()=>({text:'ok'})});let client=new HarnessRpcClient(studio.url+'/rpc',()=>token);
 assert.equal((await client.request('instance.list')).instances.length,1);
 const id=randomUUID();const started=await client.request('instance.start',{instanceId:'a'},{id});assert.equal(started.instance.state,'ready');
 assert.deepEqual(await client.request('instance.start',{instanceId:'a'},{id}),started);
 await assert.rejects(client.request('instance.start',{instanceId:'other'},{id}),e=>e.code==='RPC_CONFLICT');await studio.close();
 store=await LocalStateStore.open(dir);({manager}=fixture());studio=await startStudio({manager,store,token,port:0,mode:'proof',submitTask:async()=>({})});t.after(()=>studio.close());client=new HarnessRpcClient(studio.url+'/rpc',()=>token);
 assert.deepEqual(await client.request('instance.start',{instanceId:'a'},{id}),started);assert.equal(manager.snapshot('a').state,'stopped','Cached reply must not restart the instance');
 const bad=await fetch(studio.url+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({version:999,id:'bad-version',method:'instance.list',params:{}})});assert.equal((await bad.json()).error.code,'RPC_VERSION');
});
test('credential rotation and revocation invalidate a guarded instance and never disclose secret values',async()=>{
 const env={DEEPSEEK_API_KEY:'synthetic-old-key'},credentials=createEnvironmentCredentials(env);let failure;
 const instance=guardCredentialInstance({async start(){},async stop(){},async run(){return {};}},credentials,'env:DEEPSEEK_API_KEY',credentials.resolve('env:DEEPSEEK_API_KEY'));
 instance.setFailureHandler(code=>failure=code);await instance.start();credentials.rotate('env:DEEPSEEK_API_KEY','synthetic-new-key');assert.equal(failure,'CREDENTIAL_STALE');await assert.rejects(instance.start(),e=>e.code==='CREDENTIAL_STALE');
 credentials.revoke('env:DEEPSEEK_API_KEY');assert.equal(failure,'CREDENTIAL_REVOKED');assert.throws(()=>credentials.resolve('env:DEEPSEEK_API_KEY'),e=>e.code==='CREDENTIAL_REVOKED');
 assert.equal(credentials.redact('synthetic-old-key synthetic-new-key'),'[REDACTED] [REDACTED]');await instance.stop();
});
