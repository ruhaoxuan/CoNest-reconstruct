import {LocalPrivateVault} from '../../dist/private-vault.mjs';
import {createEnvironmentCredentials} from '../../dist/credentials.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createPublicKey,verify,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,cp,rm,appendFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {OpenClawConnection} from '../../dist/adapters/openclaw-connection.mjs';
import {loadOpenClawClient} from '../../dist/adapters/openclaw-client.mjs';
import {fixture,hello,agent,requestOptions,delay,device} from '../fixtures/openclaw.mjs';
const root=path.resolve('.vendor/openclaw-client'),require=createRequire(path.join(root,'package.json'));
const {WebSocketServer}=require('ws');
const {buildDeviceAuthPayloadV3}=await import(pathToFileURL(require.resolve('@openclaw/gateway-client')).href);
const Client=await loadOpenClawClient(root);
async function server(t,{changeHello,connectError,noChallenge=false,holdHello=false,onRequest}={}){
 const http=createServer(),ws=new WebSocketServer({server:http}),requests=[],errors=[];let connections=0;
 ws.on('connection',socket=>{
  connections++;const nonce=randomUUID(),ts=Date.now();
  if(!noChallenge)socket.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce,ts}}));
  socket.on('message',bytes=>{
   try{
    const frame=JSON.parse(bytes.toString()),p=frame.params;requests.push(frame);
    const reply=payload=>socket.send(JSON.stringify({type:'res',id:frame.id,ok:true,payload}));
    if(frame.method==='connect'){
     assert.equal(p.minProtocol,4);assert.equal(p.maxProtocol,4);assert.equal(p.role,'operator');assert.deepEqual(p.scopes,['operator.read','operator.write']);assert(p.device);
     const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:p.device.publicKey},format:'jwk'});
     const payload=buildDeviceAuthPayloadV3({deviceId:p.device.id,clientId:p.client.id,clientMode:p.client.mode,role:p.role,scopes:p.scopes,signedAtMs:p.device.signedAt,token:p.auth.deviceToken??p.auth.bootstrapToken,nonce,platform:p.client.platform,deviceFamily:p.client.deviceFamily});
     assert.equal(p.device.nonce,nonce);assert.equal(p.device.signedAt,ts);assert(verify(null,Buffer.from(payload),publicKey,Buffer.from(p.device.signature,'base64url')),'signed device challenge');
     if(connectError){socket.send(JSON.stringify({type:'res',id:frame.id,ok:false,error:{code:'INVALID_REQUEST',message:'synthetic credential diagnostic',details:{code:connectError}}}));return;}
     if(!holdHello){const h=hello({snapshot:{presence:[],health:{},stateVersion:{presence:0,health:0},uptimeMs:0}});reply(changeHello?changeHello(h):h);}
    }else if(onRequest)onRequest({socket,frame,reply});else reply({ok:true});
   }catch(error){errors.push(error);socket.close(1008,'invalid fixture request');}
  });
 });
 await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of ws.clients)s.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>http.close(r));assert.deepEqual(errors,[]);});
 const endpoint='ws://127.0.0.1:'+http.address().port;
 return {endpoint,requests,connections:()=>connections,sockets:ws.clients};
}
function connection(t,s,extra={}){
 const f=fixture({config:{endpoint:s.endpoint},options:{runtimeRoot:root,loadClient:async()=>Client,handshakeTimeoutMs:500,...extra}}),c=new OpenClawConnection(f.options);t.after(()=>c.close());return {f,c};
}

