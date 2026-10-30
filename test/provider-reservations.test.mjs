import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {LocalStateStore} from '../dist/state-store.mjs';
const key={instanceId:'a',runId:'r',generation:'g'};
async function root(t){const dir=await mkdtemp(path.join(os.tmpdir(),'conest-reserve-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('cross-generation reservation admits one winner and cannot be bypassed by generic write',async t=>{
 const store=await LocalStateStore.open(await root(t));t.after(()=>store.close());const records=store.providerRecords('p');assert.equal(records.lookupRun('a','r').status,'none');
 const results=await Promise.allSettled(Array.from({length:8},(_,i)=>Promise.resolve().then(()=>records.reserveRun({...key,generation:'g'+i},{phase:'prepared',nativeSubmissionKey:'n'+i}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='PRIVATE_RUN_EXISTS'));
 const found=records.lookupRun('a','r');assert.equal(found.status,'unique');assert.equal(found.record.key.generation,'g0');records.write(found.record.key,1,{phase:'terminal-evidence'});assert.throws(()=>records.reserveRun({...key,generation:'new'},{}),{code:'PRIVATE_RUN_EXISTS'});assert.throws(()=>records.write({...key,generation:'bypass'},null,{}),{code:'PRIVATE_RUN_EXISTS'});
 assert.equal(store.providerRecords('other').reserveRun(key,{}).revision,1);assert.equal(records.reserveRun({...key,instanceId:'b'},{}).revision,1);
});
test('legacy ambiguous mappings remain intact and cannot be mistaken for a unique old run',async t=>{
 const store=await LocalStateStore.open(await root(t));t.after(()=>store.close());const records=store.providerRecords('p');records.write(key,null,{nativeSubmissionKey:'one'});assert.equal(records.lookupRun('a','r').status,'unique');records.write({...key,generation:'old'},null,{nativeSubmissionKey:'two'});assert.deepEqual(records.lookupRun('a','r'),{status:'ambiguous'});assert.throws(()=>records.reserveRun({...key,generation:'third'},{}),{code:'PRIVATE_RUN_EXISTS'});assert.equal(records.read(key).value.nativeSubmissionKey,'one');
});
test('a failed private insert rolls back the reservation and does not acknowledge a submission identity',async t=>{
 const dir=await root(t);let store=await LocalStateStore.open(dir);const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON provider_records BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
 assert.throws(()=>store.providerRecords('p').reserveRun(key,{}),{code:'STATE_WRITE_FAILED'});assert.equal(db.prepare('SELECT count(*) AS n FROM provider_run_reservations').get().n,0);store.close();db.exec('DROP TRIGGER deny_insert');db.close();store=await LocalStateStore.open(dir);t.after(()=>store.close());assert.equal(store.providerRecords('p').reserveRun(key,{}).revision,1);
});
test('actual coordinator exit preserves the old generation and forbids a second reservation',async t=>{
 const dir=await root(t),module=pathToFileURL(path.resolve('dist/state-store.mjs')).href;const child=spawnSync(process.execPath,['--input-type=module','-e',`import {LocalStateStore} from ${JSON.stringify(module)};const s=await LocalStateStore.open(process.argv[1]);s.providerRecords('p').reserveRun(${JSON.stringify(key)},{phase:'prepared',nativeSubmissionKey:'original'});process.exit(0);`,dir],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const store=await LocalStateStore.open(dir);t.after(()=>store.close());const records=store.providerRecords('p');assert.equal(records.lookupRun('a','r').record.key.generation,'g');assert.throws(()=>records.reserveRun({...key,generation:'after-restart'},{}),{code:'PRIVATE_RUN_EXISTS'});assert.equal(JSON.stringify(store.audit()).includes('original'),false);
});

test('a retained reservation with a missing mapping fails closed instead of creating a replacement native identity',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir);t.after(()=>store.close());const records=store.providerRecords('p');records.reserveRun(key,{nativeSubmissionKey:'original'});const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec('DELETE FROM provider_records');db.close();assert.deepEqual(records.lookupRun('a','r'),{status:'ambiguous'});assert.throws(()=>records.reserveRun({...key,generation:'new'},{}),{code:'PRIVATE_RUN_EXISTS'});assert.throws(()=>records.write(key,null,{nativeSubmissionKey:'replacement'}),{code:'PRIVATE_RUN_EXISTS'});
});
