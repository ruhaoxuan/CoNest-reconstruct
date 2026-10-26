import { publishTools } from './publication.mjs';
import { configSchema } from './config-schema.mjs';
import { normalizePolicy, restrictPolicy } from './policy.mjs';
import type { Policy } from './policy.mjs';
import { Acquisition, deadline, terminateOwned } from './lifecycle.mjs';
import { DEFAULT_CONTROL, resolveInstance } from './config.mjs';
import type { ResolvedConfig } from './config.mjs';
import type { HarnessRegistry } from './registry.mjs';
import type { InstanceSpec, InstanceSnapshot, InstanceState, RegisteredProvider, HarnessInstance, TaskRequest, AdmittedTask, RunOptions, RunResult, HarnessEvent, StopOptions } from './types.mjs';
type ActiveRun = { controller: AbortController; done: Promise<void> };
type RecordState = { accessEpoch:number; uncertainRuns: Set<string>; acquisition: Acquisition | undefined; startController: AbortController | undefined; failures: number[]; nextStartAt: number; taskAccess: boolean; runtimeToken: string | undefined; cleanup: Promise<void> | undefined; id: string; provider: RegisteredProvider; config: unknown; ceiling: Policy; policy: Policy; enabled: boolean; state: InstanceState; instance: HarnessInstance | undefined; generation: string | undefined; queue: Promise<unknown>; runs: Map<string, ActiveRun>; pendingStops: number; lastError: string | undefined };
import { randomUUID } from 'node:crypto';
import { HarnessError, freeze, identifier, milliseconds, names, requireCondition } from './contracts.mjs';

export interface AuthorizationRecord { taskAccess: boolean; policy: Policy; baseRevision?: string; publishedTools?: readonly string[] }
export interface ManagerOptions {
  persistAuthorization?: (id: string, state: AuthorizationRecord) => Promise<void>;
  onEvent?: (event: HarnessEvent) => void;
}
const error = (code: string, message: string) => new HarnessError(code, message);

