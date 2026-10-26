import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry,HarnessManager,parseConfig } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
const raw=(delay=20)=>({id:'a',provider:'third',providerConfigVersion:1,policy:{subjects:['alice'],allow:[]},providerConfig:{mode:'wait',delayMs:delay},control:{defaultRunTimeoutMs:10,maxRunTimeoutMs:100}});
function fixture(){const registry=new HarnessRegistry();registry.register({...createTestProvider('third'),configContract:{version:1,fields:[]}});return {registry,manager:new HarnessManager(registry)};}
test('generic config parser supports a third provider and rejects invalid envelopes',()=>{
 const {registry}=fixture();const config={schemaVersion:1,instances:[raw()]};assert.equal(parseConfig(JSON.stringify(config),registry).length,1);
 for(const bad of [{...config,schemaVersion:2},{...config,instances:[raw(),raw()]},{...config,x:true}])assert.throws(()=>parseConfig(JSON.stringify(bad),registry));
 for(const c of [{defaultRunTimeoutMs:'10'},{defaultRunTimeoutMs:0},{defaultRunTimeoutMs:101,maxRunTimeoutMs:100},{stopGraceMs:null}])assert.throws(()=>parseConfig(JSON.stringify({...config,instances:[{...raw(),control:c}]}),registry));
 assert.throws(()=>parseConfig('{"schemaVersion":1,"instances":[],"__proto__":{}}',registry));
});
test('stopped apply uses revision CAS; running and failed persistence cannot replace config',async()=>{
 const {manager}=fixture();manager.createConfigured(raw());const old=manager.configured('a');await manager.start('a');
 await assert.rejects(manager.applyConfig('a',raw(30),old.revision),e=>e.code==='CONFIG_RESTART_REQUIRED');await manager.stop('a');
 await assert.rejects(manager.applyConfig('a',raw(30),'stale'),e=>e.code==='CONFIG_CONFLICT');
 await assert.rejects(manager.applyConfig('a',raw(30),old.revision,async()=>{throw Error('disk failure');}));assert.equal(manager.configured('a').revision,old.revision);
 await manager.applyConfig('a',raw(30),old.revision);assert.notEqual(manager.configured('a').revision,old.revision);
});
test('configured task deadlines are enforced without extending the instance ceiling',async()=>{
 const {manager}=fixture();manager.createConfigured(raw(100));await manager.start('a');
 await assert.rejects(manager.run('a',{runId:'one',subject:'alice',input:'x',timeoutMs:101}));
 await assert.rejects(manager.run('a',{runId:'two',subject:'alice',input:'x'}),e=>e.code==='RUN_TIMEOUT');await manager.stop('a');
});
test('atomic single-instance store detects revisions and preserves valid JSON',async t=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const {persistConfig}=await import('../dist/index.mjs');const dir=await mkdtemp(path.join(os.tmpdir(),'config-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {manager,registry}=fixture();const file=path.join(dir,'instance.json');manager.createConfigured(raw());const first=manager.configured('a');
 await persistConfig(file,null,first,registry);
 const next=manager.previewConfig(raw(30));await manager.applyConfig('a',raw(30),first.revision,c=>persistConfig(file,first.revision,c,registry));
 assert.equal(parseConfig(await readFile(file,'utf8'),registry)[0].revision,next.revision);
 await assert.rejects(persistConfig(file,first.revision,first,registry));
});
