import type { RuntimeClientConstructor } from './types.mjs';
import { record } from './validation.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireCondition } from '../contracts.mjs';

/** Verify local build provenance before importing the pinned upstream transport. */
export async function loadPinnedClient(root: string): Promise<RuntimeClientConstructor> {
  const lock = record(JSON.parse(await readFile(new URL('../../runtime.lock.json', import.meta.url), 'utf8')));
  const seal = record(JSON.parse(await readFile(path.join(root, 'reconstruct-runtime.json'), 'utf8')));
  requireCondition(seal.commit === lock.commit && seal.sdkArchiveSha256 === lock.sdkArchiveSha256,
    'RUNTIME_MISMATCH', 'Runtime provenance does not match runtime.lock.json');
  requireCondition(seal.files && typeof seal.files === 'object' && !Array.isArray(seal.files),
    'RUNTIME_MISMATCH', 'Runtime file seal is missing');
  const files = record(seal.files);
  if (seal.overlay) {
    const expected = await readFile(new URL('../../overlay-config.lock.json', import.meta.url), 'utf8');
    requireCondition(JSON.stringify(seal.overlay) === JSON.stringify(JSON.parse(expected)), 'RUNTIME_MISMATCH', 'Research overlay lock mismatch');
  }
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  for (const [file, expected] of Object.entries(files)) {
    requireCondition(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'RUNTIME_MISMATCH', 'Unsafe sealed path');
    requireCondition(sha(await readFile(path.join(root, file))) === expected, 'RUNTIME_MISMATCH', `Runtime drift: ${file}`);
  }
  requireCondition(files['scripts/maintenance/sdk.lock.json'] === lock.sdkLockSha256 &&
    files['pnpm-lock.yaml'] === lock.pnpmLockSha256 && files['dist/client.js'] && files['dist/worker.js'],
    'RUNTIME_MISMATCH', 'Runtime seal is incomplete or dependency locks differ');
  const module = record(await import(pathToFileURL(path.join(root, 'dist/client.js')).href));
  requireCondition(typeof module.BridgeClient === 'function', 'RUNTIME_MISMATCH', 'Missing runtime constructor');
  // Dynamic import has no compile-time module path. The pin/seal and constructor
  // check guard this explicit interop assertion; RPC payloads remain unknown.
  return module.BridgeClient as RuntimeClientConstructor;
}
