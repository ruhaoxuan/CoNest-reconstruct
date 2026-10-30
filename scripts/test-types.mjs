import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const tsc = ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'];
const good = spawnSync(process.execPath, tsc, { encoding: 'utf8' });
assert.equal(good.status, 0, good.stdout + good.stderr);
// Prove that the compiler is rejecting the invalid contracts, rather than only
// checking that a file containing @ts-expect-error comments happens to compile.
const fixture = `test/types/negative-probe-${process.pid}.mts`;
try {
  const source = await readFile('test/types/contracts.mts', 'utf8');
  await writeFile(fixture, source.replaceAll('@ts-expect-error', 'negative contract probe'));
  const bad = spawnSync(process.execPath, tsc, { encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  const diagnostics = bad.stdout.split('\n').filter(line => line.includes(`negative-probe-${process.pid}.mts`) && /error TS\d+/.test(line));
  assert.equal(diagnostics.length, 37, bad.stdout + bad.stderr);
  console.log('Type contracts passed; all 37 deliberately invalid contracts were rejected');
} finally { await unlink(fixture); }