test('official public client performs signed loopback handshake and paired auth on a fresh connection',async t=>{
 const s=await server(t),{f,c}=connection(t,s);await c.start();await c.request('health',{},requestOptions());await c.close();
 const c2=new OpenClawConnection(f.options);t.after(()=>c2.close());await c2.start();await c2.request('health',{},requestOptions());
 const connect=s.requests.filter(r=>r.method==='connect');assert.equal(connect.length,2);assert.equal(connect[0].params.auth.bootstrapToken,'synthetic-bootstrap');assert.equal(connect[1].params.auth.deviceToken,'synthetic-device-token');assert.equal(connect[1].params.auth.bootstrapToken,undefined);assert.equal(f.state.storeCalls,2);
});
for(const [label,change,code] of [
 ['version',h=>({...h,server:{...h.server,version:'2026.10.8'}}),'OPENCLAW_VERSION_MISMATCH'],
 ['wire',h=>({...h,protocol:3}),'OPENCLAW_PROTOCOL_MISMATCH'],
 ['scope',h=>({...h,auth:{...h.auth,scopes:['operator.read','operator.write','operator.admin']}}),'OPENCLAW_SCOPE_DENIED'],
 ['method',h=>({...h,features:{...h.features,methods:['health','agent']}}),'OPENCLAW_METHOD_UNAVAILABLE'],
])test('official client rejects incompatible '+label+' and stops reconnects',async t=>{
 const s=await server(t,{changeHello:change}),{f,c}=connection(t,s);await assert.rejects(c.start(),{code});assert.equal(f.state.storeCalls,0);await delay(1100);assert.equal(s.connections(),1);assert.equal(s.requests.filter(r=>r.method!=='connect').length,0);
});
for(const [native,code] of [['PAIRING_REQUIRED','OPENCLAW_PAIRING_REQUIRED'],['SCOPE_UPGRADE_REQUIRED','OPENCLAW_SCOPE_DENIED']])test('official client surfaces '+native+' without auto approval or scope fallback',async t=>{
 const s=await server(t,{connectError:native}),{c}=connection(t,s);await assert.rejects(c.start(),{code});await delay(1100);assert.equal(s.connections(),1);assert.deepEqual(s.requests.map(r=>r.method),['connect']);
});
test('official connection enforces a deadline both before challenge and after connect is sent',async t=>{
 for(const options of [{noChallenge:true},{holdHello:true}]){
  const s=await server(t,options),{c}=connection(t,s,{handshakeTimeoutMs:80});await assert.rejects(c.start(),{code:'OPENCLAW_HANDSHAKE_TIMEOUT'});await delay(1100);assert.equal(s.connections(),1);
 }
});
test('official final request is correlated, bounded and rejected on duplicate native submission',async t=>{
 const s=await server(t,{onRequest:({frame,reply})=>{assert.equal(frame.method,'agent');reply({runId:frame.params.idempotencyKey,status:'accepted'});setTimeout(()=>reply({runId:frame.params.idempotencyKey,status:'ok',result:{text:'protocol-fixture-only'}}),10);}}),{c}=connection(t,s);
 await c.start();let sent=0,accepted=0;const result=await c.request('agent',agent,{...requestOptions(),onSent:()=>sent++,onAccepted:()=>accepted++});assert.equal(sent,1);assert.equal(accepted,1);assert.equal(result.result.text,'protocol-fixture-only');await assert.rejects(c.request('agent',agent,requestOptions()),{code:'OPENCLAW_REPLAY_DENIED'});assert.equal(s.requests.filter(r=>r.method==='agent').length,1);
});
test('official RPC timeout after acceptance never resends, and disconnect never reconnects a running request',async t=>{
 for(const scenario of ['timeout','disconnect']){
  const s=await server(t,{onRequest:({socket,frame,reply})=>{reply({runId:frame.params.idempotencyKey,status:'accepted'});if(scenario==='disconnect')setTimeout(()=>socket.terminate(),5);}}),{c}=connection(t,s);await c.start();
  await assert.rejects(c.request('agent',agent,{...requestOptions(),timeoutMs:40}),{code:scenario==='disconnect'?'OPENCLAW_CONNECTION_RETIRED':'OPENCLAW_REQUEST_TIMEOUT'});
  if(scenario==='timeout')await assert.rejects(c.request('agent',agent,requestOptions()),{code:'OPENCLAW_REPLAY_DENIED'});
  await delay(1100);assert.equal(s.connections(),1);assert.equal(s.requests.filter(r=>r.method==='agent').length,1);
 }
});
test('revocation closes a real socket, blocks late results and keeps the fixture service alive',async t=>{
 const s=await server(t,{onRequest:()=>{}}),{f,c}=connection(t,s);await c.start();const request=c.request('agent',agent,requestOptions()),check=assert.rejects(request,{code:'OPENCLAW_CONNECTION_RETIRED'});f.credentials.revoke(f.options.config.credentialRef);await check;await c.close();
 assert.equal(s.connections(),1);assert.equal(s.requests.filter(r=>r.method==='gateway.shutdown').length,0);
 const other=connection(t,s);await other.c.start();assert.equal(s.connections(),2);
});
test('fixed optional support detects altered and extra dependency files before import',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'conest-client-seal-'));t.after(()=>rm(temp,{recursive:true,force:true}));const copy=path.join(temp,'support');await cp(root,copy,{recursive:true});
 const entry=path.join(copy,'node_modules/@openclaw/gateway-client/dist/index.mjs'),original=await readFile(entry);await appendFile(entry,'\n// synthetic drift\n');await assert.rejects(loadOpenClawClient(copy),{code:'OPENCLAW_SUPPORT_MISMATCH'});await writeFile(entry,original);await writeFile(path.join(copy,'node_modules/unsealed.mjs'),'// unsealed');await assert.rejects(loadOpenClawClient(copy),{code:'OPENCLAW_SUPPORT_MISMATCH'});
});

