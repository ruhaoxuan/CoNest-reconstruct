import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { HarnessManager, HarnessRegistry } from '../../dist/index.mjs';
import { createDshProvider } from '../../dist/adapters/dsh.mjs';
import { createDshHostBinding } from '../../dist/adapters/host-binding.mjs';
import { loadPinnedClient } from '../../dist/adapters/pinned-runtime.mjs';

const runtimeRoot = path.resolve('.vendor/dsh-runtime');
async function fixture(t, resolveTurn) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conest-dsh-step2-')));
  let client;
  const Client = await loadPinnedClient(runtimeRoot);
  const provider = createDshProvider({ runtimeRoot, proofMode: true, resolveTurn,
    loadClient: async () => class extends Client { constructor(options) { super(options); client = this; } } });
  const registry = new HarnessRegistry(); registry.register(provider);
  const manager = new HarnessManager(registry);
  manager.create({ id: 'dsh', provider: 'dsh', config: { workspaceRoot: root, sessionPersistenceRoot: path.join(root, 'sessions') },
    policy: { subjects: ['operator'], allow: ['host:tools'] } });
  t.after(async () => { await manager.stop('dsh', { graceMs: 5000 }); await rm(root, { recursive: true, force: true }); });
  await manager.start('dsh');
  return { manager, client: () => client };
}
const turn = overrides => ({ sessionKey: 's', hostSessionId: 'sid', hostAgentId: 'main', hostLifecycleRevision: 'epoch-1',
  provider: 'bridge-proof', model: 'test', assertActive() {}, hostTools: [], ...overrides });
const task = (id, input = 'PROOF:IMAGE:') => ({ runId: id, subject: 'operator', input, permissions: ['host:tools'], timeoutMs: 15_000 });

test('pinned real DSH process executes, reuses sessions and retires older host epochs', { timeout: 60_000 }, async t => {
  let epoch = 'epoch-1';
  const f = await fixture(t, () => turn({ hostLifecycleRevision: epoch }));
  const pid = (await f.client().status()).pid; assert.notEqual(pid, process.pid);
  const first = await f.manager.run('dsh', task('one'));
  assert.match(first.output.finalText, /DSH_IMAGE_INPUT_MISSING/);
  assert.equal(first.output.sessionReused, false);
  assert.equal((await f.manager.run('dsh', task('two'))).output.sessionReused, true);
  epoch = 'epoch-2';
  assert.equal((await f.manager.run('dsh', task('three'))).output.sessionReused, false);
  assert.equal((await f.client().status()).pid, pid);
});
test('real DSH only calls admitted host tools through the existing private callbacks', { timeout: 60_000 }, async t => {
  let calls = 0;
  const f = await fixture(t, () => turn({ hostTools: [{ name: 'bash', description: 'host tool',
    parameters: { type: 'object' }, permissions: ['host:tools'],
    async execute(_, __, signal) { signal.throwIfAborted(); calls++; return { content: [{ type: 'text', text: 'STEP2_CALLBACK_OK' }] }; } }] }));
  const result = await f.manager.run('dsh', task('one', 'PROOF:BASH:'));
  assert.match(result.output.finalText, /STEP2_CALLBACK_OK/); assert.equal(calls, 1);
});
test('cancel reaches real host tool and releases the DSH session without replacing Host', { timeout: 60_000 }, async t => {
  const entered = Promise.withResolvers(); let cancelled = false;
  let blocking = true;
  let epoch = 'epoch-1';
  const f = await fixture(t, () => turn({ hostLifecycleRevision: epoch, hostTools: [{ name: 'bash', description: 'cancelable host tool',
    parameters: { type: 'object' }, permissions: ['host:tools'], async execute(_, __, signal) {
      if (!blocking) return { content: [{ type: 'text', text: 'RECOVERED' }] };
      entered.resolve(); await new Promise((_, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
        if (signal.aborted) { cancelled = true; reject(signal.reason); }
      });
    } }] }));
  const pid = (await f.client().status()).pid;
  const controller = new AbortController();
  const run = f.manager.run('dsh', task('one', 'PROOF:BASH:'), { signal: controller.signal });
  const failed = assert.rejects(run, e => e.code === 'RUN_CANCELLED');
  await entered.promise; controller.abort(); await failed;
  // Join provider settlement, including its session-disposal RPC.
  for (let i = 0; i < 100 && f.manager.snapshot('dsh').activeRuns; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.manager.snapshot('dsh').activeRuns, 0); assert.equal(cancelled, true);
  assert.equal((await f.client().status()).pid, pid);
  // Proof model scans prior tool results. Use a fresh host epoch to test recovery
  // without mistaking that fixture behavior for real-model continuation semantics.
  blocking = false; epoch = 'epoch-2';
  assert.match((await f.manager.run('dsh', task('two', 'PROOF:BASH:'))).output.finalText, /RECOVERED/);
});
test('neutral host binding runs through manager and real DSH with proof model only', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conest-host-facade-')));
  const binding = createDshHostBinding({ runtimeRoot, proofMode: true });
  const registry = new HarnessRegistry(); registry.register(binding.provider);
  const manager = new HarnessManager(registry);
  manager.create({ id: 'facade', provider: 'dsh', config: { workspaceRoot: root, sessionPersistenceRoot: path.join(root, 'sessions') },
    policy: { subjects: ['gateway'], allow: ['host:tools'] } });
  t.after(async () => { await manager.stop('facade'); await rm(root, { recursive: true, force: true }); });
  await manager.start('facade');
  const host = binding.bind(manager, 'facade', { subject: 'gateway' });
  const result = await host.runHarnessAgent({ task: 'PROOF:IMAGE:', sessionKey: 's', hostSessionId: 'sid', hostAgentId: 'main',
    hostLifecycleRevision: 'epoch', provider: 'bridge-proof', model: 'test', timeoutMs: 15_000, hostTools: [] });
  assert.match(result.finalText, /DSH_IMAGE_INPUT_MISSING/);
});
