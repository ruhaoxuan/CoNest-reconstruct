import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceTools } from '../dist/workspace-tools.mjs';

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'workspace-tools-')), root = path.join(parent, 'workspace');
  await mkdir(root); t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(path.join(root, 'project.txt'), 'Owner: Li\nBudget: 8500\nRisk: attachment missing\n');
  const tools = await createWorkspaceTools(root);
  return { root, parent, async run(name, args, signal = new AbortController().signal) {
    const output = await tools.find(t => t.name === name).execute('test', args, signal);
    return JSON.parse(output.content[0].text);
  } };
}
test('read-only workspace tools read real files, list and literal-search with line sources', async t => {
  const f = await fixture(t);
  assert.match((await f.run('read_file', { path: 'project.txt' })).text, /8500/);
  assert.deepEqual((await f.run('list_files', {})).entries, [{ path: 'project.txt', type: 'file' }]);
  const result = await f.run('search_text', { query: 'Budget:' });
  assert.deepEqual(result.matches, [{ path: 'project.txt', line: 2, text: 'Budget: 8500' }]);
  assert.equal((await f.run('search_text', { query: '.*' })).matches.length, 0);
});
test('parent/absolute paths, hidden directories, env files and symlinks cannot expose outside data', async t => {
  const f = await fixture(t); await writeFile(path.join(f.parent, 'outside.txt'), 'OUTSIDE_SECRET');
  await mkdir(path.join(f.root, '.local')); await writeFile(path.join(f.root, '.local', 'secret'), 'PRIVATE');
  await writeFile(path.join(f.root, 'deepseek.env'), 'CREDENTIAL');
  await symlink(path.join(f.parent, 'outside.txt'), path.join(f.root, 'linked.txt'));
  await symlink(f.parent, path.join(f.root, 'linked-dir'));
  for (const file of ['../outside.txt', path.join(f.parent, 'outside.txt'), '.local/secret', 'deepseek.env', 'linked.txt', 'linked-dir/outside.txt']) {
    await assert.rejects(f.run('read_file', { path: file }), e => e.code === 'PATH_DENIED' && !e.message.includes(f.parent));
  }
  assert.deepEqual((await f.run('list_files', { recursive: true })).entries, [{ path: 'project.txt', type: 'file' }]);
  assert.equal((await f.run('search_text', { query: 'SECRET' })).matches.length, 0);
});
test('large and binary files are rejected, search reports skipped files and results are bounded', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'big.txt'), 'x'.repeat(65537));
  await writeFile(path.join(f.root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(f.run('read_file', { path: 'big.txt' }), e => e.code === 'FILE_TOO_LARGE');
  await assert.rejects(f.run('read_file', { path: 'binary' }), e => e.code === 'BINARY_FILE_DENIED');
  assert.equal((await f.run('search_text', { query: 'Budget' })).skipped, 2);
  await writeFile(path.join(f.root, 'many.txt'), 'match\n'.repeat(150));
  const result = await f.run('search_text', { query: 'match' });
  assert.equal(result.matches.length, 100); assert.equal(result.truncated, true);
});
test('cancelled tools do not return results; invalid arguments and directories are rejected', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.run('read_file', { path: 'project.txt' }, controller.signal));
  await assert.rejects(f.run('read_file', { path: '.' }), e => e.code === 'FILE_TYPE_DENIED');
  await assert.rejects(f.run('list_files', { recursive: 'yes' }), e => e.code === 'INVALID_TOOL_ARGUMENT');
  await assert.rejects(f.run('search_text', { query: '' }), e => e.code === 'INVALID_TOOL_ARGUMENT');
  await assert.rejects(f.run('read_file', { path: 'project.txt', command: 'ignored' }), e => e.code === 'INVALID_TOOL_ARGUMENT');
});
