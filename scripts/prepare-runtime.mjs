import { mkdir, readFile, writeFile, mkdtemp, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const lock = JSON.parse(await readFile('runtime.lock.json', 'utf8'));
const source = process.argv[2];
assert(source, 'Usage: node scripts/prepare-runtime.mjs /path/to/pinned/CoNest');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['-C', path.resolve(source), ...args]);
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), lock.commit, 'Checkout must match pinned commit');
assert.equal(git(['diff', 'HEAD', '--name-only']).toString().trim(), '', 'Tracked checkout changes must be reviewed separately');
const root = path.resolve('.vendor/conest');
await mkdir('.vendor', { recursive: true });
try { await lstat(root); throw Error('Runtime destination exists; choose a clean checkout instead of overwriting it'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// Export only committed bytes, never .local, node_modules or another checkout's SDK.
const tmp = await mkdtemp(path.join(os.tmpdir(), 'conest-export-'));
const archive = path.join(tmp, 'source.tar');
git(['archive', lock.commit, '-o', archive]);
await mkdir(root);
execFileSync('tar', ['-xf', archive, '-C', root]);
assert.equal(sha(await readFile(path.join(root, 'scripts/maintenance/sdk.lock.json'))), lock.sdkLockSha256);
assert.equal(sha(await readFile(path.join(root, 'pnpm-lock.yaml'))), lock.pnpmLockSha256);
const sdkLock = JSON.parse(await readFile(path.join(root, 'scripts/maintenance/sdk.lock.json'), 'utf8'));
assert.equal(sdkLock.sha256, lock.sdkArchiveSha256);
assert.equal(execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(), '11.7.0');
execFileSync(process.execPath, ['scripts/maintenance/bootstrap.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' });
execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
// Seal source/runtime outputs against accidental drift. Installed transitive modules remain
// governed by frozen pnpm installation; this seal is not an adversarial supply-chain sandbox.
const files = {};
async function walk(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else { assert(!entry.isSymbolicLink()); files[name] = sha(await readFile(path.join(root, name))); }
  }
}
await walk('dist');
for (const name of ['package.json', 'pnpm-lock.yaml', 'scripts/maintenance/sdk.lock.json']) files[name] = sha(await readFile(path.join(root, name)));
await writeFile(path.join(root, 'reconstruct-runtime.json'), JSON.stringify({ commit: lock.commit,
  sdkArchiveSha256: lock.sdkArchiveSha256, files }, null, 2) + '\n');
console.log(`Prepared isolated pinned runtime: ${root}`);
