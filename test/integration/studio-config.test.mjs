import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-launch-config-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function launch(t, root, config) {
  const child = spawn(process.execPath, ['dist/studio/launch.mjs'], { env: { ...process.env,
    CONEST_RECONSTRUCT_STATE: root, CONEST_RECONSTRUCT_PORT: '0',
    ...(config ? { CONEST_RECONSTRUCT_CONFIG: config } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = ''; child.stderr.on('data', b => stderr += b); child.stdout.on('data', b => stdout += b);
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM'); await Promise.race([exited, pause(6000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });
  return { child, exited, diagnostics: () => stderr, output: () => stdout };
}
async function ready(root, process) {
  for (let i = 0; i < 150; i++) {
    // Read stdout readiness too, so stale connection files cannot count as a new server.
    if (process.output().includes('"ready":true')) return JSON.parse(await readFile(path.join(root, 'connection.json'), 'utf8'));
    if (process.child.exitCode !== null) throw Error(process.diagnostics());
    await pause(50);
  }
  throw Error('Studio readiness timeout');
}
function client(connection) {
  const api = async (route, data) => {
    const response = await fetch(connection.url + '/api/' + route, { method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  return { api, async done(id) {
    for (let i = 0; i < 300; i++) {
      const job = (await api('state')).jobs.find(j => j.id === id);
      if (job && job.state !== 'running') return job;
      await pause(50);
    }
    throw Error('Job timeout');
  } };
}
test('external config starts two real DSH instances and a third provider; stopping A preserves B', { timeout: 60000 }, async t => {
  const root = await directory(t), file = path.join(root, 'instances.json');
  execFileSync(globalThis.process.execPath, ['examples/studio-config.mjs', root]);
  const text = await readFile(file, 'utf8');
  assert.throws(() => execFileSync(globalThis.process.execPath, ['examples/studio-config.mjs', root], { stdio: 'pipe' }));
  const process = launch(t, root, file), connection = await ready(root, process);
  const { api, done } = client(connection);
  assert.deepEqual((await api('state')).instances.map(i => i.id), ['dsh-alpha', 'dsh-beta', 'local-echo']);
  for (const id of ['dsh-alpha', 'dsh-beta', 'local-echo']) await api('start', { instanceId: id });
  const waiting = await api('run', { instanceId: 'dsh-alpha', input: 'PROOF:BASH:WAIT' });
  await pause(500);
  const beta = await api('run', { instanceId: 'dsh-beta', input: 'PROOF:BASH:' });
  await api('stop', { instanceId: 'dsh-alpha' });
  assert.equal((await done(waiting.jobId)).state, 'cancelled');
  const result = await done(beta.jobId);
  assert.equal(result.state, 'completed'); assert.match(result.text, /RECONSTRUCT_STUDIO_CALLBACK_OK/);
  const echo = await api('run', { instanceId: 'local-echo', input: 'third provider from configuration' });
  assert.match((await done(echo.jobId)).text, /third provider from configuration/);
  const states = (await api('state')).instances;
  assert.equal(states.find(i => i.id === 'dsh-alpha').activeRuns, 0);
  assert.equal(states.find(i => i.id === 'dsh-beta').state, 'ready');
  assert.equal(await readFile(file, 'utf8'), text);
  process.child.kill('SIGTERM'); assert.equal((await process.exited)[0], 0, process.diagnostics());
});
test('default config is created once and edited catalog is used on restart', { timeout: 20000 }, async t => {
  const root = await directory(t), file = path.join(root, 'instances.json');
  const first = launch(t, root); await ready(root, first);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).instances[0].id, 'dsh-demo');
  first.child.kill('SIGTERM'); assert.equal((await first.exited)[0], 0);
  const changed = JSON.stringify({ schemaVersion: 1, instances: [{ id: 'replacement', provider: 'test.echo',
    providerConfigVersion: 1, policy: { subjects: ['studio'] }, providerConfig: {} }] });
  await writeFile(file, changed);
  const second = launch(t, root), { api } = client(await ready(root, second));
  assert.deepEqual((await api('state')).instances.map(i => i.id), ['replacement']);
  assert.equal(await readFile(file, 'utf8'), changed);
  second.child.kill('SIGTERM'); assert.equal((await second.exited)[0], 0);
});
test('invalid or missing explicit config fails without fallback or readiness', { timeout: 15000 }, async t => {
  const root = await directory(t), file = path.join(root, 'bad.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, instances: [{ id: 'bad', provider: 'unregistered', providerConfigVersion: 1, policy: {}, providerConfig: {} }] }));
  for (const config of [file, path.join(root, 'missing.json')]) {
    const process = launch(t, root, config);
    assert.notEqual((await process.exited)[0], 0);
    assert.doesNotMatch(process.output(), /"ready":true/);
    await assert.rejects(readFile(path.join(root, 'connection.json')), e => e.code === 'ENOENT');
  }
});
