import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessRpcClient} from '../../dist/rpc.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('coordinator crash restores admitted history and authorization without replaying RPC or task work',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-recovery-')),file=path.join(root,'instances.json'),children=[];
 await writeFile(file,JSON.stringify({schemaVersion:1,instances:[{id:'slow',provider:'test.echo',providerConfigVersion:1,policy:{subjects:['studio','other'],allow:[]},providerConfig:{mode:'wait',delayMs:5000}}]}));
 t.after(async()=>{for(const {child,exited} of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}await rm(root,{recursive:true,force:true});});
 async function launch(){
  const child=spawn(process.execPath,['dist/studio/launch.mjs'],{env:{...process.env,CONEST_RECONSTRUCT_MODE:'proof',CONEST_RECONSTRUCT_CONFIG:file,CONEST_RECONSTRUCT_STATE:root,CONEST_RECONSTRUCT_PORT:'0'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');const record={child,exited};children.push(record);let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
  for(let i=0;i<100;i++){if(output.includes('"ready":true')){const connection=JSON.parse(await readFile(path.join(root,'connection.json'),'utf8'));return {...record,client:new HarnessRpcClient(connection.url+'/rpc',()=>connection.token)};}if(child.exitCode!==null)throw Error(errors);await pause(30);}throw Error('No readiness');
 }
 const first=await launch();await first.client.request('policy.update',{instanceId:'slow',policy:{subjects:['studio'],allow:[],deny:[]}});await first.client.request('instance.start',{instanceId:'slow'});
 const params={instanceId:'slow',input:'An admitted task before crash'},id='stable-crash-request';const admitted=await first.client.request('task.run',params,{id});
 first.child.kill('SIGKILL');await first.exited;
 const second=await launch();let state=await second.client.request('instance.list');assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].id,admitted.jobId);assert.equal(state.jobs[0].state,'interrupted');assert.equal(state.jobs[0].executionState,'unknown');assert.equal(state.instances[0].state,'stopped');
 assert.deepEqual((await second.client.request('policy.get',{instanceId:'slow'})).policy.subjects,['studio']);
 assert.deepEqual(await second.client.request('task.run',params,{id}),admitted);state=await second.client.request('instance.list');assert.equal(state.jobs.length,1);assert.equal(state.instances[0].activeRuns,0);
 await second.client.request('access.revoke',{instanceId:'slow'});second.child.kill('SIGTERM');assert.equal((await second.exited)[0],0);
 const third=await launch();state=await third.client.request('instance.list');assert.equal(state.instances[0].taskAccess,'revoked');await third.client.request('instance.start',{instanceId:'slow'});
 await assert.rejects(third.client.request('task.run',params),error=>error.code==='TASK_ACCESS_REVOKED');assert.equal((await third.client.request('instance.list')).jobs.length,1);
 third.child.kill('SIGTERM');assert.equal((await third.exited)[0],0);
});
