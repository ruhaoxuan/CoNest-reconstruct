/** Public framework-independent control-plane contracts. */
export type MaybePromise<T> = T | Promise<T>;
export type InstanceState = 'disabled' | 'stopped' | 'starting' | 'ready' | 'draining' | 'stopping' | 'failed';
export interface HarnessFeatures {
  cooperativeCancel: boolean;
  processControl: 'owned' | 'attached' | 'remote';
  resume?: boolean;
  toolGateway?: boolean;
  externalToolMediation?: boolean;
}
export interface ProviderDescriptor {
  readonly configContract?: { readonly version: 1; readonly fields: readonly { path: string; scope: string; update: 'restart-required' | 'immutable' }[] };
  readonly id: string;
  readonly version: string;
  readonly protocolVersion: number;
  readonly features: Readonly<HarnessFeatures>;
}
export interface TaskRequest {
  readonly runId: string;
  readonly subject: string;
  readonly input: string;
  readonly permissions?: readonly string[];
  readonly timeoutMs?: number;
}
export interface AdmittedTask {
  readonly instanceId: string;
  readonly generation: string;
  readonly runId: string;
  readonly subject: string;
  readonly input: string;
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}
interface EventBase {
  readonly instanceId: string;
  readonly generation: string;
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
}
export type HarnessEvent = EventBase & (
  | { readonly type: 'provider.progress'; readonly data: unknown }
  | { readonly type: 'run.started' | 'run.completed' | 'run.timed-out' | 'run.cancelled' | 'run.failed' | 'run.revoked' | 'run.interrupted'; readonly data?: never }
);
export interface ExecutionContext {
  readonly assertAuthorized: () => void;
  readonly signal: AbortSignal;
  readonly emit: (data: unknown) => void;
}
export type InstanceFailureCode = 'PROCESS_EXITED' | 'TRANSPORT_LOST';
export interface HarnessInstance<Output = unknown> {
  setFailureHandler?(handler: ((code: InstanceFailureCode) => void) | undefined): void;
  start(): Promise<void>;
  run(task: AdmittedTask, context: ExecutionContext): Promise<Output>;
  stop(): Promise<void>;
}
export interface HarnessProvider<Config = unknown, Output = unknown> extends ProviderDescriptor {
  validateConfig(raw: unknown): Config;
  createInstance(config: Config): Promise<HarnessInstance<Output>>;
}
export interface RegisteredProvider {
  readonly descriptor: ProviderDescriptor;
  validateConfig(raw: unknown): unknown;
  createInstance(config: unknown): Promise<HarnessInstance>;
}
export interface InstancePolicy {
  readonly subjects?: readonly string[];
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}
export interface InstanceSpec {
  readonly id: string;
  readonly provider: string;
  readonly config?: unknown;
  readonly enabled?: boolean;
  readonly policy?: InstancePolicy;
}
export type ResourceState = 'released' | 'acquiring' | 'held' | 'releasing' | 'unconfirmed';
export interface InstanceSnapshot {
  taskAccess: 'enabled' | 'revoked';
  ownership: HarnessFeatures['processControl'];
  resourceState: ResourceState;
  id: string;
  provider: string;
  providerVersion: string;
  enabled: boolean;
  state: InstanceState;
  generation: string | undefined;
  activeRuns: number;
  lastError: string | undefined;
}
export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: HarnessEvent) => MaybePromise<void>;
}
export interface RunResult extends AdmittedTask {
  readonly state: 'completed';
  readonly output: unknown;
}
export interface StopOptions { readonly graceMs?: number; readonly disable?: boolean }
export interface ManagerPort {
  run(id: string, request: TaskRequest, options?: RunOptions): Promise<RunResult>;
}

/** Bounded, displayable tool progress. Arguments are deliberately not included. */
export interface ToolTrace {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly durationMs?: number;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly errorCode?: string;
}
