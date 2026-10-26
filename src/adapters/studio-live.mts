import { randomUUID } from 'node:crypto';
import type { CredentialService } from '../credentials.mjs';
import { requireCondition } from '../contracts.mjs';
import { createWorkspaceTools } from '../workspace-tools.mjs';
import type { StudioProvider } from '../studio/application.mjs';
import { createTestProvider } from '../testing.mjs';
import { createDshProvider } from './dsh.mjs';
import type { DshConfig, DshProviderOptions } from './types.mjs';
import { validateDshStorage } from './studio-proof.mjs';

/** Transport override and client injection are trusted code seams for offline tests only.
 * The launcher uses the fixed official endpoint; JSON cannot redirect credentials.
 */
export function createLiveStudioProviders(runtimeRoot: string, credentials: CredentialService,
  testing: { baseURL?: string; loadClient?: DshProviderOptions['loadClient'] } = {}): readonly StudioProvider[] {
  const provider = createDshProvider({ runtimeRoot, loadClient: testing.loadClient, redact: text => credentials.redact(text),
    resolveModelRoute(config) {
      requireCondition(config.model, 'INVALID_CONFIG', 'Live DSH requires model configuration');
      return { apiKey: credentials.resolve(config.model.credentialRef), baseURL: testing.baseURL ?? 'https://api.deepseek.com' };
    },
    async resolveTurn(task, config) {
      requireCondition(config.model, 'INVALID_CONFIG', 'Live DSH requires model configuration');
      const session = randomUUID();
      const tools = await createWorkspaceTools(config.workspaceRoot);
      return { sessionKey: session, hostSessionId: session, hostAgentId: task.instanceId,
        hostLifecycleRevision: task.generation, provider: 'deepseek-official', model: config.model.name,
        hostTools: tools.map(tool => ({ ...tool, permissions: ['workspace:read'], async execute(callId, args, signal) {
          const value = await tool.execute(callId, args, signal);
          // Tool responses are JSON-compatible strings/objects. Redact known credentials
          // before either model delivery or event preview, not only at the HTTP boundary.
          const redactValue = (item: unknown): unknown => {
            if (typeof item === 'string') return credentials.redact(item);
            if (Array.isArray(item)) return item.map(redactValue);
            if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, redactValue(v)]));
            return item;
          };
          return redactValue(value);
        } })), assertActive() {} };
    },
  });
  return [
    { provider, permissions: ['workspace:read'], validateInput(input) {
      requireCondition(input.trim().length > 0, 'INVALID_REQUEST', 'Enter a task'); return credentials.redact(input);
    }, validateInstances(instances) {
      validateDshStorage(instances, true);
      for (const instance of instances) {
        const config = instance.spec.config as DshConfig;
        requireCondition(config.model && ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(config.model.name),
          'INVALID_CONFIG', 'Use a text model declared by the pinned runtime');
        // Early local check only; this never makes a model/network request.
        credentials.resolve(config.model.credentialRef);
      }
    } },
    { provider: { ...createTestProvider(), configContract: { version: 1, fields: [] } },
      permissions: [], validateInput: input => input },
  ];
}
