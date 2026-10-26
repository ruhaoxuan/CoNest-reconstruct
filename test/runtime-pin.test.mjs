import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadPinnedClient } from '../dist/adapters/pinned-runtime.mjs';
test('runtime from another source revision is rejected before import', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'reconstruct-runtime.json'), JSON.stringify({ commit: 'unreviewed' }));
  await assert.rejects(loadPinnedClient(root), e => e.code === 'RUNTIME_MISMATCH');
});
