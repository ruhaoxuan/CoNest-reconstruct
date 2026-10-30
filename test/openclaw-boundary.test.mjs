import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenClawConnection,validateOpenClawConnectionConfig} from '../dist/adapters/openclaw-connection.mjs';
import {fixture,hello,config,agent,requestOptions,delay} from './fixtures/openclaw.mjs';

test('optional connection config rejects remote/normalized/credential URLs, raw secrets and unpinned profiles',()=>{
 for(const endpoint of ['ws://localhost:18810','ws://127.1:18810','ws://2130706433:18810','ws://127.0.0.1:18810/a/..','ws://127.0.0.1:18810?token=x','ws://x@127.0.0.1:18810','wss://127.0.0.1:18810','ws://127.0.0.1:0','ws://127.0.0.1:65536','ws://[::1]:18810/#x'])assert.throws(()=>validateOpenClawConnectionConfig({...config,endpoint}));
 for(const extra of [{token:'literal'},{scope:['operator.admin']},{model:'override'},{pid:123},{releaseProfile:'latest'}])assert.throws(()=>validateOpenClawConnectionConfig({...config,...extra}));
 assert.equal(validateOpenClawConnectionConfig({...config,endpoint:'ws://[::1]:18810/'}).endpoint,'ws://[::1]:18810');
});
test('only explicit start loads the optional SDK; unregistered credentials/bindings fail before loading',async()=>{
 const f=fixture(),c=new OpenClawConnection(f.options);assert.equal(f.state.loads,0);await assert.rejects(c.request('health',{},requestOptions()),{code:'OPENCLAW_NOT_READY'});await c.close();assert.equal(f.state.loads,0);
 const denied=fixture({options:{credentials:fixture().credentials}});denied.bindings.replace(config.gatewayBindingRef,{endpoint:'ws://127.0.0.1:1',agentId:config.agentId,releaseProfile:config.releaseProfile});const d=new OpenClawConnection(denied.options);await assert.rejects(d.start(),{code:'OPENCLAW_BINDING_MISMATCH'});assert.equal(denied.state.loads,0);await d.close();
 const unregistered=fixture();unregistered.credentials.revoke(config.credentialRef);const u=new OpenClawConnection(unregistered.options);await assert.rejects(u.start(),{code:'CREDENTIAL_REVOKED'});assert.equal(unregistered.state.loads,0);await u.close();
});
test('handshake gates requests, signs with injected identity and persists device auth only after validation',async t=>{
 const f=fixture({autoHello:false}),c=new OpenClawConnection(f.options);t.after(()=>c.close());const start=c.start();await delay(0);await assert.rejects(c.request('health',{},requestOptions()),{code:'OPENCLAW_NOT_READY'});const settings=f.state.settings;
 assert.deepEqual(settings.env,{});assert.deepEqual(settings.scopes,['operator.read','operator.write']);assert.equal(settings.minProtocol,4);assert(settings.deviceIdentity.privateKeyPem);assert(settings.hostDeps.signDevicePayload(settings.deviceIdentity.privateKeyPem,'payload'));
 settings.onHelloOk(hello());await start;assert.equal(f.state.storeCalls,1);assert.equal(f.credentials.redact(hello().auth.deviceToken),'[REDACTED]');await c.request('health',{},requestOptions());
});
for(const [label,changes,code] of [
 ['wire',{protocol:3},'OPENCLAW_PROTOCOL_MISMATCH'],['version',{server:{version:'2026.10.8',connId:'fixture'}},'OPENCLAW_VERSION_MISMATCH'],
 ['scope missing',{auth:{role:'operator',scopes:['operator.read'],deviceToken:'synthetic-device-token'}},'OPENCLAW_SCOPE_DENIED'],
 ['scope excess',{auth:{role:'operator',scopes:['operator.read','operator.write','operator.admin'],deviceToken:'synthetic-device-token'}},'OPENCLAW_SCOPE_DENIED'],
 ['method',{features:{methods:['agent','health']}},'OPENCLAW_METHOD_UNAVAILABLE'],
 ['device auth',{auth:{role:'operator',scopes:['operator.read','operator.write']}},'OPENCLAW_DEVICE_AUTH_REQUIRED'],
])test('handshake rejects '+label+' without caching invalid credentials',async()=>{
 const f=fixture({hello:hello(changes)}),c=new OpenClawConnection(f.options);await assert.rejects(c.start(),{code});assert.equal(f.state.storeCalls,0);assert(f.state.stops>0);await c.close();
});
test('pairing refusal is closed, does not retry or expose native secrets',async()=>{
 const f=fixture({autoHello:false}),c=new OpenClawConnection(f.options),start=c.start();const rejected=assert.rejects(start,e=>e.code==='OPENCLAW_PAIRING_REQUIRED'&&!e.message.includes('synthetic-bootstrap'));await delay(0);const err=Object.assign(new Error('synthetic-bootstrap'),{details:{code:'PAIRING_REQUIRED'}});f.state.settings.onConnectError(err);await rejected;await delay(5);assert.equal(f.state.starts,1);await c.close();
});
test('handshake has a finite deadline and an aborted caller does not poison cleanup',async()=>{
 for(const abort of [false,true]){const f=fixture({autoHello:false,options:{handshakeTimeoutMs:20}}),c=new OpenClawConnection(f.options),controller=new AbortController();const pending=c.start({signal:controller.signal});const check=assert.rejects(pending,{code:abort?'OPENCLAW_CONNECT_ABORTED':'OPENCLAW_HANDSHAKE_TIMEOUT'});await delay(0);if(abort)controller.abort();await check;await c.close();assert(f.state.stops>0);}
});
test('late SDK load after connect cancellation cannot open a socket',async()=>{
 const f=fixture();let release;const load=new Promise(r=>release=r),c=new OpenClawConnection({...f.options,loadClient:()=>load}),controller=new AbortController();const start=c.start({signal:controller.signal});const check=assert.rejects(start,{code:'OPENCLAW_CONNECT_ABORTED'});controller.abort();await check;let constructed=0;release(class{constructor(){constructed++;}});await delay(0);assert.equal(constructed,0);await c.close();
});
test('method, session and finite deadline checks reject dangerous native actions before transport',async t=>{
 const f=fixture(),c=new OpenClawConnection(f.options);t.after(()=>c.close());await c.start();
 for(const [method,params,options] of [['gateway.shutdown',{},requestOptions()],['chat.abort',{sessionKey:agent.sessionKey,agentId:config.agentId},requestOptions()],['chat.abort',{runId:'r',sessionKey:'main',agentId:config.agentId},requestOptions()],['agent',{...agent,message:'/reset'},requestOptions()],['agent',{...agent,timeout:1000},requestOptions()],['agent',agent,{...requestOptions(),timeoutMs:Infinity}],['agent',agent,{...requestOptions(),expectFinal:false}],['health',{token:'bad'},requestOptions()]])await assert.rejects(c.request(method,params,options));
 assert.equal(f.state.requests.length,0);
});
test('request timeout and disconnect never replay an agent; retired epochs reject late callbacks and results',async t=>{
 let finish;const native=new Promise(r=>finish=r),events=[];const f=fixture({request:()=>native,options:{onEvent:e=>events.push(e)}}),c=new OpenClawConnection(f.options);t.after(()=>c.close());await c.start();let sent=0,accepted=0;const opts={...requestOptions(),timeoutMs:20,onSent:()=>sent++,onAccepted:()=>accepted++};
 const timed=c.request('agent',agent,opts);await Promise.all([assert.rejects(timed,{code:'OPENCLAW_REQUEST_TIMEOUT'}),delay(40)]);await assert.rejects(c.request('agent',agent,requestOptions()),{code:'OPENCLAW_REPLAY_DENIED'});assert.equal(f.state.requests.length,1);assert.equal(sent,1);
 const waiting=c.request('agent',{...agent,idempotencyKey:'native-r2'},requestOptions());const rejected=assert.rejects(waiting,{code:'OPENCLAW_CONNECTION_RETIRED'});const old=f.state.settings;old.onClose(1006,'synthetic disconnect');old.onHelloOk(hello());old.onEvent({event:'late'});for(const r of f.state.requests)r.options.onAccepted?.({status:'accepted'});finish({text:'late'});await rejected;assert.equal(accepted,0);assert.equal(events.length,0);assert.equal(f.state.starts,1);await assert.rejects(c.start(),{code:'OPENCLAW_CONNECTION_RETIRED'});
});
test('credential revocation and private binding replacement reject late native responses',async t=>{
 for(const change of ['credential','binding']){
  let finish;const native=new Promise(r=>finish=r),f=fixture({request:()=>native}),c=new OpenClawConnection(f.options);t.after(()=>c.close());await c.start();const pending=c.request('health',{},requestOptions());const check=assert.rejects(pending,{code:change==='credential'?'OPENCLAW_CONNECTION_RETIRED':'PRIVATE_LEASE_STALE'});
  if(change==='credential')f.credentials.revoke(config.credentialRef);else f.bindings.replace(config.gatewayBindingRef,{...f.bindings.acquire(config.gatewayBindingRef).value});finish({ok:true});await check;
 }
});

