import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('built standalone exports execute without source imports or external packages', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const output = execFileSync(process.execPath, ['examples/demo.mjs'], { encoding: 'utf8' });
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.at(-1).state, 'stopped');
  assert(lines.some(line => line.output?.text === 'CoNest managed task'));
});
