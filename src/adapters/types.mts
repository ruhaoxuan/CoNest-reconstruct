import type { AdmittedTask, MaybePromise } from '../types.mjs';
export interface DshConfig { workspaceRoot: string; sessionPersistenceRoot: string; execution?: { maxParallelToolCalls: number }; model?: { name: string; credentialRef: string } }
export interface ModelRoute { apiKey?: string; baseURL?: string }
export interface HostTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(callId: string, args: unknown, signal: AbortSignal): MaybePromise<unknown>;
}
export interface AdmittedHostTool extends HostTool { readonly permissions: readonly string[] }
export interface HostTurnOptions {
  readonly task: string;
  readonly sessionKey: string;
  readonly hostSessionId: string;
  readonly hostAgentId: string;
  readonly hostLifecycleRevision: string;
  readonly provider: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly hostTools?: readonly HostTool[];
  readonly images?: readonly { data: string; mimeType: string; name?: string }[];
  readonly onEvent?: (event: unknown) => MaybePromise<void>;
  readonly approvalRequester?: (request: unknown) => MaybePromise<string>;
}
export type DshTurn = Omit<HostTurnOptions, 'task' | 'timeoutMs' | 'signal' | 'hostTools'> & {
  readonly hostTools: readonly AdmittedHostTool[];
  readonly assertActive: () => void;
};
export interface DshRunResult {
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly finalText: string;
  readonly finalContent: readonly { type: 'text'; text: string }[];
  readonly finalMediaUrls: readonly string[];
  readonly turnReason: unknown;
  readonly toolCalls: readonly { callId: string; name: string; arguments: string }[];
  readonly toolResults: readonly { callId: string; text: string; isError: boolean }[];
  readonly eventCount: number;
  readonly modelIterations: number;
  readonly sessionReused: boolean;
  readonly usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
}
export interface RuntimeCall {
  operation: 'start' | 'runHarnessAgent' | 'endHarnessSession';
  setup: DshConfig & { enableBridgeProofAdapter: boolean; modelRoute?: ModelRoute };
  signal?: AbortSignal;
  timeoutMs?: number;
  args?: Record<string, unknown>;
  callbacks?: Record<string, (request: unknown, signal: AbortSignal) => MaybePromise<unknown>>;
}
export interface RuntimeClient {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  extension(call: RuntimeCall): Promise<unknown>;
}
export type RuntimeClientConstructor = new (options: {
  workerFile: string; workspaceRoot: string; startupTimeoutMs: number; shutdownTimeoutMs: number; onFailure?: (message: string) => void;
}) => RuntimeClient;
export interface DshProviderOptions {
  readonly runtimeRoot: string;
  readonly resolveTurn: (task: AdmittedTask, config: DshConfig) => MaybePromise<DshTurn>;
  readonly resolveModelRoute?: (config: DshConfig) => MaybePromise<ModelRoute>;
  readonly proofMode?: boolean;
  readonly redact?: (text: string) => string;
  readonly loadClient?: (root: string) => Promise<RuntimeClientConstructor>;
}
export type DshBindingOptions = Omit<DshProviderOptions, 'resolveTurn'>;
