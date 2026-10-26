import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudioApplication, readStudioConfig } from '../dist/studio/application.mjs';
import { createProofStudioProviders } from '../dist/adapters/studio-proof.mjs';
import { createTestProvider } from '../dist/testing.mjs';

const raw = (id, provider = 'test.echo', providerConfig = {}) => ({ id, provider, providerConfigVersion: 1,
  policy: { subjects: ['studio'], allow: [] }, providerConfig });
const document = instances => JSON.stringify({ schemaVersion: 1, instances });
const definitions = () => createProofStudioProviders('/unused-runtime');
const signal = () => new AbortController().signal;
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-config-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('configured third provider needs registration only; instances have independent lifecycles', async t => {
  const third = { provider: { ...createTestProvider('third.custom'), configContract: { version: 1, fields: [] } },
    permissions: [], validateInput: input => input };
  const app = createStudioApplication(document([raw('a'), raw('b', 'third.custom')]), [...definitions(), third]);
  t.after(() => Promise.all(app.manager.list().map(i => app.manager.stop(i.id))));
  assert.deepEqual(app.manager.list().map(i => i.id), ['a', 'b']);
  await app.manager.start('a'); await app.manager.start('b'); await app.manager.stop('a');
  assert.equal(app.manager.snapshot('b').state, 'ready');
  assert.deepEqual(await app.submitTask('b', 'independent', signal()), { text: 'independent' });
  assert(app.manager.configured('b').revision);
});
test('whole-document validation rejects unknown providers, duplicates and bad later entries before startup', () => {
  let started = 0;
  const provider = { provider: { ...createTestProvider('third', { start() { started++; } }), configContract: { version: 1, fields: [] } },
    permissions: [], validateInput: input => input };
  for (const instances of [[raw('a', 'missing')], [raw('a', 'third'), raw('a', 'third')],
    [raw('a', 'third'), raw('b', 'third', { unknown: true })]]) {
    assert.throws(() => createStudioApplication(document(instances), [provider]));
  }
  assert.equal(started, 0);
});
test('configured disabled state, deadlines and subject policy govern Studio admission', async t => {
  const timeout = { ...raw('timeout', 'test.echo', { mode: 'wait', delayMs: 200 }),
    control: { defaultRunTimeoutMs: 10, maxRunTimeoutMs: 10, stopGraceMs: 1000 } };
  const app = createStudioApplication(document([timeout, { ...raw('off'), enabled: false },
    { ...raw('denied'), policy: { subjects: ['other'], allow: [] } }]), definitions());
  t.after(() => Promise.all(app.manager.list().map(i => app.manager.stop(i.id))));
  await assert.rejects(app.manager.start('off'), e => e.code === 'INSTANCE_DISABLED');
  await app.manager.start('denied');
  await assert.rejects(app.submitTask('denied', 'x', signal()), e => e.code === 'SUBJECT_DENIED');
  await app.manager.start('timeout');
  await assert.rejects(app.submitTask('timeout', 'x', signal()), e => e.code === 'RUN_TIMEOUT');
});
test('DSH storage rejects equal, nested and symlink-aliased instance roots before processes exist', async t => {
  const root = await directory(t); await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, 'alias'));
  const dsh = (id, storage) => raw(id, 'dsh', { workspaceRoot: root, sessionPersistenceRoot: storage });
  const a = path.join(root, 'real', 'sessions');
  for (const b of [a, path.join(a, 'child'), path.join(root, 'alias', 'sessions'), path.parse(root).root]) {
    assert.throws(() => createStudioApplication(document([dsh('a', a), dsh('b', b)]), definitions()), /separate/);
  }
  assert.equal(createStudioApplication(document([dsh('a', a), dsh('b', path.join(root, 'separate'))]), definitions()).manager.list().length, 2);
});
test('Studio DSH task adapter enforces required tool permissions and proof input', async t => {
  const root = await directory(t);
  const defs = definitions(); const dsh = defs[0];
  const isolated = { ...dsh, provider: { ...dsh.provider, async createInstance() {
    return { async start() {}, async stop() {}, async run() { throw Error('Admission must reject first'); } };
  } } };
  const app = createStudioApplication(document([raw('dsh', 'dsh', { workspaceRoot: root, sessionPersistenceRoot: path.join(root, 'sessions') })]), [isolated]);
  t.after(() => app.manager.stop('dsh'));
  await app.manager.start('dsh');
  await assert.rejects(app.submitTask('dsh', 'free chat', signal()), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(app.submitTask('dsh', 'PROOF:BASH:', signal()), e => e.code === 'PERMISSION_DENIED');
});
test('config reader is bounded and reports missing files; an empty configured catalog stays empty', async t => {
  const root = await directory(t), file = path.join(root, 'instances.json');
  await writeFile(file, document([]));
  assert.equal(createStudioApplication(await readStudioConfig(file), definitions()).manager.list().length, 0);
  await writeFile(file, ' '.repeat(1048577));
  await assert.rejects(readStudioConfig(file), e => e.code === 'INVALID_CONFIG');
  await assert.rejects(readStudioConfig(path.join(root, 'missing')), e => e.code === 'ENOENT');
});
