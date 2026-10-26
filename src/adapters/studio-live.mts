import { randomUUID } from 'node:crypto';
import { guardCredentialInstance } from '../credentials.mjs';
import type { CredentialService } from '../credentials.mjs';
import { HarnessError, requireCondition } from '../contracts.mjs';
import { WORKSPACE_PLUGINS } from './dsh-config.mjs';
import { ToolPluginRegistry } from '../tool-plugins.mjs';
import { createWorkspaceTools, WORKSPACE_TOOL_SCHEMAS } from '../workspace-tools.mjs';
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
  const plugins=new ToolPluginRegistry<readonly Awaited<ReturnType<typeof createWorkspaceTools>>[number][],Awaited<ReturnType<typeof createWorkspaceTools>>[number]>();
  WORKSPACE_PLUGINS.forEach((id,index)=>{const schema=WORKSPACE_TOOL_SCHEMAS[index]!;plugins.register({id,version:'1.0.0',tools:[{...schema,permissions:['workspace:read']}],async create(tools){return tools.filter(tool=>tool.name===schema.name);}});});
  const selected=(config:DshConfig)=>config.composition?.plugins??WORKSPACE_PLUGINS;
  const leases=new Map<string,string>();
  const dsh = createDshProvider({ runtimeRoot, loadClient: testing.loadClient, redact: text => credentials.redact(text),
    resolveModelRoute(config) {
      requireCondition(config.model, 'INVALID_CONFIG', 'Live DSH requires model configuration');
      const apiKey=credentials.resolve(config.model.credentialRef);leases.set(config.sessionPersistenceRoot,apiKey);
      return { apiKey, baseURL: testing.baseURL ?? 'https://api.deepseek.com' };
    },
    async resolveTurn(task, config) {
      requireCondition(config.model, 'INVALID_CONFIG', 'Live DSH requires model configuration');
      const session = randomUUID();
      const tools = await plugins.create(selected(config),await createWorkspaceTools(config.workspaceRoot));
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
  const provider={...dsh,async createInstance(config:DshConfig,context?:{readonly signal:AbortSignal}){const instance=await dsh.createInstance(config,context);return guardCredentialInstance(instance,credentials,config.model!.credentialRef,leases.get(config.sessionPersistenceRoot)!);},toolSurface(config:DshConfig){return plugins.publication(selected(config)).tools;}};
  return [
    { provider, permissions: ['workspace:read'], permissionsFor(config){return selected(config as DshConfig).length?['workspace:read']:[];}, validateInput(input) {
      requireCondition(input.trim().length > 0, 'INVALID_REQUEST', 'Enter a task'); return credentials.redact(input);
    }, validateInstances(instances) {
      validateDshStorage(instances, true);
      for (const instance of instances) {
        const config = instance.spec.config as DshConfig;
        requireCondition(config.model && ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(config.model.name),
          'INVALID_CONFIG', 'Use a text model declared by the pinned runtime');
        // Early local check only; this never makes a model/network request.
        try{credentials.resolve(config.model.credentialRef);}catch(error){if(!(error instanceof HarnessError&&error.code==='CREDENTIAL_REVOKED'))throw error;}
      }
    } },
    { provider: createTestProvider(),
      permissions: [], validateInput: input => input },
  ];
}
