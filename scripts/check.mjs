import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (file.endsWith('.mjs') || file.endsWith('.mts')) {
      if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file]);
      if (file.startsWith('src/') && !file.startsWith('src/adapters/'))
        assert.doesNotMatch(await readFile(file, 'utf8'), /(?:from\s*|import\s*\()['"](?:openclaw|@openclaw|@deepseek-ai)/);
    }
  }
}
for (const dir of ['src', 'scripts', 'test', 'examples']) await check(dir);
console.log('Syntax and framework dependency boundary checks passed');
