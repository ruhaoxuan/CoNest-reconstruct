import path from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requireCondition } from '../contracts.mjs';
import { createTestProvider } from '../testing.mjs';
import type { ResolvedConfig } from '../config.mjs';
import type { StudioProvider } from '../studio/application.mjs';
import { createDshProvider } from './dsh.mjs';
import type { DshConfig } from './types.mjs';

/** Resolve existing ancestors too: nonexistent storage paths may sit under symlinks. */
function storageRoot(file: string): string {
  try { return realpathSync(file); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(storageRoot(parent), path.basename(file));
  }
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export function createProofStudioProviders(runtimeRoot: string): readonly StudioProvider[] {
  const validateInput = (input: string) => {
    const value = input.trim();
    requireCondition(['PROOF:BASH:', 'PROOF:BASH:WAIT', 'PROOF:IMAGE:'].includes(value),
      'INVALID_REQUEST', 'Use a supported proof preset');
    return value;
  };
  const dsh = createDshProvider({ runtimeRoot, proofMode: true, resolveTurn(task) {
    const input = validateInput(task.input), session = randomUUID();
    return { sessionKey: session, hostSessionId: session, hostAgentId: task.instanceId,
      hostLifecycleRevision: task.generation, provider: 'bridge-proof', model: 'test',
      assertActive() {}, hostTools: [{ name: 'bash', permissions: ['host:tools'],
        description: 'Synthetic callback; no shell execution', parameters: { type: 'object' },
        async execute(_, __, signal) {
          signal.throwIfAborted();
          if (input.endsWith('WAIT')) await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 10000);
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
          });
          signal.throwIfAborted(); return { content: [{ type: 'text', text: 'RECONSTRUCT_STUDIO_CALLBACK_OK' }] };
        },
      }] };
  } });
  return [
    { provider: dsh, permissions: ['host:tools'], validateInput,
      validateInstances(instances) {
        validateDshStorage(instances);
        requireCondition(instances.every(i => !(i.spec.config as DshConfig).model), 'INVALID_CONFIG', 'Model routes require explicit live mode');
      },
    },
    { provider: { ...createTestProvider(), configContract: { version: 1, fields: [] } },
      permissions: [], validateInput: input => input },
  ];
}

export function validateDshStorage(instances: readonly ResolvedConfig[], isolateWorkspaces = false): void {
        const roots: string[] = [];
        for (const instance of instances) {
          const root = storageRoot((instance.spec.config as DshConfig).sessionPersistenceRoot);
          requireCondition(!roots.some(other => contains(root, other) || contains(other, root)),
            'INVALID_CONFIG', 'DSH instances require separate, non-overlapping session storage roots');
          roots.push(root);
        }
        if (isolateWorkspaces) {
          const workspaces: string[] = [];
          for (const instance of instances) {
            const workspace = storageRoot((instance.spec.config as DshConfig).workspaceRoot);
            requireCondition(![...roots, ...workspaces].some(other => contains(workspace, other) || contains(other, workspace)),
              'INVALID_CONFIG', 'Live workspaces must not overlap each other or session storage');
            workspaces.push(workspace);
          }
        }
}
