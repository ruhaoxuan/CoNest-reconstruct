import {createHash,generateKeyPairSync} from 'node:crypto';
import {createEnvironmentCredentials} from '../../dist/credentials.mjs';
import {createPrivateReferences,createProviderResourceBudget} from '../../dist/provider-services.mjs';
export const config={releaseProfile:'openclaw-2026.9.2-v4',endpoint:'ws://127.0.0.1:18810',agentId:'conest-test',credentialRef:'env:TEST_BOOTSTRAP',identityRef:'local:test-device',gatewayBindingRef:'local:test-gateway'};
export function device(){const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=Buffer.from(publicKey.export({format:'jwk'}).x,'base64url');return {deviceId:createHash('sha256').update(raw).digest('hex'),privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}),publicKeyPem:publicKey.export({type:'spki',format:'pem'})};}
export function hello(overrides={}){return {type:'hello-ok',protocol:4,server:{version:'2026.9.2',connId:'fixture-connection',bootId:'fixture-boot'},features:{methods:['agent','agent.wait','chat.abort','health'],events:['agent']},snapshot:{},auth:{role:'operator',scopes:['operator.read','operator.write'],deviceToken:'synthetic-device-token'},policy:{maxPayload:1048576,maxBufferedBytes:1048576,tickIntervalMs:30000},...overrides};}
export function fixture(overrides={}){
 const c={...config,...overrides.config},credentials=createEnvironmentCredentials({TEST_BOOTSTRAP:'synthetic-bootstrap'},{references:['env:TEST_BOOTSTRAP']}),identities=createPrivateReferences([{reference:c.identityRef,value:device()}]),bindings=createPrivateReferences([{reference:c.gatewayBindingRef,value:{endpoint:c.endpoint,agentId:c.agentId,releaseProfile:c.releaseProfile}}]),tokens=new Map();
 const state={loads:0,starts:0,stops:0,requests:[],settings:undefined,storeCalls:0};
 const options={connections:createProviderResourceBudget(2),config:c,runtimeRoot:'/explicit/optional/support',credentials,identities,bindings,handshakeTimeoutMs:500,closeTimeoutMs:50,deviceTokens:{load:(b,i)=>tokens.get(b+':'+i),store:(b,i,value)=>{state.storeCalls++;tokens.set(b+':'+i,value);}},loadClient:async()=>{state.loads++;return class {
  constructor(settings){state.settings=settings;}
  start(){state.starts++;if(overrides.autoHello!==false)queueMicrotask(()=>state.settings.onHelloOk(overrides.hello??hello()));}
  stop(){state.stops++;}
  async stopAndWait(){}
  request(method,params,options){state.requests.push({method,params,options});options.onSent?.();return overrides.request?overrides.request(method,params,options):Promise.resolve({ok:true});}
 };},...overrides.options};return {options,state,credentials,identities,bindings,tokens};
}
export const agent={message:'Read the fixture evidence',idempotencyKey:'native-r1',agentId:'conest-test',sessionKey:'agent:conest-test:conest-r1',deliver:false,timeout:1};
export const requestOptions=()=>({timeoutMs:100,signal:new AbortController().signal,expectFinal:true});
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
