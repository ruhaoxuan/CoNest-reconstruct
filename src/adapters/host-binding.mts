import type { ManagerPort } from '../types.mjs';
import type { DshBindingOptions, DshTurn, HostTurnOptions } from './types.mjs';
import { parseDshResult } from './validation.mjs';
export type { DshBindingOptions, HostTurnOptions, DshRunResult } from './types.mjs';
import { randomUUID } from 'node:crypto';
import { requireCondition } from '../contracts.mjs';
import { createDshProvider } from './dsh.mjs';

/** Neutral trusted host binding for DSH tasks.
 * The caller owns prompt preparation and transcript mapping.
 * One binding is scoped to one instance. No global model-supplied tool registry is used.
 */
export function createDshHostBinding(options: DshBindingOptions) {
  const turns = new Map<string, DshTurn & { subject: string }>();
  const provider = createDshProvider({ ...options,
    resolveTurn(task) {
      const turn = turns.get(task.runId);
      requireCondition(turn && turn.subject === task.subject, 'CALLBACK_EXPIRED', 'Unknown host turn');
      return turn;
    },
  });
  let bound = false;
  return {
    provider,
    bind(manager: ManagerPort, instanceId: string, { subject, permissions = ['host:tools'] }: { subject: string; permissions?: readonly string[] }) {
      requireCondition(!bound, 'INVALID_REQUEST', 'Binding already belongs to an instance'); bound = true;
      return {
        async runHarnessAgent(options: HostTurnOptions) {
          const runId = randomUUID();
          let active = true;
          const turn = { ...options, subject,
            hostTools: (options.hostTools ?? []).map(tool => ({ ...tool, permissions: ['host:tools'] })),
            assertActive() { requireCondition(active, 'CALLBACK_EXPIRED', 'Host turn ended'); options.signal?.throwIfAborted(); },
          };
          turns.set(runId, turn);
          try {
            const result = await manager.run(instanceId, { runId, subject, permissions,
              input: options.task, timeoutMs: options.timeoutMs }, { signal: options.signal });
            return parseDshResult(result.output);
          } finally { active = false; turns.delete(runId); }
        },
      };
    },
  };
}
