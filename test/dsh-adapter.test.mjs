import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDshProvider } from '../dist/adapters/dsh.mjs';
import { createDshHostBinding } from '../dist/adapters/host-binding.mjs';
import { HarnessRegistry, HarnessManager } from '../dist/index.mjs';
import { parseDshResult } from '../dist/adapters/validation.mjs';
const response = text => ({ sessionId: 's', provider: 'bridge-proof', model: 'test', finalText: text,
  finalContent: [{ type: 'text', text }], finalMediaUrls: [], turnReason: null,
  toolCalls: [], toolResults: [], eventCount: 0, modelIterations: 1, sessionReused: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });

async function fixture(t, { tools = [], authority = () => {}, execute, redact, turnOverrides = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-adapter-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let retained;
  class Client {
    async start() {} async stop() {}
    async extension(call) {
      if (call.operation !== 'runHarnessAgent') return {};
      retained = call;
      return execute ? execute(call) : { finalText: 'ok' };
    }
  }
  const provider = createDshProvider({ runtimeRoot: root, proofMode: true, redact, loadClient: async () => Client,
    resolveTurn: () => ({ sessionKey: 's', hostSessionId: 'session', hostAgentId: 'main', hostLifecycleRevision: 'epoch-1',
      provider: 'bridge-proof', model: 'test', hostTools: tools, assertActive: authority, ...turnOverrides }) });
  const registry = new HarnessRegistry(); registry.register(provider);
  const manager = new HarnessManager(registry);
  manager.create({ id: 'dsh', provider: 'dsh', config: { workspaceRoot: root, sessionPersistenceRoot: path.join(root, 'sessions') },
    policy: { subjects: ['alice', 'bob'], allow: ['read'] } });
  await manager.start('dsh'); t.after(() => manager.stop('dsh'));
  return { manager, provider, retained: () => retained };
}
const request = { runId: 'one', subject: 'alice', permissions: ['read'], input: 'hello' };
const tool = { name: 'read', description: 'test', parameters: { type: 'object' }, permissions: ['read'], execute: async () => ({ text: 'safe' }) };

test('DSH rejects unsupported config and missing external session epoch', async t => {
  const f = await fixture(t, { turnOverrides: { hostLifecycleRevision: undefined } });
  assert.throws(() => f.provider.validateConfig({ workspaceRoot: '/tmp', sessionPersistenceRoot: '/tmp/session', apiKey: 'forbidden' }));
  await assert.rejects(f.manager.run('dsh', request));
});
test('only finalized tools reach DSH and retained callbacks expire after completion', async t => {
  const f = await fixture(t, { tools: [tool], execute: async call => {
    assert.deepEqual(call.args.hostTools.map(t => t.name), ['read']);
    const result = await call.callbacks.tool({ name: 'read', callId: 'c', args: {} }, new AbortController().signal);
    assert.equal(result.text, 'safe'); return { finalText: 'ok' };
  } });
  await f.manager.run('dsh', request);
  await assert.rejects(f.retained().callbacks.tool({ name: 'read' }, new AbortController().signal), e => e.code === 'CALLBACK_EXPIRED');
});
test('tool permission outside the admitted ceiling never enters the executor', async t => {
  let calls = 0;
  const f = await fixture(t, { tools: [{ ...tool, permissions: ['write'], execute: () => calls++ }] });
  await assert.rejects(f.manager.run('dsh', request)); assert.equal(calls, 0);
});
test('authority revocation after tool execution rejects the result', async t => {
  let active = true;
  const f = await fixture(t, { authority: () => { assert(active, 'revoked'); }, tools: [{ ...tool, execute() { active = false; return {}; } }],
    execute: call => call.callbacks.tool({ name: 'read', callId: 'c', args: {} }, new AbortController().signal) });
  await assert.rejects(f.manager.run('dsh', request));
});
test('an absent tool and a foreign subject session are rejected', async t => {
  const f = await fixture(t);
  await f.manager.run('dsh', request);
  await assert.rejects(f.retained().callbacks.tool({ name: 'shell' }, new AbortController().signal));
  await assert.rejects(f.manager.run('dsh', { ...request, runId: 'two', subject: 'bob' }));
});
test('neutral host binding forwards task, permissions and caller signal', async () => {
  const controller = new AbortController();
  const binding = createDshHostBinding({ runtimeRoot: '/tmp', loadClient: async () => class {} });
  const host = binding.bind({ async run(id, task, options) {
    assert.equal(id, 'instance'); assert.equal(task.subject, 'alice');
    assert.deepEqual(task.permissions, ['host:tools']); assert.equal(options.signal, controller.signal);
    return { output: response(task.input) };
  } }, 'instance', { subject: 'alice' });
  assert.equal((await host.runHarnessAgent({ task: 'kept', timeoutMs: 1000, hostTools: [], signal: controller.signal })).finalText, 'kept');
  assert.throws(() => binding.bind({}, 'another', { subject: 'alice' }));
});
test('untyped RPC results are validated instead of trusted as TypeScript declarations', () => {
  assert.equal(parseDshResult(response('ok')).finalText, 'ok');
  assert.throws(() => parseDshResult({ finalText: 'incomplete' }), e => e.code === 'INVALID_RESPONSE');
  assert.throws(() => parseDshResult({ ...response('bad'), toolCalls: [{ name: 'missing-call-id' }] }), e => e.code === 'INVALID_RESPONSE');
  const bad = response('bad'); bad.usage.inputTokens = NaN;
  assert.throws(() => parseDshResult(bad), e => e.code === 'INVALID_RESPONSE');
});

test('tool trace previews redact credentials before truncation and preserve correlated terminal status', async t=>{
  const secret='synthetic-boundary-secret',events=[];
  const f=await fixture(t,{tools:[{...tool,execute:async()=>({text:'x'.repeat(1980)+secret})}],redact:text=>text.replaceAll(secret,'[REDACTED]'),
    execute:async call=>{await call.callbacks.tool({name:'read',callId:'trace-call',args:{}},new AbortController().signal);return {finalText:'ok'};}});
  await f.manager.run('dsh',request,{onEvent:event=>events.push(event)});
  const progress=events.filter(e=>e.type==='provider.progress'&&e.data.kind==='tool');
  assert.equal(progress.length,2);assert.equal(progress[0].data.status,'running');assert.equal(progress[1].data.status,'completed');
  assert.equal(progress[1].runId,request.runId);assert.equal(typeof progress[1].data.durationMs,'number');
  assert.doesNotMatch(progress[1].data.preview,/synthetic/);
});
