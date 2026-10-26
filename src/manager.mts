import { resolveInstance } from './config.mjs';
import type { ResolvedConfig } from './config.mjs';
import type { HarnessRegistry } from './registry.mjs';
import type { InstanceSpec, InstanceSnapshot, InstanceState, RegisteredProvider, HarnessInstance, TaskRequest, AdmittedTask, RunOptions, RunResult, HarnessEvent, StopOptions } from './types.mjs';
type ActiveRun = { controller: AbortController; done: Promise<void> };
type RecordState = { taskAccess: boolean; runtimeToken: string | undefined; cleanup: Promise<void> | undefined; id: string; provider: RegisteredProvider; config: unknown; policy: { subjects: string[]; allow: string[]; deny: string[] }; enabled: boolean; state: InstanceState; instance: HarnessInstance | undefined; generation: string | undefined; queue: Promise<unknown>; runs: Map<string, ActiveRun>; pendingStops: number; lastError: string | undefined };
import { randomUUID } from 'node:crypto';
import { HarnessError, freeze, identifier, milliseconds, names, requireCondition } from './contracts.mjs';

const error = (code: string, message: string) => new HarnessError(code, message);

/** Minimal in-process control plane. Manager callers are trusted administrative callers. */
export class HarnessManager {
  #registry: HarnessRegistry;
  #configs = new Map<string, ResolvedConfig>();
  #instances = new Map<string, RecordState>();
  constructor(registry: HarnessRegistry) { this.#registry = registry; }

  create(spec: InstanceSpec) {
    identifier(spec?.id, 'instance id');
    requireCondition(!this.#instances.has(spec.id), 'INSTANCE_EXISTS', 'Instance already exists');
    const provider = this.#registry.resolve(spec.provider);
    const config = freeze(structuredClone(provider.validateConfig(structuredClone(spec.config ?? {}))));
    const policy = freeze({ subjects: names(spec.policy?.subjects ?? [], 'subjects'),
      allow: names(spec.policy?.allow ?? [], 'allow'), deny: names(spec.policy?.deny ?? [], 'deny') });
    const record: RecordState = { taskAccess: true, runtimeToken: undefined, cleanup: undefined, id: spec.id, provider, config, policy, enabled: spec.enabled !== false,
      state: spec.enabled === false ? 'disabled' : 'stopped', instance: undefined,
      generation: undefined, queue: Promise.resolve(), runs: new Map(), pendingStops: 0, lastError: undefined };
    this.#instances.set(spec.id, record);
    return this.snapshot(spec.id);
  }
  previewConfig(raw: unknown) { return resolveInstance(raw, this.#registry); }
  configured(id: string) { return structuredClone(this.#configs.get(id)); }
  createConfigured(raw: unknown) {
    const next = this.previewConfig(raw);
    const result = this.create(next.spec); this.#configs.set(next.spec.id, next); return result;
  }
  applyConfig(id: string, raw: unknown, expectedRevision: string,
    persist: (config: ResolvedConfig) => Promise<void> = async () => {}) {
    const r = this.#get(id);
    return this.#serial(r, async () => {
      requireCondition(!r.instance && r.runs.size === 0 && ['stopped','disabled'].includes(r.state), 'CONFIG_RESTART_REQUIRED', 'Stop and release the instance first');
      const old = this.#configs.get(id);
      requireCondition(old && old.revision === expectedRevision, 'CONFIG_CONFLICT', 'Configuration changed');
      const next = this.previewConfig(raw);
      requireCondition(next.spec.id === id && next.spec.provider === r.provider.descriptor.id, 'INVALID_CONFIG', 'Instance identity is immutable');
      const before = old.spec.config as Record<string, unknown>, after = next.spec.config as Record<string, unknown>;
      for (const field of r.provider.descriptor.configContract?.fields ?? []) {
        if (field.update === 'immutable') requireCondition(before[field.path] === after[field.path], 'INVALID_CONFIG', 'Immutable field: '+field.path);
      }
      await persist(next);
      r.config = next.spec.config; r.policy = { subjects: [...next.spec.policy?.subjects ?? []], allow: [...next.spec.policy?.allow ?? []], deny: [...next.spec.policy?.deny ?? []] };
      r.enabled = next.spec.enabled !== false; r.state = r.enabled ? 'stopped' : 'disabled'; this.#configs.set(id,next);
      return this.configured(id);
    });
  }
  #get(id: string) {
    const record = this.#instances.get(identifier(id, 'instance id'));
    requireCondition(record, 'INSTANCE_NOT_FOUND', 'Unknown instance');
    return record;
  }
  snapshot(id: string): InstanceSnapshot {
    const r = this.#get(id);
    return { taskAccess: r.taskAccess ? 'enabled' : 'revoked', ownership: r.provider.descriptor.features.processControl,
      resourceState: r.state === 'starting' ? 'acquiring' : ['stopping','draining'].includes(r.state) ? 'releasing' :
        r.instance || r.runs.size ? r.state === 'failed' ? 'unconfirmed' : 'held' : 'released',
      id: r.id, provider: r.provider.descriptor.id, providerVersion: r.provider.descriptor.version,
      enabled: r.enabled, state: r.state, generation: r.generation, activeRuns: r.runs.size, lastError: r.lastError };
  }
  isRunActive(id: string, runId: string): boolean { return this.#get(id).runs.has(runId); }
  setTaskAccess(id: string, allowed: boolean) {
    requireCondition(typeof allowed === 'boolean', 'INVALID_REQUEST', 'Task access must be boolean');
    const r = this.#get(id); r.taskAccess = allowed;
    if (!allowed) for (const run of r.runs.values()) run.controller.abort(error('RUN_REVOKED', 'Instance task access revoked'));
    return this.snapshot(id);
  }
  list() { return [...this.#instances.keys()].map(id => this.snapshot(id)); }
  #serial<T>(r: RecordState, action: () => Promise<T>): Promise<T> {
    const result = r.queue.then(action);
    r.queue = result.catch(() => {});
    return result;
  }
  start(id: string) {
    const r = this.#get(id);
    return this.#serial(r, async () => {
      requireCondition(r.enabled, 'INSTANCE_DISABLED', 'Instance is disabled');
      if (r.state === 'ready') return this.snapshot(id);
      requireCondition(!r.instance && r.runs.size === 0, 'INSTANCE_BUSY', 'Unreleased instance must be stopped before restarting');
      r.state = 'starting'; r.lastError = undefined;
      try {
        r.instance = await r.provider.createInstance(r.config);
        const instance = r.instance, token = randomUUID(); r.runtimeToken = token;
        instance.setFailureHandler?.(code => {
          if (r.instance !== instance || r.runtimeToken !== token) return;
          r.state = 'failed'; r.lastError = code === 'PROCESS_EXITED' ? code : 'TRANSPORT_LOST';
          for (const run of r.runs.values()) run.controller.abort(error('RUN_INTERRUPTED', 'Instance runtime became unavailable'));
        });
        requireCondition(typeof r.instance.start === 'function' && typeof r.instance.run === 'function' && typeof r.instance.stop === 'function',
          'INVALID_PROVIDER', 'Instance must implement start/run/stop');
        await r.instance.start();
        requireCondition(this.snapshot(id).state !== 'failed', 'START_FAILED', 'Instance failed during startup');
        r.generation = randomUUID(); r.state = 'ready';
      } catch (cause) {
        r.state = 'failed'; r.lastError = 'START_FAILED';
        try { if (r.instance) { await r.instance.stop(); r.instance = undefined; r.runtimeToken = undefined; } }
        catch { r.lastError = 'START_CLEANUP_FAILED'; }
        throw error(r.lastError, 'Instance failed to start; inspect provider diagnostics');
      }
      return this.snapshot(id);
    });
  }
  enable(id: string) {
    const r = this.#get(id);
    return this.#serial(r, async () => {
      r.enabled = true;
      if (r.state === 'disabled') r.state = 'stopped';
      return this.snapshot(id);
    });
  }
  stop(id: string, { graceMs, disable = false }: StopOptions = {}) {
    graceMs = milliseconds(graceMs === undefined ? this.#configs.get(id)?.control.stopGraceMs ?? 1000 : graceMs, 'graceMs');
    const stopGraceMs = graceMs;
    const r = this.#get(id);
    r.pendingStops++;
    return this.#serial(r, async () => {
      if (disable) r.enabled = false;
      if (!r.instance) { r.state = r.enabled ? 'stopped' : 'disabled'; return this.snapshot(id); }
      r.state = 'draining';
      // Step 1 uses cancel-on-stop. Graceful completion/drain policy is a later phase.
      for (const run of r.runs.values()) run.controller.abort(error('RUN_CANCELLED', 'Instance stopped'));
      const deadline = Date.now() + stopGraceMs;
      const within = async (work: Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => reject(error('STOP_TIMEOUT', 'Cleanup not confirmed within deadline')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      };
      try {
        await within(Promise.all([...r.runs.values()].map(run => run.done)));
        if (!r.instance) { r.state = r.enabled ? 'stopped' : 'disabled'; r.lastError = undefined; return this.snapshot(id); }
        r.state = 'stopping';
        if (!r.cleanup) {
          const instance = r.instance, token = r.runtimeToken;
          const cleanup = Promise.resolve().then(() => instance!.stop());
          r.cleanup = cleanup;
          cleanup.then(() => {
            if (r.instance === instance && r.runtimeToken === token) {
              r.instance = undefined; r.runtimeToken = undefined;
            }
            if (r.cleanup === cleanup) r.cleanup = undefined;
          }, () => { if (r.cleanup === cleanup) r.cleanup = undefined; });
        }
        await within(r.cleanup);
        r.state = r.enabled ? 'stopped' : 'disabled'; r.lastError = undefined;
      } catch (cause) {
        r.state = 'failed'; r.lastError = cause instanceof HarnessError ? cause.code : 'STOP_FAILED';
        throw error(r.lastError, 'Stop could not confirm cleanup; inspect resource state');
      }
      return this.snapshot(id);
    }).finally(() => { r.pendingStops--; });
  }
  disable(id: string, options: StopOptions = {}) { return this.stop(id, { ...options, disable: true }); }

  async run(id: string, request: TaskRequest, { signal, onEvent = () => {} }: RunOptions = {}): Promise<RunResult> {
    const r = this.#get(id);
    requireCondition(r.enabled && r.state === 'ready' && r.pendingStops === 0, 'INSTANCE_NOT_READY', 'Instance does not accept tasks');
    requireCondition(r.taskAccess, 'TASK_ACCESS_REVOKED', 'Instance task access is revoked');
    const instance = r.instance;
    const generation = r.generation;
    requireCondition(instance && generation, 'INSTANCE_NOT_READY', 'Instance has no active runtime generation');
    identifier(request?.runId, 'run id'); identifier(request?.subject, 'subject');
    requireCondition(typeof request.input === 'string' && Buffer.byteLength(request.input) <= 64_000,
      'INVALID_REQUEST', 'Input must be a bounded string');
    const control = this.#configs.get(id)?.control;
    const timeoutMs = milliseconds(request.timeoutMs === undefined ? control?.defaultRunTimeoutMs ?? 30_000 : request.timeoutMs, 'timeoutMs');
    requireCondition(timeoutMs <= (control?.maxRunTimeoutMs ?? 300000), 'INVALID_REQUEST', 'Task deadline exceeds instance ceiling');
    const requested = names(request.permissions ?? [], 'permissions');
    requireCondition(r.policy.subjects.includes(request.subject), 'SUBJECT_DENIED', 'Subject is not admitted');
    requireCondition(requested.every(name => r.policy.allow.includes(name) && !r.policy.deny.includes(name)),
      'PERMISSION_DENIED', 'Requested permissions exceed the instance policy');
    requireCondition(!r.runs.has(request.runId), 'DUPLICATE_RUN', 'Run is already active');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? error('RUN_CANCELLED', 'Caller cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(error('RUN_TIMEOUT', 'Task deadline exceeded')), timeoutMs);
    const admitted: AdmittedTask = freeze({ instanceId: r.id, generation, runId: request.runId,
      subject: request.subject, input: request.input, permissions: requested, expiresAt: Date.now() + timeoutMs });
    let finished!: () => void; let sequence = 0, live = true;
    const record = { controller, done: new Promise<void>(resolve => { finished = resolve; }) };
    r.runs.set(request.runId, record);
    const emit = (type: HarnessEvent['type'], data?: unknown) => {
      const event = freeze({ instanceId: r.id, generation: admitted.generation, runId: admitted.runId,
        sequence: ++sequence, at: new Date().toISOString(), ...(type === 'provider.progress' ? { type, data } : { type }) }) as HarnessEvent;
      // Observers are not execution authorities. Sync or async observer failure cannot fail a run.
      try { Promise.resolve(onEvent(event)).catch(() => {}); } catch {}
    };
    emit('run.started');
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return instance.run(admitted, { signal: controller.signal,
        assertAuthorized: () => {
          controller.signal.throwIfAborted();
          requireCondition(live && r.instance === instance && r.generation === generation, 'AUTHORITY_REVOKED', 'Task authority is no longer active');
          requireCondition(r.taskAccess, 'RUN_REVOKED', 'Task access revoked');
          requireCondition(r.state !== 'failed', 'RUN_INTERRUPTED', 'Runtime became unavailable');
          requireCondition(r.state === 'ready' && r.pendingStops === 0, 'RUN_CANCELLED', 'Instance is stopping');
          requireCondition(Date.now() < admitted.expiresAt, 'RUN_TIMEOUT', 'Task deadline expired');
        },
        emit: data => { if (live && !controller.signal.aborted) emit('provider.progress', structuredClone(data)); } });
    });
    // Keep tracking actual provider settlement even after caller cancellation/timeout.
    const release = () => { r.runs.delete(admitted.runId); finished(); };
    work.then(release, release);
    let cancelListener: (() => void) | undefined;
    try {
      const cancelled = new Promise((_, reject) => {
        cancelListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelListener, { once: true });
        if (controller.signal.aborted) cancelListener();
      });
      const output = await Promise.race([work, cancelled]);
      controller.signal.throwIfAborted();
      const result: RunResult = freeze({ ...admitted, state: 'completed' as const, output: structuredClone(output) });
      emit('run.completed');
      return result;
    } catch (cause) {
      const code = controller.signal.aborted
        ? controller.signal.reason instanceof HarnessError ? controller.signal.reason.code : 'RUN_CANCELLED'
        : cause instanceof HarnessError && ['RUN_TIMEOUT','RUN_REVOKED','RUN_INTERRUPTED','RUN_CANCELLED'].includes(cause.code) ? cause.code : 'RUN_FAILED';
      emit(code === 'RUN_TIMEOUT' ? 'run.timed-out' : code === 'RUN_REVOKED' ? 'run.revoked' : code === 'RUN_INTERRUPTED' ? 'run.interrupted' : code === 'RUN_CANCELLED' || controller.signal.aborted ? 'run.cancelled' : 'run.failed');
      throw error(code, 'Harness task did not complete successfully');
    } finally {
      live = false; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelListener) controller.signal.removeEventListener('abort', cancelListener);
    }
  }
}
