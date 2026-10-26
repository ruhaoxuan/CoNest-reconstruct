import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessRegistry, HarnessManager } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const code = expected => e => e.code === expected;
function fixture(config = {}, hooks = {}, enabled = true) {
  const registry = new HarnessRegistry(); registry.register(createTestProvider('test.echo', hooks));
  const manager = new HarnessManager(registry);
  manager.create({ id: 'a', provider: 'test.echo', config, enabled,
    policy: { subjects: ['alice'], allow: ['read', 'write'], deny: ['write'] } });
  return { manager, registry };
}
const task = (runId = 'one') => ({ runId, subject: 'alice', permissions: ['read'], input: 'hello' });

test('protocol, duplicate providers and unknown configuration are rejected before starting', () => {
  const { registry, manager } = fixture();
  assert.throws(() => registry.register(createTestProvider()), code('PROVIDER_EXISTS'));
  assert.throws(() => registry.register({ ...createTestProvider('bad'), protocolVersion: 99 }), code('PROTOCOL_MISMATCH'));
  assert.throws(() => manager.create({ id: 'b', provider: 'test.echo', config: { secret: 'x' } }), code('INVALID_CONFIG'));
  assert.throws(() => manager.create({ id: 'b', provider: 'unknown' }), code('PROVIDER_NOT_FOUND'));
});
test('third provider works by registration without manager dispatch branches', async () => {
  const { manager, registry } = fixture();
  registry.register(createTestProvider('another')); registry.register(createTestProvider('third'));
  manager.create({ id: 'c', provider: 'third', policy: { subjects: ['alice'], allow: ['read'] } });
  await manager.start('c');
  assert.equal((await manager.run('c', task())).output.text, 'hello');
  await manager.stop('c');
  assert.equal(registry.list().length, 3);
});
test('concurrent starts and stop requests serialize and release only once', async () => {
  let starts = 0, stops = 0;
  const { manager } = fixture({}, { start: () => starts++, stop: () => stops++ });
  await Promise.all([manager.start('a'), manager.start('a'), manager.stop('a')]);
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(manager.snapshot('a').state, 'stopped');
  await manager.start('a'); await manager.stop('a');
  assert.equal(starts, 2); assert.equal(stops, 2);
});
test('disable blocks tasks and starting until explicitly enabled', async () => {
  const { manager } = fixture({}, {}, false);
  await assert.rejects(manager.start('a'), code('INSTANCE_DISABLED'));
  await assert.rejects(manager.run('a', task()), code('INSTANCE_NOT_READY'));
  await manager.enable('a'); await manager.start('a'); await manager.disable('a');
  assert.equal(manager.snapshot('a').state, 'disabled');
});
test('failed startup rolls back provider resources and can be retried', async () => {
  let starts = 0, stops = 0;
  const { manager } = fixture({}, { start: () => { if (++starts === 1) throw new Error('fail once'); }, stop: () => stops++ });
  await assert.rejects(manager.start('a'), code('START_FAILED'));
  assert.equal(stops, 1); assert.equal(manager.snapshot('a').state, 'failed');
  await manager.start('a'); await manager.stop('a'); assert.equal(stops, 2);
});
test('failed startup cleanup retains ownership and prevents a second instance', async () => {
  let cleanup = 0;
  const { manager } = fixture({ failStart: true }, { stop: () => { if (++cleanup === 1) throw new Error('cleanup'); } });
  await assert.rejects(manager.start('a'), code('START_CLEANUP_FAILED'));
  await assert.rejects(manager.start('a'), code('INSTANCE_BUSY'));
  await manager.stop('a'); assert.equal(manager.snapshot('a').state, 'stopped');
});
test('subject allowlist, permission ceiling and deny take effect before execution', async () => {
  let calls = 0;
  const { manager } = fixture({}, { run: () => calls++ }); await manager.start('a');
  await assert.rejects(manager.run('a', { ...task(), subject: 'bob' }), code('SUBJECT_DENIED'));
  await assert.rejects(manager.run('a', { ...task(), permissions: ['write'] }), code('PERMISSION_DENIED'));
  await assert.rejects(manager.run('a', { ...task(), permissions: ['network'] }), code('PERMISSION_DENIED'));
  assert.equal(calls, 0); await manager.stop('a');
});
test('events are correlated, ordered, immutable and observer failures do not fail tasks', async () => {
  const { manager } = fixture(); await manager.start('a'); const events = [];
  await manager.run('a', task(), { onEvent: event => { events.push(event); throw new Error('observer'); } });
  assert.deepEqual(events.map(e => e.type), ['run.started', 'provider.progress', 'run.completed']);
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
  assert(events.every(e => e.instanceId === 'a' && e.runId === 'one' && Object.isFrozen(e)));
  await manager.stop('a');
});
test('admitted configuration and task cannot be changed by later caller mutation', async () => {
  let observed;
  const { manager } = fixture({}, { run: request => { observed = request; } }); await manager.start('a');
  const input = task(); const result = manager.run('a', input); input.permissions.push('write'); input.input = 'changed';
  assert.equal((await result).output.text, 'hello'); assert.deepEqual(observed.permissions, ['read']);
  assert(Object.isFrozen(observed.permissions)); await manager.stop('a');
});
test('cancelled and timed-out tasks settle caller and cooperative work releases', async () => {
  const { manager } = fixture({ mode: 'wait', delayMs: 1000 }); await manager.start('a');
  const controller = new AbortController();
  const running = manager.run('a', task(), { signal: controller.signal });
  const cancelled = assert.rejects(running, code('RUN_CANCELLED'));
  controller.abort(); await cancelled;
  await assert.rejects(manager.run('a', { ...task('two'), timeoutMs: 10 }), code('RUN_TIMEOUT'));
  await manager.stop('a'); assert.equal(manager.snapshot('a').activeRuns, 0);
});
test('duplicate active run is rejected and stop cancels a cooperative run', async () => {
  const { manager } = fixture({ mode: 'wait', delayMs: 1000 }); await manager.start('a');
  const running = manager.run('a', task()); const rejected = assert.rejects(running, code('RUN_CANCELLED'));
  await assert.rejects(manager.run('a', task()), code('DUPLICATE_RUN'));
  await manager.disable('a'); await rejected;
  assert.equal(manager.snapshot('a').state, 'disabled');
});
test('noncooperative work remains tracked; stop timeout never reports successful cleanup', async () => {
  const { manager } = fixture({ mode: 'ignore-cancel', delayMs: 120 }); await manager.start('a');
  await assert.rejects(manager.run('a', { ...task(), timeoutMs: 10 }), code('RUN_TIMEOUT'));
  assert.equal(manager.snapshot('a').activeRuns, 1);
  await assert.rejects(manager.stop('a', { graceMs: 10 }), code('STOP_TIMEOUT'));
  assert.equal(manager.snapshot('a').state, 'failed');
  await assert.rejects(manager.start('a'), code('INSTANCE_BUSY'));
  await sleep(140); await manager.stop('a'); assert.equal(manager.snapshot('a').activeRuns, 0);
});
test('task failure is contained and does not disable the instance', async () => {
  const { manager } = fixture({ mode: 'fail' }); await manager.start('a');
  await assert.rejects(manager.run('a', task()), code('RUN_FAILED'));
  assert.equal(manager.snapshot('a').state, 'ready'); await manager.stop('a');
});
test('a stop request closes admission before its lifecycle queue executes', async () => {
  const { manager } = fixture(); await manager.start('a');
  const stopping = manager.stop('a');
  await assert.rejects(manager.run('a', task()), code('INSTANCE_NOT_READY'));
  await stopping;
});
test('one instance cancelling does not cancel another instance', async () => {
  const { manager } = fixture({ mode: 'wait', delayMs: 100 });
  manager.create({ id: 'b', provider: 'test.echo', policy: { subjects: ['alice'], allow: ['read'] } });
  await manager.start('a'); await manager.start('b');
  const running = manager.run('a', task()); const rejected = assert.rejects(running, code('RUN_CANCELLED'));
  const completed = manager.run('b', task()); await manager.stop('a'); await rejected;
  assert.equal((await completed).state, 'completed'); await manager.stop('b');
});
test('separate generations are assigned across restarts', async () => {
  const { manager } = fixture(); await manager.start('a'); const old = manager.snapshot('a').generation;
  await manager.stop('a'); await manager.start('a');
  assert.notEqual(manager.snapshot('a').generation, old); await manager.stop('a');
});
test('stop requested during async startup waits for startup and then releases resources', async () => {
  let enter, resume, stopped = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const registry = new HarnessRegistry();
  registry.register({ ...createTestProvider(), async createInstance() { return {
    async start() { enter(); await gate; }, async run() {}, async stop() { stopped++; },
  }; } });
  const manager = new HarnessManager(registry);
  manager.create({ id: 'a', provider: 'test.echo' });
  const startup = manager.start('a'); await entered;
  const shutdown = manager.stop('a');
  assert.equal(manager.snapshot('a').state, 'starting'); resume();
  await startup; await shutdown;
  assert.equal(manager.snapshot('a').state, 'stopped'); assert.equal(stopped, 1);
});
test('completed late provider progress is dropped after caller timeout', async () => {
  const registry = new HarnessRegistry();
  registry.register({ ...createTestProvider(), async createInstance() { return {
    async start() {}, async stop() {},
    async run(_, { emit }) { await sleep(40); emit('late'); return 'late'; },
  }; } });
  const manager = new HarnessManager(registry);
  manager.create({ id: 'a', provider: 'test.echo', policy: { subjects: ['alice'], allow: ['read'] } });
  await manager.start('a'); const events = [];
  await assert.rejects(manager.run('a', { ...task(), timeoutMs: 5 }, { onEvent: e => events.push(e) }), code('RUN_TIMEOUT'));
  await sleep(60); assert.deepEqual(events.map(e => e.type), ['run.started', 'run.timed-out']); await manager.stop('a');
});