test('official signed connections recover private identity and credential epochs while each connection epoch changes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'conest-client-vault-'));t.after(()=>rm(dir,{recursive:true,force:true}));const s=await server(t);let credentials;
 let vault=await LocalPrivateVault.open(dir,{remember:value=>credentials.remember(value)});
 const wire=()=>{
  credentials=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:['env:TEST_BOOTSTRAP'],epochs:vault.credentialEpochs()});
  const identities=vault.references('identities',{secretValues:v=>[v.privateKeyPem]}),bindings=vault.references('bindings',{secretValues:()=>[]});
  bindings.register('local:test-gateway',{endpoint:s.endpoint,agentId:'conest-test',releaseProfile:'openclaw-2026.9.2-v4'});
  return {credentials,identities,bindings,deviceTokens:vault.scopedSecrets('device-auth'),runtimeRoot:root,loadClient:async()=>Client};
 };
 let services=wire();services.identities.register('local:test-device',device());let f=fixture({config:{endpoint:s.endpoint},options:services}),c=new OpenClawConnection(f.options);await c.start();const before=c.evidence();await c.close();vault.close();
 vault=await LocalPrivateVault.open(dir,{remember:value=>credentials.remember(value)});t.after(()=>vault.close());services=wire();f=fixture({config:{endpoint:s.endpoint},options:services});c=new OpenClawConnection(f.options);t.after(()=>c.close());await c.start();const after=c.evidence();
 assert.equal(after.identityLease,before.identityLease);assert.equal(after.gatewayBindingLease,before.gatewayBindingLease);assert.equal(after.credentialLease.epoch,before.credentialLease.epoch);assert.equal(after.credentialLease.persistence,'configured');assert.notEqual(after.connectionEpoch,before.connectionEpoch);assert.equal(after.gatewayBootId,'fixture-boot');assert(!JSON.stringify(after).includes('synthetic-device-token'));
 const connects=s.requests.filter(r=>r.method==='connect');assert.equal(connects[0].params.auth.bootstrapToken,'synthetic-bootstrap');assert.equal(connects[1].params.auth.deviceToken,'synthetic-device-token');assert.equal(s.requests.filter(r=>r.method==='agent').length,0);await c.close();
});
test('revoked persisted device auth retires the old connection and cannot silently fall back to bootstrap',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'conest-client-revoke-'));t.after(()=>rm(dir,{recursive:true,force:true}));const s=await server(t);let credentials;const vault=await LocalPrivateVault.open(dir,{remember:value=>credentials.remember(value)});t.after(()=>vault.close());credentials=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:['env:TEST_BOOTSTRAP'],epochs:vault.credentialEpochs()});
 const identities=vault.references('identities',{secretValues:v=>[v.privateKeyPem]}),bindings=vault.references('bindings',{secretValues:()=>[]});identities.register('local:test-device',device());bindings.register('local:test-gateway',{endpoint:s.endpoint,agentId:'conest-test',releaseProfile:'openclaw-2026.9.2-v4'});const deviceTokens=vault.scopedSecrets('device-auth'),f=fixture({config:{endpoint:s.endpoint},options:{credentials,identities,bindings,deviceTokens,runtimeRoot:root,loadClient:async()=>Client}}),c=new OpenClawConnection(f.options);t.after(()=>c.close());await c.start();const proof=c.evidence();deviceTokens.revoke(proof.gatewayBindingLease,proof.identityLease);assert.throws(()=>c.evidence(),{code:'OPENCLAW_CONNECTION_RETIRED'});await c.close();
 const next=new OpenClawConnection(f.options);t.after(()=>next.close());await assert.rejects(next.start(),{code:'CREDENTIAL_REVOKED'});assert.equal(s.connections(),1);assert.equal(s.requests.filter(r=>r.method==='agent').length,0);
});
