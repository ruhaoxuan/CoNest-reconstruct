import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Creates an isolated proof-only example; refuses to replace an edited config.
const root = path.resolve(process.argv[2] ?? '.local/studio-multi');
await mkdir(root, { recursive: true, mode: 0o700 });
const instances = [];
for (const id of ['dsh-alpha', 'dsh-beta']) {
  const workspace = path.join(root, id, 'workspace');
  await mkdir(workspace, { recursive: true });
  instances.push({ id, provider: 'dsh', providerConfigVersion: 1,
    policy: { subjects: ['studio'], allow: ['host:tools'] },
    control: { defaultRunTimeoutMs: 15000, maxRunTimeoutMs: 300000, stopGraceMs: 5000 },
    providerConfig: { workspaceRoot: await realpath(workspace), sessionPersistenceRoot: path.join(root, id, 'sessions'),
      execution: { maxParallelToolCalls: 4 } } });
}
instances.push({ id: 'local-echo', provider: 'test.echo', providerConfigVersion: 1,
  policy: { subjects: ['studio'], allow: [] }, providerConfig: { mode: 'echo' } });
const file = path.join(root, 'instances.json');
await writeFile(file, JSON.stringify({ schemaVersion: 1, instances }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(file);
