import {createServer,type IncomingMessage} from 'node:http';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile,chmod,realpath} from 'node:fs/promises';
import path from 'node:path';
import {LocalStateStore} from '../state-store.mjs';
import {HarnessError,requireCondition} from '../contracts.mjs';
import {loadPinnedClient} from '../adapters/pinned-runtime.mjs';
import {canonical} from '../publication.mjs';
import {LabCoordinator} from './coordinator-client.mjs';
import {startLabModel} from './model-fixture.mjs';
import {parseLabAction} from './contracts.mjs';
import type {Evidence} from './contracts.mjs';
import {labPage} from './page.mjs';
export interface LabOptions {stateRoot:string;runtimeRoot:string;port?:number}
async function body(req:IncomingMessage):Promise<unknown>{let text='';for await(const chunk of req){text+=String(chunk);requireCondition(Buffer.byteLength(text)<=4096,'INVALID_REQUEST','Lab action exceeds 4KB');}try{return JSON.parse(text);}catch{throw new HarnessError('INVALID_REQUEST','JSON required');}}
export async function startDshFaultLab(options:LabOptions){
 await loadPinnedClient(options.runtimeRoot);
 await mkdir(options.stateRoot,{recursive:true,mode:0o700});const root=await realpath(options.stateRoot),marker=path.join(root,'lab.json');
 try{const saved:unknown=JSON.parse(await readFile(marker,'utf8'));requireCondition(saved!==null&&typeof saved==='object'&&'kind' in saved&&saved.kind==='dsh-fault-lab-v1','LAB_STATE','Unrecognized lab state');}
 catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'){requireCondition((await readdir(root)).length===0,'LAB_STATE','Choose a new empty lab directory');await writeFile(marker,JSON.stringify({kind:'dsh-fault-lab-v1'})+'\n',{flag:'wx',mode:0o600});}else throw error;}
 const store=await LocalStateStore.open(root),model=await startLabModel(),events:Evidence[]=[];
 const coordinator=new LabCoordinator(path.join(root,'coordinator'),model.url,path.resolve(options.runtimeRoot),e=>{events.push(e);if(events.length>200)events.shift();});
 let closing=false;
 const token=randomUUID(),viewerToken=randomUUID(),nonce=randomUUID();
 const grants=[{token,permissions:['lab:read','lab:control']},{token:viewerToken,permissions:['lab:read']}];
 const digest=(value:string)=>createHash('sha256').update(value).digest();
 const cache=new Map<string,Promise<{status:number;body:string}>>();
 const snapshot=async(permissions:readonly string[])=>{
  const state=await coordinator.refresh();
  return {kind:'dsh-fault-lab-v1',model:'localhost-deterministic',paidInference:false,permissions,coordinator:coordinator.state,...state,
   // This is an observation overlay while the authority is dead, not a persisted markUncertain shortcut.
   jobs:state.jobs.map(j=>coordinator.state!=='ready'&&j.executionState==='active'?{...j,state:'interrupted',executionState:'unknown',text:'COORDINATOR_EXITED'}:j),
   modelReceipts:[...model.receipts],events:[...events],storage:store.status()};
 };
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  try{
   const address=server.address();requireCondition(address&&typeof address==='object','LAB_CLOSING','Not listening');
   const hosts=[`127.0.0.1:${address.port}`,`localhost:${address.port}`];
   if(!hosts.includes(req.headers.host??'')||(req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`))){respond(403,{error:'ORIGIN_DENIED'});return;}
   if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(labPage(nonce));return;}
   const grant=grants.find(g=>timingSafeEqual(digest(req.headers.authorization??''),digest('Bearer '+g.token)));
   if(!grant){respond(401,{error:'TOKEN_REQUIRED'});return;}
   requireCondition(!closing,'LAB_CLOSING','Lab is closing');
   if(req.method==='GET'&&req.url==='/api/state'){respond(200,await snapshot(grant.permissions));return;}
   if(req.method!=='POST'||req.url!=='/api/action'){respond(404,{error:'NOT_FOUND'});return;}
   if(!grant.permissions.includes('lab:control')){respond(403,{error:'MANAGEMENT_DENIED'});return;}
   requireCondition(req.headers['content-type']?.startsWith('application/json'),'INVALID_REQUEST','JSON required');
   const action=parseLabAction(await body(req)),key='lab:'+action.id,fingerprint=createHash('sha256').update(canonical(action)).digest('hex');
   // Stable command receipts prevent double-click/reconnect replay. Pending crashed outcomes are never retried.
   const existing=cache.get(key);if(existing){const old=store.reserveRpc(key,fingerprint);requireCondition(!old?.expired,'RPC_RECEIPT_EXPIRED','Receipt expired');const response=await existing;res.writeHead(response.status,{'Content-Type':'application/json'});res.end(response.body);return;}
   const stored=store.reserveRpc(key,fingerprint);
   if(stored?.response){const response=JSON.parse(stored.response) as {status:number;body:string};res.writeHead(response.status,{'Content-Type':'application/json'});res.end(response.body);return;}
   requireCondition(!stored?.pending&&!stored?.expired,stored?.pending?'LAB_OUTCOME_UNKNOWN':'RPC_RECEIPT_EXPIRED','Prior command cannot be replayed');
   requireCondition(cache.size<512,'LAB_LIMIT','Restart this lab to release the response cache');
   const work=(async()=>{
    try{
     let result:unknown={accepted:true};
     if(action.action==='crash-coordinator'){await coordinator.refresh();await coordinator.crash();}
     else if(action.action==='restart-coordinator')await coordinator.start();
     else if(action.action==='cut-stream')model.cut(action.runId);
     else result=await coordinator.request(action);
     return {status:200,body:JSON.stringify(result)};
    }catch(error){return {status:error instanceof HarnessError&&error.code==='LAB_OUTCOME_UNKNOWN'?503:409,body:JSON.stringify({error:error instanceof HarnessError?error.code:'LAB_FAILED'})};}
   })();cache.set(key,work);
   const response=await work;store.finishRpc(key,JSON.stringify(response));store.recordControl({type:'lab.action',requestId:action.id,method:action.action,status:response.status});
   res.writeHead(response.status,{'Content-Type':'application/json'});res.end(response.body);
  }catch(error){respond(error instanceof HarnessError&&['LAB_COORDINATOR_DOWN','LAB_CLOSING','LAB_OUTCOME_UNKNOWN'].includes(error.code)?503:400,{error:error instanceof HarnessError?error.code:'INVALID_REQUEST'});}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 try{
  await coordinator.start();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18807,'127.0.0.1',resolve);});
  const address=server.address();requireCondition(address&&typeof address==='object','LAB_START_FAILED','Address unavailable');const url=`http://127.0.0.1:${address.port}`;
  for(const [file,value] of [['connection.json',{url,token,mode:'dsh-fault-lab',pid:process.pid}],['viewer-connection.json',{url,token:viewerToken,mode:'dsh-fault-lab',access:'read-only',pid:process.pid}]] as const){const target=path.join(root,file);await writeFile(target,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(target,0o600);}
  let closePromise:Promise<void>|undefined;
  return {url,token,viewerToken,connectionFile:path.join(root,'connection.json'),async close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{await coordinator.close();await model.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();})();return closePromise;}};
 }catch(error){await coordinator.close();await model.close();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();throw error;}
}