test('shared connection budget limits acquisitions and releases after actual cleanup',async()=>{
 const f=fixture(),a=new OpenClawConnection(f.options),b=new OpenClawConnection(f.options),blocked=new OpenClawConnection(f.options);await a.start();await b.start();await assert.rejects(blocked.start(),{code:'PRIVATE_RESOURCE_LIMIT'});await blocked.close();await a.close();const next=new OpenClawConnection(f.options);await next.start();await next.close();await b.close();
});
test('unconfirmed transport cleanup retains its shared budget slot',async()=>{
 const f=fixture();const Original=await f.options.loadClient();let constructed=0;const options={...f.options,connections:{acquire(){assert.equal(constructed++,0);return ()=>constructed--; }},loadClient:async()=>class extends Original{async stopAndWait(){await new Promise(()=>{});}}};
 const c=new OpenClawConnection(options);await c.start();await c.close();assert.equal(constructed,1);
});

test('an observed late socket close releases a previously unconfirmed connection slot',async()=>{
 const f=fixture();const Original=await f.options.loadClient();let held=0;const options={...f.options,connections:{acquire(){assert.equal(held++,0);return ()=>held--; }},loadClient:async()=>class extends Original{async stopAndWait(){await new Promise(()=>{});}}};
 const c=new OpenClawConnection(options);await c.start();await c.close();assert.equal(held,1);f.state.settings.onClose(1000,'late actual close');assert.equal(held,0);
});

test('per-connection request limit denies excess work and closing retires all admitted RPCs',async()=>{
 const f=fixture({request:()=>new Promise(()=>{})}),c=new OpenClawConnection(f.options);await c.start();
 const admitted=Array.from({length:16},()=>c.request('health',{}, {...requestOptions(),timeoutMs:1000}));const joined=Promise.allSettled(admitted);
 await assert.rejects(c.request('health',{},requestOptions()),{code:'OPENCLAW_REQUEST_LIMIT'});assert.equal(f.state.requests.length,16);await c.close();const results=await joined;assert(results.every(r=>r.status==='rejected'&&r.reason.code==='OPENCLAW_CONNECTION_RETIRED'));
});
