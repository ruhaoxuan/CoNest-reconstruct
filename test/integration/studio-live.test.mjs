import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEnvironmentCredentials } from '../../dist/credentials.mjs';
import { createLiveStudioProviders } from '../../dist/adapters/studio-live.mjs';
import { createStudioApplication } from '../../dist/studio/application.mjs';
import { startStudio } from '../../dist/studio/server.mjs';

test('offline live transport -> real DSH -> workspace tools: independent files, denial, traces and cancellation', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-live-')));
  const credential = 'synthetic-local-api-key', waiting = Promise.withResolvers(); let requests = 0; let lastTask = ''; let mockError;
  const mock = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); requests++;
      assert.doesNotMatch(body,new RegExp(credential));
      assert.equal(req.headers.authorization, 'Bearer ' + credential);
      assert.equal(input.model, 'deepseek-v4-flash');
      const task = [...input.messages].reverse().find(m => m.role === 'user' && JSON.stringify(m.content).includes('TEST_TASK:'))?.content ?? '';
      const text = typeof task === 'string' ? task : JSON.stringify(task); lastTask = text;
      assert.deepEqual(input.tools.map(t=>t.function.name).sort(),['list_files','read_file','search_text']);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (text.includes('WAIT_FOR_CANCEL')) { res.write(': waiting\n\n'); waiting.resolve(); return; }
      const tool = [...input.messages].reverse().find(m => m.role === 'tool');
      const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id:'local-fixture',object:'chat.completion.chunk',created:1,model:input.model,
        choices:[{index:0,delta,finish_reason}] }) + '\n\n');
      if (tool) { send({role:'assistant',content:'LOCAL_MODEL_RESULT: '+JSON.stringify(tool.content)}); send({},'stop'); }
      else {
        const name = text.includes('LIST') ? 'list_files' : text.includes('SEARCH') ? 'search_text' : 'read_file';
        const args = name === 'list_files' ? {} : name === 'search_text' ? {query:'Budget'} :
          {path: text.includes('OUTSIDE') ? '../outside.txt' : text.includes('CROSS_INSTANCE') ? '../beta/project-test.txt' : 'project-test.txt'};
        send({role:'assistant',tool_calls:[{index:0,id:'call-'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}); send({},'tool_calls');
      }
      res.end('data: [DONE]\n\n');
    } catch(error) { mockError = error; res.destroy(); }
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
  const instances=[];
  for(const [id,budget] of [['alpha',8500],['beta',9200]]) {
    const workspaceRoot=path.join(root,id);await mkdir(workspaceRoot);
    await writeFile(path.join(workspaceRoot,'project-test.txt'),`Owner: ${id}\nBudget: ${budget}\nSynthetic secret: ${credential}\n`);
    instances.push({id,provider:'dsh',providerConfigVersion:1,policy:{subjects:['studio'],allow:['workspace:read']},
      control:{defaultRunTimeoutMs:15000,maxRunTimeoutMs:15000,stopGraceMs:5000},providerConfig:{workspaceRoot,
        sessionPersistenceRoot:path.join(root,'sessions-'+id),model:{name:'deepseek-v4-flash',credentialRef:'env:DEEPSEEK_API_KEY'}}});
  }
  await writeFile(path.join(root,'outside.txt'),'OUTSIDE_SECRET');
  const credentials=createEnvironmentCredentials({DEEPSEEK_API_KEY:credential});
  const app=createStudioApplication(JSON.stringify({schemaVersion:1,instances}),createLiveStudioProviders(path.resolve('.vendor/conest'),credentials,
    {baseURL:`http://127.0.0.1:${mock.address().port}`}));
  const token=randomUUID();const studio=await startStudio({...app,token,port:0,mode:'live',redact:credentials.redact});
  t.after(async()=>{await studio.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await rm(root,{recursive:true,force:true});});
  const api=async(route,data)=>{
    const response=await fetch(studio.url+'/api/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    assert(response.ok,await response.clone().text());return response.json();
  };
  const done=async id=>{for(let i=0;i<300;i++){const job=(await api('state')).jobs.find(j=>j.id===id);if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,30));}throw Error('Timeout');};
  const run=async(id,input)=>done((await api('run',{instanceId:id,input:'TEST_TASK: '+input})).jobId);
  await api('start',{instanceId:'alpha'});await api('start',{instanceId:'beta'});
  const a=await run('alpha','READ '+credential);assert.equal(a.state,'completed');assert.match(a.text,/8500/);
  assert(a.events.some(e=>e.name==='read_file'&&e.status==='completed'&&typeof e.durationMs==='number'));
  const b=await run('beta','READ');assert.equal(b.state,'completed');assert.match(b.text,/9200/);assert.doesNotMatch(b.text,/8500/);
  for(const prompt of ['OUTSIDE','CROSS_INSTANCE']) {
    const denied=await run('alpha',prompt);
    assert(denied.events.some(e=>e.name==='read_file'&&e.status==='failed'&&e.errorCode==='PATH_DENIED'),JSON.stringify({denied,lastTask,error:mockError?.message}));
    assert.doesNotMatch(denied.text,/OUTSIDE_SECRET|9200/);
  }
  assert((await run('alpha','LIST')).events.some(e=>e.name==='list_files'&&e.status==='completed'));
  assert.match((await run('alpha','SEARCH')).text,/Budget/);
  const pending=await api('run',{instanceId:'alpha',input:'TEST_TASK: WAIT_FOR_CANCEL'});
  await waiting.promise;await api('cancel',{id:pending.jobId});assert.equal((await done(pending.jobId)).state,'cancelled');
  await api('stop',{instanceId:'alpha'});assert.equal(app.manager.snapshot('alpha').activeRuns,0);
  assert.match((await run('beta','READ')).text,/9200/);assert(requests>0);
  assert.doesNotMatch(JSON.stringify(await api('state')),new RegExp(credential));
});


test('live launcher requires explicit config and credential; example contains references only', {timeout:15000}, async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'live-launch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  execFileSync(process.execPath,['examples/studio-live.mjs',root]);
  const {readFile}=await import('node:fs/promises');
  const file=path.join(root,'instances.json'),text=await readFile(file,'utf8');
  const config=JSON.parse(text);assert.equal(config.instances.length,2);
  assert.equal(config.instances[0].providerConfig.model.credentialRef,'env:DEEPSEEK_API_KEY');
  assert.throws(()=>execFileSync(process.execPath,['examples/studio-live.mjs',root],{stdio:'pipe'}));
  assert.equal(await readFile(file,'utf8'),text);
  for(const explicit of [false,true]) {
    const env={...process.env,DEEPSEEK_API_KEY:'',CONEST_RECONSTRUCT_MODE:'live',CONEST_RECONSTRUCT_STATE:path.join(root,'state'),CONEST_RECONSTRUCT_PORT:'0'};
    if(explicit)env.CONEST_RECONSTRUCT_CONFIG=file;else delete env.CONEST_RECONSTRUCT_CONFIG;
    const child=spawn(process.execPath,['dist/studio/launch.mjs'],{env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);let errors='';child.stderr.on('data',b=>errors+=b);
    const exited=once(child,'exit');
    t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
    const [code]=await exited;assert.notEqual(code,0);assert.doesNotMatch(output,/"ready":true/);
    assert.match(errors,explicit?/CREDENTIAL_UNAVAILABLE/:/INVALID_CONFIG/);
  }
});
