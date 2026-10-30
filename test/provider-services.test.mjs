import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createEnvironmentCredentials,guardCredentialInstance} from '../dist/credentials.mjs';
import {createPrivateReferences} from '../dist/provider-services.mjs';
import {LocalStateStore} from '../dist/state-store.mjs';
const reference='env:TEST_BOOTSTRAP',key={instanceId:'a',runId:'r',generation:'g'};
async function root(t){const dir=await mkdtemp(path.join(os.tmpdir(),'conest-private-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('trusted credential registration is copied, bounded and does not grant arbitrary environment access',()=>{
 const refs=[reference],credentials=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap',OTHER:'unregistered-secret'},{references:refs});refs.push('env:OTHER');
 assert.equal(credentials.resolve(reference),'synthetic-bootstrap');assert.throws(()=>credentials.resolve('env:OTHER'),{code:'CREDENTIAL_REFERENCE_DENIED'});
 assert.throws(()=>createEnvironmentCredentials({},{references:['env:PATH/../secret']}),{code:'CREDENTIAL_REFERENCE_DENIED'});
 assert.throws(()=>createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'}).resolve(reference),{code:'CREDENTIAL_REFERENCE_DENIED'});
});
test('all registered credentials are redacted before resolution and after rotation, including escaped PEM material',()=>{
 const env={TEST_BOOTSTRAP:'synthetic-old-bootstrap',UNUSED:'synthetic-never-resolved'},c=createEnvironmentCredentials(env,{references:[reference,'env:UNUSED']});
 c.rotate(reference,'synthetic-new-bootstrap');env.UNUSED='synthetic-current-unused';
 const pem='-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----';c.remember(pem);
 const raw=JSON.stringify(JSON.stringify({old:'synthetic-old-bootstrap',current:'synthetic-new-bootstrap',never:'synthetic-never-resolved',now:env.UNUSED,pem}));
 const safe=c.redact(raw);for(const secret of ['synthetic-old-bootstrap','synthetic-new-bootstrap','synthetic-never-resolved','synthetic-current-unused','synthetic-private-key'])assert(!safe.includes(secret));
 c.revoke(reference);assert.throws(()=>c.resolve(reference),{code:'CREDENTIAL_REVOKED'});assert(c.redact('synthetic-new-bootstrap').includes('[REDACTED]'));
});
test('rotation rejects late provider results and progress even when the underlying provider ignores cancellation',async()=>{
 let finish,emit,fail;const waiting=new Promise(r=>finish=r),c=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:[reference]});
 const instance=guardCredentialInstance({async start(){},async stop(){},async run(_,ctx){emit=()=>ctx.emit('late');await waiting;return 'late';}},c,reference,c.resolve(reference));
 instance.setFailureHandler(code=>fail=code);let events=0;const pending=instance.run({}, {emit(){events++;},assertAuthorized(){}});const rejected=assert.rejects(pending,{code:'CREDENTIAL_STALE'});
 c.rotate(reference,'synthetic-rotated');assert.equal(fail,'CREDENTIAL_STALE');assert.throws(emit,{code:'CREDENTIAL_STALE'});finish();await rejected;assert.equal(events,0);await instance.stop();
});
test('private references copy identity material, reject forged leases and invalidate old identity/binding leases',()=>{
 const original={endpoint:'ws://127.0.0.1:18810',nested:{revision:1}},refs=createPrivateReferences([{reference:'local:gateway',value:original}]);original.nested.revision=2;
 const lease=refs.acquire('local:gateway');assert.equal(lease.value.nested.revision,1);assert(Object.isFrozen(lease.value.nested));
 assert.throws(()=>refs.acquire('local:../key'),{code:'PRIVATE_REFERENCE_DENIED'});assert.throws(()=>refs.assertActive({...lease}),{code:'PRIVATE_LEASE_STALE'});
 refs.replace('local:gateway',{...original});assert.throws(()=>refs.assertActive(lease),{code:'PRIVATE_LEASE_STALE'});const next=refs.acquire('local:gateway');assert.notEqual(next.lease,lease.lease);
 refs.revoke('local:gateway');assert.throws(()=>refs.assertActive(next),{code:'PRIVATE_LEASE_STALE'});assert.throws(()=>refs.acquire('local:gateway'),{code:'PRIVATE_REFERENCE_DENIED'});
});
test('private durable records use scoped generation-aware CAS and never enter jobs or audit',async t=>{
 const dir=await root(t);let store=await LocalStateStore.open(dir),records=store.providerRecords('provider.a');
 const first=records.write(key,null,{nativeSubmissionKey:'native-r',phase:'prepared'});assert.equal(first.revision,1);
 assert.throws(()=>records.write(key,null,{phase:'sent'}),{code:'PRIVATE_RECORD_CONFLICT'});assert.throws(()=>records.write(key,2,{phase:'sent'}),{code:'PRIVATE_RECORD_CONFLICT'});
 records.write(key,1,{nativeSubmissionKey:'native-r',phase:'sent'});assert.equal(store.providerRecords('provider.b').read(key),undefined);assert.equal(records.read({...key,generation:'new'}),undefined);
 assert.equal(JSON.stringify(store.audit()).includes('native-r'),false);assert.equal(JSON.stringify(store.restoredJobs()).includes('native-r'),false);store.close();assert.throws(()=>records.read(key),{code:'STATE_CLOSED'});
 store=await LocalStateStore.open(dir);t.after(()=>store.close());const restored=store.providerRecords('provider.a').read(key);assert.equal(restored.revision,2);assert.equal(restored.value.nativeSubmissionKey,'native-r');
});
test('private prepared record survives actual coordinator process exit without implying native execution ended',async t=>{
 const dir=await root(t),module=pathToFileURL(path.resolve('dist/state-store.mjs')).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {LocalStateStore} from ${JSON.stringify(module)};const s=await LocalStateStore.open(process.argv[1]);s.providerRecords('provider.a').write({instanceId:'a',runId:'r',generation:'g'},null,{phase:'prepared',nativeSubmissionKey:'original-key'});process.exit(0);`,dir],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);const store=await LocalStateStore.open(dir);t.after(()=>store.close());assert.deepEqual(store.providerRecords('provider.a').read(key).value,{phase:'prepared',nativeSubmissionKey:'original-key'});
});
test('private ledger refuses secret-shaped fields, registered secrets, non-JSON and oversized records before writing',async t=>{
 const dir=await root(t),c=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:[reference]}),store=await LocalStateStore.open(dir,c.redact);t.after(()=>store.close());const records=store.providerRecords('provider.a');
 for(const v of [{token:'opaque'}, {nested:{privateKeyPem:'pem'}},{description:'synthetic-bootstrap'},{n:NaN},{f:()=>{}},{text:'x'.repeat(8193)}])assert.throws(()=>records.write(key,null,v));
 assert.equal(records.read(key),undefined);const cycle={};cycle.value=cycle;assert.throws(()=>records.write(key,null,cycle));
});
test('private journal write failures do not acknowledge dispatch or mutate the old revision',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir);t.after(()=>store.close());const records=store.providerRecords('provider.a');records.write(key,null,{phase:'prepared'});
 const db=new DatabaseSync(path.join(dir,'control.sqlite'));db.exec("CREATE TRIGGER deny_private BEFORE UPDATE ON provider_records BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END; CREATE TRIGGER deny_private_insert BEFORE INSERT ON provider_records BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");db.close();
 assert.throws(()=>records.write(key,1,{phase:'sent'}),{code:'STATE_WRITE_FAILED'});assert.equal(records.read(key).revision,1);assert.equal(store.status().status,'failed');
});
test('private ledger keeps unknown records at capacity and refuses another admission',async t=>{
 const dir=await root(t),store=await LocalStateStore.open(dir);t.after(()=>store.close());const records=store.providerRecords('provider.a');
 for(let i=0;i<5000;i++)records.write({...key,runId:'r'+i},null,{phase:'unknown'});
 assert.throws(()=>records.write({...key,runId:'overflow'},null,{phase:'prepared'}),{code:'PRIVATE_RECORD_FULL'});assert.equal(records.read({...key,runId:'r0'}).value.phase,'unknown');records.write({...key,runId:'r0'},1,{phase:'terminal-evidence'});
});

test('restoring a revoked reference cannot revive the old instance or its pending result',async()=>{
 let finish;const gate=new Promise(r=>finish=r),c=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:[reference]});
 const native={async start(){},async stop(){},async run(){await gate;return 'late';}},old=guardCredentialInstance(native,c,reference,c.resolve(reference));const pending=old.run({}, {emit(){},assertAuthorized(){}});const check=assert.rejects(pending,{code:'CREDENTIAL_REVOKED'});
 c.revoke(reference);c.restore(reference);finish();await check;await assert.rejects(old.start(),{code:'CREDENTIAL_REVOKED'});await old.stop();
 const fresh=guardCredentialInstance(native,c,reference,c.resolve(reference));await fresh.start();await fresh.stop();
});
