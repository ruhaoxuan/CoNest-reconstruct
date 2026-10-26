import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { once } from 'node:events';
import { Script } from 'node:vm';
import path from 'node:path';
import os from 'node:os';
test('standalone Studio HTTP -> manager -> real DSH completes, cancels and shuts down', {timeout:45000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'reconstruct-studio-'));
 const child=spawn(process.execPath,['dist/studio/launch.mjs'],{env:{...process.env,CONEST_RECONSTRUCT_STATE:root,CONEST_RECONSTRUCT_PORT:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,6000))]);if(child.exitCode===null)child.kill('SIGKILL');}await rm(root,{recursive:true,force:true});});
 let ready;
 for(let i=0;i<100;i++){try{ready=JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));break;}catch{}if(child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,50));}
 assert(ready,'Studio readiness missing');
 const api=async(route,data)=>{const response=await fetch(ready.url+'/api/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+ready.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});assert(response.ok,await response.clone().text());return response.json();};
 const html=await(await fetch(ready.url)).text();new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
 const states=await api('state');assert.equal(states.mode,'proof');assert.equal(states.instances[0].state,'stopped');
 await api('start',{instanceId:'dsh-demo'});
 const accepted=await api('run',{instanceId:'dsh-demo',input:'PROOF:BASH:'});
 async function done(id){for(let i=0;i<150;i++){const job=(await api('state')).jobs.find(j=>j.id===id);if(job?.state!=='running')return job;await new Promise(r=>setTimeout(r,50));}throw Error('Job timeout');}
 const result=await done(accepted.jobId);assert.equal(result.state,'completed');assert.match(result.text,/RECONSTRUCT_STUDIO_CALLBACK_OK/);
 const waiting=await api('run',{instanceId:'dsh-demo',input:'PROOF:BASH:WAIT'});await new Promise(r=>setTimeout(r,400));await api('cancel',{id:waiting.jobId});assert.equal((await done(waiting.jobId)).state,'cancelled');
 await api('stop',{instanceId:'dsh-demo'});assert.equal((await api('state')).instances[0].activeRuns,0);
 const exit=once(child,'exit');child.kill('SIGTERM');const [code]=await exit;assert.equal(code,0,stderr);
});
