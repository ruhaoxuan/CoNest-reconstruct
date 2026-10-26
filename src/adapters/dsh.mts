import { object, fields } from '../config.mjs';
import type { HarnessProvider, ToolTrace, InstanceFailureCode } from '../types.mjs';
import type { DshProviderOptions, DshConfig, AdmittedHostTool } from './types.mjs';
export type { DshProviderOptions, DshConfig, DshTurn } from './types.mjs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { HarnessError, PROTOCOL_VERSION, requireCondition } from '../contracts.mjs';
import { loadPinnedClient } from './pinned-runtime.mjs';

/** Trusted bridge from a finalized host tool surface to the existing private RPC.
 * resolveTurn must be supplied by the entry adapter, not by model arguments.
 */
export function createDshProvider({ runtimeRoot, resolveTurn, resolveModelRoute, redact = text => text, proofMode = false, loadClient = loadPinnedClient }: DshProviderOptions): HarnessProvider<DshConfig> {
  requireCondition(typeof resolveTurn === 'function', 'INVALID_PROVIDER', 'A trusted turn resolver is required');
  return {
    configContract: { version: 1, fields: [ { path: 'workspaceRoot', scope: 'dsh.workspace', update: 'immutable' }, { path: 'sessionPersistenceRoot', scope: 'dsh.storage', update: 'immutable' }, { path: 'model', scope: 'dsh.model-route', update: 'restart-required' }, { path: 'execution.maxParallelToolCalls', scope: 'dsh.agent-loop', update: 'restart-required' } ] },
    id: 'dsh', version: '0.2.0', protocolVersion: PROTOCOL_VERSION,
    features: { cooperativeCancel: true, processControl: 'owned', resume: true,
      toolGateway: true, externalToolMediation: true },
    validateConfig(raw) {
      requireCondition(raw !== null && typeof raw === "object" && !Array.isArray(raw), "INVALID_CONFIG", "Configuration must be an object");
      const input = raw as Record<string, unknown>;
      requireCondition(raw && typeof raw === 'object' && !Array.isArray(raw) &&
        Object.keys(raw).every(k => ['workspaceRoot', 'sessionPersistenceRoot', 'execution', 'model'].includes(k)),
        'INVALID_CONFIG', 'Unknown DSH instance configuration field');
      requireCondition(typeof input.workspaceRoot === 'string' && path.isAbsolute(input.workspaceRoot),
        'INVALID_CONFIG', 'An absolute existing workspace is required');
      const workspaceRoot = realpathSync(input.workspaceRoot);
      requireCondition(typeof input.sessionPersistenceRoot === 'string' && path.isAbsolute(input.sessionPersistenceRoot),
        'INVALID_CONFIG', 'An explicit absolute session persistence root is required');
      const execution = input.execution === undefined ? {} : object(input.execution, 'execution');
      if ('localShell' in execution) throw new Error('CONFIG_NOT_APPLICABLE: localShell is not exposed by this host-delegated tool composition');
      fields(execution,['maxParallelToolCalls'],'execution');
      const parallel = execution.maxParallelToolCalls === undefined ? 4 : execution.maxParallelToolCalls;
      requireCondition(typeof parallel === 'number' && Number.isInteger(parallel) && parallel >= 1 && parallel <= 16, 'INVALID_CONFIG', 'execution.maxParallelToolCalls: integer 1..16 required');
      let model: DshConfig['model'];
      if (input.model !== undefined) {
        const value = object(input.model, 'model'); fields(value, ['name', 'credentialRef'], 'model');
        requireCondition(typeof value.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.name), 'INVALID_CONFIG', 'Invalid model name');
        requireCondition(typeof value.credentialRef === 'string' && /^env:[A-Z][A-Z0-9_]{0,63}$/.test(value.credentialRef), 'INVALID_CONFIG', 'Expected a credential reference');
        model = { name: value.name, credentialRef: value.credentialRef };
      }
      return { ...(model ? { model } : {}), workspaceRoot, sessionPersistenceRoot: path.resolve(input.sessionPersistenceRoot), execution: { maxParallelToolCalls: parallel } };
    },
    async createInstance(config) {
      const Client = await loadClient(runtimeRoot);
      if (loadClient === loadPinnedClient && config.execution?.maxParallelToolCalls !== 4) {
        const seal = object(JSON.parse(await readFile(path.join(runtimeRoot,'reconstruct-runtime.json'),'utf8')), 'runtime');
        requireCondition(object(seal.overlay,'overlay').id === 'config-parallel-v1', 'RUNTIME_MISMATCH', 'Configured parallelism requires the audited parameter bridge');
      }
      let failureHandler: ((code: InstanceFailureCode) => void) | undefined;
      const client = new Client({ workerFile: path.join(runtimeRoot, 'dist/worker.js'),
        workspaceRoot: config.workspaceRoot, startupTimeoutMs: 30_000, shutdownTimeoutMs: 5000, onFailure: () => failureHandler?.('PROCESS_EXITED') });
      // Credential/transport routing comes from trusted services, never JSON/model arguments.
      const modelRoute = await resolveModelRoute?.(config);
      const setup = { ...config, enableBridgeProofAdapter: proofMode, ...(modelRoute ? { modelRoute } : {}) };
      const sessions = new Map<string, string>();
      const running = new Set<string>();
      return {
        setFailureHandler(handler) { failureHandler = handler; },
        async start() { await client.start(); await client.extension({ operation: 'start', setup }); },
        async stop() { await client.stop(); },
        async run(task, { signal, emit, assertAuthorized }) {
          const turn = await resolveTurn(task, config);
          requireCondition(turn && typeof turn.assertActive === 'function' && Array.isArray(turn.hostTools),
            'INVALID_REQUEST', 'A finalized tool surface and authority check are required');
          requireCondition(typeof turn.sessionKey === 'string' && turn.sessionKey.length > 0 && turn.sessionKey.length <= 512,
            'INVALID_REQUEST', 'A bounded session binding is required');
          requireCondition(typeof turn.model === 'string' && turn.model.length > 0 &&
            (turn.provider === 'deepseek-official' || (proofMode && turn.provider === 'bridge-proof')),
            'INVALID_REQUEST', 'Unsupported DSH model route');
          // Stable host session identities require an epoch, matching the existing adapter.
          requireCondition(turn.hostSessionId && turn.hostLifecycleRevision && turn.hostAgentId,
            'INVALID_REQUEST', 'Host session reuse requires agent identity and lifecycle revision');
          const session = JSON.stringify([turn.hostAgentId, turn.hostSessionId]);
          requireCondition(!sessions.has(session) || sessions.get(session) === task.subject,
            'SUBJECT_DENIED', 'Session belongs to a different subject');
          requireCondition(!running.has(session), 'SESSION_BUSY', 'A session turn is still running or cleaning up');
          const tools = new Map<string, AdmittedHostTool>();
          for (const tool of turn.hostTools) {
            requireCondition(typeof tool.name === 'string' && !tools.has(tool.name) && typeof tool.execute === 'function' &&
              Array.isArray(tool.permissions) && tool.permissions.every((p: unknown) => typeof p === 'string' && task.permissions.includes(p)),
              'PERMISSION_DENIED', 'Tool exceeds the admitted task surface');
            tools.set(tool.name, tool);
          }
          let active = true;
          const assertActive = () => {
            requireCondition(active, 'CALLBACK_EXPIRED', 'Turn has ended');
            assertAuthorized(); signal.throwIfAborted(); turn.assertActive();
            requireCondition(Date.now() < task.expiresAt, 'RUN_TIMEOUT', 'Turn deadline expired');
          };
          try {
            assertActive();
            sessions.set(session, task.subject); running.add(session);
            const result = await client.extension({ operation: 'runHarnessAgent', setup, signal,
              timeoutMs: Math.max(1, task.expiresAt - Date.now()) + 1000,
              args: { task: task.input, sessionKey: turn.sessionKey, hostSessionId: turn.hostSessionId,
                hostAgentId: turn.hostAgentId, hostLifecycleRevision: turn.hostLifecycleRevision,
                provider: turn.provider, model: turn.model, images: turn.images,
                timeoutMs: Math.max(1, task.expiresAt - Date.now()),
                hostTools: [...tools.values()].map(({ name, label, description, parameters }) => ({ name, label, description, parameters })) },
              callbacks: {
                event: async event => { assertActive(); await turn.onEvent?.(event); emit({ kind: 'dsh.event' }); return null; },
                approval: async request => { assertActive(); const result = turn.approvalRequester ? await turn.approvalRequester(request) : 'unavailable'; assertActive(); return result; },
                tool: async (request, callbackSignal) => {
                  assertActive();
                  requireCondition(request !== null && typeof request === "object", "INVALID_REQUEST", "Malformed tool callback");
                  const callback = request as Record<string, unknown>;
                  requireCondition(typeof callback.name === "string" && typeof callback.callId === "string", "INVALID_REQUEST", "Malformed tool callback identity");
                  const tool = tools.get(callback.name);
                  requireCondition(tool, 'CALLBACK_DENIED', 'Tool is not in the finalized surface');
                  const combined = AbortSignal.any([signal, callbackSignal]);
                  combined.throwIfAborted();
                  const trace = (event: ToolTrace) => emit(event);
                  const started = Date.now();
                  trace({ kind: 'tool', callId: callback.callId, name: tool.name, status: 'running' });
                  try {
                    const result = await tool.execute(callback.callId, callback.args, combined);
                    assertActive(); combined.throwIfAborted();
                    let preview = '[Unserializable result]', previewTruncated = false;
                    try { const text = redact(JSON.stringify(result) ?? ''); previewTruncated = text.length > 2000; preview = text.slice(0, 2000); } catch {}
                    trace({ kind: 'tool', callId: callback.callId, name: tool.name, status: 'completed', durationMs: Date.now() - started, preview, previewTruncated });
                    return result;
                  } catch (error) {
                    trace({ kind: 'tool', callId: callback.callId, name: tool.name, status: combined.aborted ? 'cancelled' : 'failed',
                      durationMs: Date.now() - started, errorCode: error instanceof HarnessError ? error.code : 'TOOL_FAILED' });
                    throw error;
                  }
                },
              },
            });
            assertActive();
            return result;
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && ['BRIDGE_EXITED','BRIDGE_DISCONNECTED','BRIDGE_UNAVAILABLE'].includes(String(error.code))) failureHandler?.('TRANSPORT_LOST');
            throw error;
          } finally {
            active = false;
            // A cancelled RPC can settle before worker work. Closing its session
            // joins AgentHandle disposal before the provider run is considered settled.
            try {
              if (signal.aborted) {
                try { await client.extension({ operation: 'endHarnessSession', setup,
                  args: { sessionId: turn.hostSessionId, agentId: turn.hostAgentId }, timeoutMs: 5000 }); }
                catch (error) { failureHandler?.('TRANSPORT_LOST'); await client.stop(); throw error; }
              }
            } finally { running.delete(session); }
          }
        },
      };
    },
  };
}
