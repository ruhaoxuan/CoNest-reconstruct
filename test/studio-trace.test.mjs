import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { HarnessRegistry, HarnessManager } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
import { startStudio } from '../dist/studio/server.mjs';
import { createEnvironmentCredentials } from '../dist/credentials.mjs';
test('Studio renders live page and bounded correlated tool traces without exposing the credential', async t => {
  const registry = new HarnessRegistry(), manager = new HarnessManager(registry), token = randomUUID();
  const credentials = createEnvironmentCredentials({ DEEPSEEK_API_KEY: 'synthetic-trace-secret' });
  registry.register({ ...createTestProvider('trace'), async createInstance() { return {
    async start() {}, async stop() {}, async run(task, { emit }) {
      for (let i = 0; i < 110; i++) emit({ kind: 'tool', name: 'read_file', callId: 'c-' + i,
        status: 'completed', durationMs: 2, preview: 'synthetic-trace-secret' });
      return { finalText: 'synthetic-trace-secret' };
    },
  }; } });
  manager.create({ id: 'trace', provider: 'trace', policy: { subjects: ['studio'] } }); await manager.start('trace');
  const studio = await startStudio({ manager, token, mode: 'live', port: 0, redact: credentials.redact,
    async submitTask(id, input, signal, onEvent) { return (await manager.run(id, {runId:'trace-run',subject:'studio',input},{signal,onEvent})).output; } });
  t.after(() => studio.close());
  const html = await (await fetch(studio.url)).text(); assert.match(html, /LIVE 任务模式/); assert.match(html, /执行轨迹/);
  new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  assert.doesNotMatch(html, /synthetic-trace-secret/);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const accepted = await fetch(studio.url + '/api/run', {method:'POST',headers,body:JSON.stringify({instanceId:'trace',input:'test'})});
  assert.equal(accepted.status, 202);
  let state;
  for(let i=0;i<50;i++) {
    state = await (await fetch(studio.url+'/api/state',{headers})).json();
    if(state.jobs[0]?.state!=='running') break;
    await new Promise(r=>setTimeout(r,10));
  }
  const job=state.jobs[0]; assert.equal(job.state,'completed'); assert.equal(job.events.length,100); assert(job.droppedEvents>0);
  assert.equal(job.events[0].runId,'trace-run'); assert.equal(job.events.at(-1).type,'run.completed');
  assert.equal(job.text,'[REDACTED]'); assert.doesNotMatch(JSON.stringify(state),/synthetic-trace-secret/);
});
