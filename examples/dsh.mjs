import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessManager, HarnessRegistry } from '../dist/index.mjs';
import { createDshHostBinding } from '../dist/adapters/host-binding.mjs';
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conest-dsh-demo-')));
const registry = new HarnessRegistry();
const binding = createDshHostBinding({ runtimeRoot: path.resolve('.vendor/dsh-runtime'), proofMode: true });
registry.register(binding.provider);
const manager = new HarnessManager(registry);
manager.create({ id: 'dsh-proof', provider: 'dsh', config: { workspaceRoot: root, sessionPersistenceRoot: path.join(root, 'sessions') },
  policy: { subjects: ['demo'], allow: ['host:tools'] } });
try {
  await manager.start('dsh-proof');
  const host = binding.bind(manager, 'dsh-proof', { subject: 'demo' });
  const result = await host.runHarnessAgent({ task: 'PROOF:BASH:', sessionKey: 'demo', hostSessionId: 'session',
    hostAgentId: 'main', hostLifecycleRevision: 'epoch-1', provider: 'bridge-proof', model: 'test', timeoutMs: 15_000,
    hostTools: [{ name: 'bash', description: 'Deterministic host tool callback; does not execute a shell', parameters: { type: 'object' },
      execute: async () => ({ content: [{ type: 'text', text: 'REAL_DSH_HOST_CALLBACK_OK' }] }) }] });
  console.log(JSON.stringify({ mode: 'proof', paidModelCalls: 0, finalText: result.finalText, sessionReused: result.sessionReused }));
} finally { await manager.stop('dsh-proof', { graceMs: 5000 }); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify(manager.snapshot('dsh-proof')));
