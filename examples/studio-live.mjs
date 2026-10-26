import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Synthetic workspace data only. This script does not read credentials or call a model.
const root = path.resolve(process.argv[2] ?? '.local/studio-live');
await mkdir(root, { recursive: true, mode: 0o700 });
const file = path.join(root, 'instances.json');
// Reserve the config first, so re-running cannot overwrite any workspace fixture.
const { open } = await import('node:fs/promises');
const handle = await open(file, 'wx', 0o600);
try {
  const instances = [];
  for (const [id, owner, spent] of [['dsh-alpha', '李明', 3500], ['dsh-beta', '王芳', 2800]]) {
    const workspace = path.join(root, id, 'workspace'); await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'project-test.txt'),
      `项目：${id}\n负责人：${owner}\n预算：12000 元\n已支出：${spent} 元\n交付日期：2026-11-15\n风险：采购附件尚未补齐\n`, { flag: 'wx', mode: 0o600 });
    instances.push({ id, provider: 'dsh', providerConfigVersion: 1,
      policy: { subjects: ['studio'], allow: ['workspace:read'] },
      control: { defaultRunTimeoutMs: 60000, maxRunTimeoutMs: 120000, stopGraceMs: 5000 },
      providerConfig: { workspaceRoot: await realpath(workspace), sessionPersistenceRoot: path.join(root, id, 'sessions'),
        model: { name: 'deepseek-v4-flash', credentialRef: 'env:DEEPSEEK_API_KEY' } } });
  }
  await handle.writeFile(JSON.stringify({ schemaVersion: 1, instances }, null, 2) + '\n');
} finally { await handle.close(); }
console.log(file);
