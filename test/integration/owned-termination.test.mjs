import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessRegistry,HarnessManager} from '../../dist/index.mjs';
import {createDshProvider} from '../../dist/adapters/dsh.mjs';
import {loadPinnedClient} from '../../dist/adapters/pinned-runtime.mjs';
test('force stop reaps only its own paused SDK process group',{timeout:30000,skip:process.platform==='win32'?'POSIX SIGSTOP fault injection; Windows requires native evidence':false},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-force-'))),runtime=path.resolve('.vendor/dsh-runtime');let client;
 const Client=await loadPinnedClient(runtime),registry=new HarnessRegistry();registry.register(createDshProvider({runtimeRoot:runtime,proofMode:true,loadClient:async()=>class extends Client{constructor(options){super(options);client=this;}},resolveTurn:()=>{throw Error('No model task in this test');}}));
 const manager=new HarnessManager(registry);manager.createConfigured({id:'owned',provider:'dsh',providerConfigVersion:1,policy:{subjects:['test']},providerConfig:{workspaceRoot:root,sessionPersistenceRoot:path.join(root,'sessions')},control:{stopGraceMs:20,terminateTimeoutMs:5000}});
 t.after(async()=>{await manager.stop('owned',{force:true,graceMs:100});await rm(root,{recursive:true,force:true});});
 await manager.start('owned');const pid=(await client.status()).pid;assert.notEqual(pid,process.pid);process.kill(pid,'SIGSTOP');
 await manager.stop('owned',{force:true,graceMs:20});assert.equal(manager.snapshot('owned').resourceState,'released');
 assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