/** Minimal in-process control plane. Manager callers are trusted administrative callers. */
export class HarnessManager {
  #registry: HarnessRegistry;
  #options: ManagerOptions;
  #adminQueues = new Map<string,Promise<unknown>>();
  #configs = new Map<string, ResolvedConfig>();
  #instances = new Map<string, RecordState>();
  constructor(registry: HarnessRegistry, options: ManagerOptions = {}) { this.#registry = registry;this.#options=options; }

  create(spec: InstanceSpec) {
    identifier(spec?.id, 'instance id');
    requireCondition(!this.#instances.has(spec.id), 'INSTANCE_EXISTS', 'Instance already exists');
    const provider = this.#registry.resolve(spec.provider);
    const config = freeze(structuredClone(provider.validateConfig(structuredClone(spec.config ?? {}))));
    const policy = freeze(normalizePolicy(spec.policy ?? {}));
    requireCondition(!policy.tools||provider.descriptor.features.externalToolMediation,'UNSUPPORTED_CAPABILITY','Provider cannot enforce a mediated tool policy');
    const record: RecordState = { accessEpoch:0, uncertainRuns: new Set(), acquisition: undefined, startController: undefined, failures: [], nextStartAt: 0, taskAccess: true, runtimeToken: undefined, cleanup: undefined, id: spec.id, provider, config, ceiling: policy, policy, enabled: spec.enabled !== false,
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
      const authorization=this.authorization(id);
      await persist(next);
      r.config = next.spec.config; r.ceiling=normalizePolicy(next.spec.policy ?? {});r.policy=r.ceiling;
      r.enabled = next.spec.enabled !== false; r.state = r.enabled ? 'stopped' : 'disabled'; this.#configs.set(id,next);this.restoreAuthorization(id,authorization);
      return this.configured(id);
    });
  }
  #get(id: string) {
    const record = this.#instances.get(identifier(id, 'instance id'));
    requireCondition(record, 'INSTANCE_NOT_FOUND', 'Unknown instance');
    return record;
  }
  configSchema(){return configSchema(this.#registry);}
  #publication(r:RecordState){const tools=r.provider.toolSurface?.(r.config);return tools?publishTools(tools.filter(tool=>(!r.policy.tools||r.policy.tools.includes(tool.name))&&tool.permissions.every(p=>r.policy.allow.includes(p)&&!r.policy.deny.includes(p)))):undefined;}
  snapshot(id: string): InstanceSnapshot {
    const r = this.#get(id);
    const control=this.#control(r).restart,recent=r.failures.filter(at=>at>Date.now()-control.windowMs);
    const nextStartAt=Math.max(r.nextStartAt,recent.length>=control.maxFailures?(recent[0]??0)+control.windowMs:0);
    return { canForceStop:Boolean(r.instance&&r.provider.descriptor.features.processControl==='owned'&&r.provider.descriptor.features.hardTermination&&r.instance.terminate),...(this.#publication(r)?{toolPublication:this.#publication(r)}:{}),nextStartAt,restartFailures:recent.length,taskAccess: r.taskAccess ? 'enabled' : 'revoked', ownership: r.provider.descriptor.features.processControl,
      resourceState: r.state === 'starting' ? 'acquiring' : ['stopping','draining'].includes(r.state) ? 'releasing' :
        r.instance || r.acquisition || r.runs.size ? r.state === 'failed' ? 'unconfirmed' : 'held' : 'released',
      id: r.id, provider: r.provider.descriptor.id, providerVersion: r.provider.descriptor.version,
      enabled: r.enabled, state: r.state, generation: r.generation, activeRuns: r.runs.size, lastError: r.lastError };
  }
  policy(id:string) {return structuredClone(this.#get(id).policy);}
  authorization(id:string): AuthorizationRecord {const r=this.#get(id);return {taskAccess:r.taskAccess,policy:this.policy(id),baseRevision:this.#configs.get(id)?.revision,...(this.#publication(r)?{publishedTools:this.#publication(r)!.tools.map(t=>t.name)}:{})};}
  restoreAuthorization(id:string,record:AuthorizationRecord) {
    const r=this.#get(id);let requested=record.policy;
    if(record.baseRevision!==this.#configs.get(id)?.revision){
      const allowedTools=record.policy.tools??record.publishedTools;
      requested={subjects:record.policy.subjects.filter(s=>r.ceiling.subjects.includes(s)),
        allow:record.policy.allow.filter(p=>r.ceiling.allow.includes(p)&&!r.ceiling.deny.includes(p)),deny:[...new Set([...record.policy.deny,...r.ceiling.deny])],
        ...((allowedTools||r.ceiling.tools)?{tools:(allowedTools??r.ceiling.tools??[]).filter(t=>!r.ceiling.tools||r.ceiling.tools.includes(t))}:{})};
    }
    const policy=restrictPolicy(requested,r.ceiling);requireCondition(!policy.tools||r.provider.descriptor.features.externalToolMediation,'UNSUPPORTED_CAPABILITY','Provider cannot mediate external tool policy');
    r.policy=policy;this.setTaskAccess(id,record.taskAccess);
  }
  #admin<T>(id:string,work:()=>Promise<T>):Promise<T>{
    const result=(this.#adminQueues.get(id)??Promise.resolve()).catch(()=>{}).then(work);this.#adminQueues.set(id,result);return result;
  }
  updateAccess(id:string,allowed:boolean) {
    requireCondition(typeof allowed==='boolean','INVALID_REQUEST','Task access must be boolean');
    const r=this.#get(id);if(!allowed)this.setTaskAccess(id,false);else r.accessEpoch++;const epoch=r.accessEpoch;
    return this.#admin(id,async()=>{
      const effective=allowed&&epoch!==r.accessEpoch?r.taskAccess:allowed;
      await this.#options.persistAuthorization?.(id,{...this.authorization(id),taskAccess:effective});
      if(allowed&&epoch!==r.accessEpoch){await this.#options.persistAuthorization?.(id,this.authorization(id));return this.snapshot(id);}
      return this.setTaskAccess(id,effective);
    });
  }
  updatePolicy(id:string,raw:unknown) {
    return this.#admin(id,async()=>{
      const r=this.#get(id),policy=restrictPolicy(raw,r.ceiling),revision=this.#configs.get(id)?.revision;
      requireCondition(!policy.tools||r.provider.descriptor.features.externalToolMediation,'UNSUPPORTED_CAPABILITY','Provider cannot mediate external tool policy');
      await this.#options.persistAuthorization?.(id,{...this.authorization(id),policy});
      requireCondition(revision===this.#configs.get(id)?.revision,'STATE_CONFIG_CHANGED','Configuration changed during policy update');
      r.policy=freeze(policy);
      for(const run of r.runs.values())run.controller.abort(error('RUN_REVOKED','Task policy changed'));
      return this.policy(id);
    });
  }
  isRunUncertain(id:string,runId:string){return this.#get(id).uncertainRuns.has(runId);}
  isRunActive(id: string, runId: string): boolean { return this.#get(id).runs.has(runId); }
  setTaskAccess(id: string, allowed: boolean) {
    requireCondition(typeof allowed === 'boolean', 'INVALID_REQUEST', 'Task access must be boolean');
    const r = this.#get(id); r.accessEpoch++;r.taskAccess = allowed;
    if (!allowed) for (const run of r.runs.values()) run.controller.abort(error('RUN_REVOKED', 'Instance task access revoked'));
    return this.snapshot(id);
  }
  #control(r: RecordState) { return this.#configs.get(r.id)?.control ?? DEFAULT_CONTROL; }
  #recordFailure(r: RecordState) {
    const control=this.#control(r).restart,now=Date.now();
    r.failures=r.failures.filter(at=>at>now-control.windowMs);r.failures.push(now);
    r.nextStartAt=now+Math.min(control.maxDelayMs,control.baseDelayMs*2**Math.min(r.failures.length-1,16));
  }
  resetRestartBudget(id:string) { const r=this.#get(id);r.failures=[];r.nextStartAt=0;return this.snapshot(id); }
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
      requireCondition(!r.instance && !r.acquisition && r.runs.size === 0, 'INSTANCE_BUSY', 'Unreleased instance must be stopped before restarting');
      const control=this.#control(r),now=Date.now();r.failures=r.failures.filter(at=>at>now-control.restart.windowMs);
      requireCondition(r.failures.length<control.restart.maxFailures,'RESTART_LIMIT','Restart failure budget exhausted');
      requireCondition(now>=r.nextStartAt,'RESTART_BACKOFF','Restart backoff is active');
      const startController=new AbortController();r.startController=startController;
      if(r.pendingStops>0)setImmediate(()=>{if(r.state==='starting'&&r.startController===startController)startController.abort(error('START_CANCELLED','Stop requested during startup'));});
      r.state = 'starting'; r.lastError = undefined;
      try {
        const acquisition=new Acquisition(signal=>r.provider.createInstance(r.config,{signal}));r.acquisition=acquisition;
        r.instance=await deadline(acquisition.pending,control.createTimeoutMs,'CREATE_TIMEOUT',startController);
        r.acquisition=undefined;
        const instance = r.instance, token = randomUUID(); r.runtimeToken = token;
        instance.setFailureHandler?.(code => {
          if (r.instance !== instance || r.runtimeToken !== token) return;
          if(this.snapshot(r.id).state!=='failed')this.#recordFailure(r);
          r.state = 'failed'; r.lastError = ['PROCESS_EXITED','TRANSPORT_LOST','CREDENTIAL_REVOKED','CREDENTIAL_STALE'].includes(code) ? code : 'TRANSPORT_LOST';
          for (const run of r.runs.values()) run.controller.abort(error(code.startsWith('CREDENTIAL_')?'RUN_REVOKED':'RUN_INTERRUPTED', 'Instance runtime became unavailable'));
        });
        requireCondition(typeof r.instance.start === 'function' && typeof r.instance.run === 'function' && typeof r.instance.stop === 'function',
          'INVALID_PROVIDER', 'Instance must implement start/run/stop');
        await deadline(Promise.resolve().then(()=>r.instance!.start({signal:startController.signal})),control.startTimeoutMs,'START_TIMEOUT',startController);
        requireCondition(this.snapshot(id).state !== 'failed', 'START_FAILED', 'Instance failed during startup');
        requireCondition(!startController.signal.aborted,'START_CANCELLED','Start was cancelled');
        r.generation = randomUUID(); r.state = 'ready';r.nextStartAt=0;
      } catch (cause) {
        if(this.snapshot(r.id).state!=='failed'&&!(cause instanceof HarnessError&&cause.code==='START_CANCELLED'))this.#recordFailure(r);
        r.state='failed';r.lastError=cause instanceof HarnessError&&['CREATE_TIMEOUT','START_TIMEOUT','START_CANCELLED'].includes(cause.code)?cause.code:'START_FAILED';
        const acquisition=r.acquisition;
        if(acquisition){
          acquisition.abandon();
          acquisition.dispose().then(()=>{if(r.acquisition===acquisition)r.acquisition=undefined;},()=>{if(acquisition.settled&&!acquisition.instance&&r.acquisition===acquisition)r.acquisition=undefined;});
        }
        if(r.instance){
          const instance=r.instance,token=r.runtimeToken;
          try{
            await deadline(Promise.resolve().then(()=>instance.stop()),control.stopGraceMs,'START_CLEANUP_TIMEOUT');
            if(r.instance===instance&&r.runtimeToken===token){r.instance=undefined;r.runtimeToken=undefined;}
          }catch{
            if(r.provider.descriptor.features.processControl==='owned'&&r.provider.descriptor.features.hardTermination&&instance.terminate){
              try{await terminateOwned(instance,'owned',control.terminateTimeoutMs);if(r.instance===instance){r.instance=undefined;r.runtimeToken=undefined;}}
              catch{r.lastError='START_CLEANUP_FAILED';}
            }else r.lastError='START_CLEANUP_FAILED';
          }
        }
        throw error(r.lastError,'Instance failed to start; resources remain owned until confirmed cleanup');
      } finally {r.startController=undefined;}

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
  stop(id: string, { graceMs, disable = false, force = false }: StopOptions = {}) {
    graceMs = milliseconds(graceMs === undefined ? this.#configs.get(id)?.control.stopGraceMs ?? 1000 : graceMs, 'graceMs');
    const stopGraceMs = graceMs;
    const r = this.#get(id);
    r.pendingStops++;const starting=r.startController;if(starting)setImmediate(()=>{if(r.state==='starting'&&r.startController===starting)starting.abort(error('START_CANCELLED','Stop requested during startup'));});
    return this.#serial(r, async () => {
      if (disable) r.enabled = false;
      if(r.acquisition){try{await deadline(r.acquisition.dispose(),stopGraceMs,'STOP_TIMEOUT');r.acquisition=undefined;}catch{r.state='failed';r.lastError='STOP_TIMEOUT';throw error('STOP_TIMEOUT','Acquisition cleanup is not confirmed');}}
      if (!r.instance) { r.state = r.enabled ? 'stopped' : 'disabled'; return this.snapshot(id); }
      requireCondition(!force||(r.provider.descriptor.features.processControl==='owned'&&r.provider.descriptor.features.hardTermination),'TERMINATION_DENIED','Cannot terminate attached or remote resources');
      r.state = 'draining';
      // Step 1 uses cancel-on-stop. Graceful completion/drain policy is a later phase.
      for (const run of r.runs.values()) run.controller.abort(error('RUN_CANCELLED', 'Instance stopped'));
      const stopDeadline = Date.now() + stopGraceMs;
      const within = async (work: Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => reject(error('STOP_TIMEOUT', 'Cleanup not confirmed within deadline')), Math.max(1, stopDeadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      };
      try {
        await within(Promise.all([...r.runs.values()].map(run => run.done)));
        if (!r.instance) { r.uncertainRuns.clear();r.state = r.enabled ? 'stopped' : 'disabled'; r.lastError = undefined; return this.snapshot(id); }
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
        r.uncertainRuns.clear();r.state = r.enabled ? 'stopped' : 'disabled'; r.lastError = undefined;
      } catch (cause) {
        if(force&&r.instance){
          const instance=r.instance;
          try{
            await terminateOwned(instance,r.provider.descriptor.features.processControl,this.#control(r).terminateTimeoutMs);
            // Termination of an owned process is not proof that arbitrary in-process
            // callback work settled: keep tracking that work until it actually does.
            await deadline(Promise.all([...r.runs.values()].map(run=>run.done)),this.#control(r).terminateTimeoutMs,'WORK_UNSETTLED');
            if(r.instance===instance){r.instance=undefined;r.runtimeToken=undefined;r.cleanup=undefined;}
            r.state=r.enabled?'stopped':'disabled';r.lastError=undefined;return this.snapshot(id);
          }catch(termination){cause=termination;}
        }
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
      subject: request.subject, input: request.input, permissions: requested, expiresAt: Date.now() + timeoutMs,...(this.#publication(r)?{toolPublication:this.#publication(r)}:{}),...(r.policy.tools?{tools:[...r.policy.tools]}:{}) });
    let finished!: () => void; let sequence = 0, live = true;
    const record = { controller, done: new Promise<void>(resolve => { finished = resolve; }) };
    r.runs.set(request.runId, record);
    const emit = (type: HarnessEvent['type'], data?: unknown) => {
      const event = freeze({ instanceId: r.id, generation: admitted.generation, runId: admitted.runId,
        sequence: ++sequence, at: new Date().toISOString(),...(type==='run.started'?{subject:admitted.subject,permissions:admitted.permissions,tools:admitted.tools,publicationRevision:admitted.toolPublication?.revision}:{}), ...(type === 'provider.progress' ? { type, data } : { type }) }) as HarnessEvent;
      // Observers are not execution authorities. Sync or async observer failure cannot fail a run.
      try { this.#options.onEvent?.(event); } catch {}
      try { Promise.resolve(onEvent(event)).catch(() => {}); } catch {}
    };
    emit('run.started');
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return instance.run(admitted, { signal: controller.signal, markUncertain:()=>{r.uncertainRuns.add(admitted.runId);if(r.uncertainRuns.size>1000)r.uncertainRuns.delete(r.uncertainRuns.values().next().value!);},
        assertAuthorized: (permission,tool) => {
          controller.signal.throwIfAborted();
          requireCondition(live && r.instance === instance && r.generation === generation, 'AUTHORITY_REVOKED', 'Task authority is no longer active');
          requireCondition(r.taskAccess, 'RUN_REVOKED', 'Task access revoked');
          requireCondition(r.state !== 'failed', 'RUN_INTERRUPTED', 'Runtime became unavailable');
          requireCondition(r.state === 'ready' && r.pendingStops === 0, 'RUN_CANCELLED', 'Instance is stopping');
          requireCondition(!permission||(admitted.permissions.includes(permission)&&r.policy.allow.includes(permission)&&!r.policy.deny.includes(permission)),'PERMISSION_DENIED','Permission revoked');
          requireCondition(!tool||!r.policy.tools||r.policy.tools.includes(tool),'TOOL_DENIED','Tool is outside current policy');
          requireCondition(r.policy.subjects.includes(admitted.subject),'SUBJECT_DENIED','Subject revoked');
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
