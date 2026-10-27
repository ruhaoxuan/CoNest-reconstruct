import type { TaskResultV2, ProgressV2 } from './public-v2.mjs';
import type { ExecutionFence } from './execution-journal.mjs';
/** Public framework-independent control-plane contracts. */
export type MaybePromise<T> = T | Promise<T>;
export type InstanceState = 'disabled' | 'stopped' | 'starting' | 'ready' | 'draining' | 'stopping' | 'failed';
export interface HarnessFeatures {
  cooperativeCancel: boolean;
  processControl: 'owned' | 'attached' | 'remote';
  resume?: boolean;
  toolGateway?: boolean;
  externalToolMediation?: boolean;
  hardTermination?: boolean;
}
export interface ProviderDescriptor {
  readonly configContract?: { readonly version: 1; readonly schema?: Record<string, unknown>; readonly fields: readonly { path: string; scope: string; update: 'restart-required' | 'immutable' }[] };
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
  readonly toolPublication?: ToolPublication;
  readonly expiresAt: number;
  readonly tools?: readonly string[];
}
interface EventBase {
  readonly subject?: string;
  readonly permissions?: readonly string[];
  readonly tools?: readonly string[];
  readonly publicationRevision?: string;
  readonly instanceId: string;
  readonly generation: string;
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
}
export type HarnessEvent = EventBase & (
  | { readonly type: 'provider.progress'; readonly data: unknown }
  | { readonly type: 'run.progress.v2'; readonly data: ProgressV2 }
  | { readonly type: 'run.started' | 'run.completed' | 'run.timed-out' | 'run.cancelled' | 'run.failed' | 'run.revoked' | 'run.interrupted' | 'run.uncertain'; readonly data?: never }
);
export interface ExecutionContext {
  readonly markUncertain: () => void;
  readonly assertAuthorized: (permission?: string, tool?: string) => void;
  readonly signal: AbortSignal;
  readonly emit: (data: unknown) => void;
}
export type InstanceFailureCode = 'PROCESS_EXITED' | 'TRANSPORT_LOST' | 'CREDENTIAL_REVOKED' | 'CREDENTIAL_STALE';
export interface HarnessInstance<Output = unknown> {
  setFailureHandler?(handler: ((code: InstanceFailureCode) => void) | undefined): void;
  start(context?: {readonly signal: AbortSignal}): Promise<void>;
  run(task: AdmittedTask, context: ExecutionContext): Promise<Output>;
  reconcileExecution?(record:ExecutionFence, context:{readonly signal:AbortSignal}):Promise<{readonly status:'settled'|'running'|'unknown'}>;
  stop(): Promise<void>;
  terminate?(): Promise<void>;
}
export interface HarnessProvider<Config = unknown, Output = unknown> extends ProviderDescriptor {
  projectResult?(raw:unknown):TaskResultV2;
  projectProgress?(raw:unknown):ProgressV2|undefined;
  toolSurface?(config:Config):readonly ToolSchema[];
  validateConfig(raw: unknown): Config;
  createInstance(config: Config, context?: { readonly signal: AbortSignal }): Promise<HarnessInstance<Output>>;
}
export interface RegisteredProvider {
  readonly descriptor: ProviderDescriptor;
  projectResult?(raw:unknown):TaskResultV2;
  projectProgress?(raw:unknown):ProgressV2|undefined;
  toolSurface?(config:unknown):readonly ToolSchema[];
  validateConfig(raw: unknown): unknown;
  createInstance(config: unknown, context?: { readonly signal: AbortSignal }): Promise<HarnessInstance>;
}
export interface InstancePolicy {
  readonly subjects?: readonly string[];
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly tools?: readonly string[];
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
  canReconcile?:boolean;
  unconfirmedRuns?:number;
  admissionBlocked?:boolean;
  taskAccess: 'enabled' | 'revoked';
  nextStartAt: number;
  restartFailures: number;
  canForceStop: boolean;
  toolPublication?: ToolPublication;
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
export interface StopOptions { readonly graceMs?: number; readonly disable?: boolean; readonly force?: boolean }
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

export interface ToolSchema {readonly name:string;readonly description:string;readonly parameters:Record<string,unknown>;readonly permissions:readonly string[]}
export interface ToolPublication {readonly revision:string;readonly tools:readonly ToolSchema[]}
