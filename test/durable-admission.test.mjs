import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {HarnessRegistry,HarnessManager} from '../dist/index.mjs';
import {createTestProvider} from '../dist/testing.mjs';
import {LocalStateStore} from '../dist/state-store.mjs';
import {startStudio} from '../dist/studio/server.mjs';
import {HarnessRpcClient} from '../dist/rpc.mjs';
async function root(t){const dir=await mkdtemp(path.join(os.tmpdir(),'durable-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('expired durable RPC receipts remain tombstones and cannot repeat an executed request',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir);t.after(()=>store.close());
 store.reserveRpc('scope:id','fingerprint-hash');store.finishRpc('scope:id','{"ok":true}');
 const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('UPDATE rpc SET response=NULL WHERE id=\'scope:id\'');db.close();
 assert.deepEqual(store.reserveRpc('scope:id','fingerprint-hash'),{expired:true});assert.throws(()=>store.reserveRpc('scope:id','different'),e=>e.code==='RPC_CONFLICT');
});
test('a task is never dispatched if durable admission fails; RPC parameters are stored as hashes',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir),registry=new HarnessRegistry();registry.register(createTestProvider());const manager=new HarnessManager(registry);
 manager.create({id:'a',provider:'test.echo',policy:{subjects:['studio']}});await manager.start('a');let dispatched=0;
 const token=randomUUID(),controlToken=randomUUID(),studio=await startStudio({manager,store,token,additionalTokens:[{token:controlToken,permissions:['instance:control']}],mode:'proof',port:0,async submitTask(){dispatched++;return {};}});
 t.after(()=>studio.close());const admin=new HarnessRpcClient(studio.url+'/rpc',()=>token),controller=new HarnessRpcClient(studio.url+'/rpc',()=>controlToken);
 assert.deepEqual(await controller.request('instance.start',{instanceId:'a'}),{accepted:true});
 const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('DROP TABLE jobs');
 await assert.rejects(admin.request('task.run',{instanceId:'a',input:'synthetic-sensitive-prompt'}),e=>e.code==='STATE_WRITE_FAILED');assert.equal(dispatched,0);
 for(const row of db.prepare('SELECT fingerprint FROM rpc').all()){assert.match(row.fingerprint,/^[a-f0-9]{64}$/);assert.doesNotMatch(row.fingerprint,/synthetic-sensitive/);}db.close();
});
