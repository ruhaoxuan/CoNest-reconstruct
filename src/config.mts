import { open,readFile,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { HarnessError, identifier, milliseconds, names, freeze, requireCondition } from './contracts.mjs';
import type { HarnessRegistry } from './registry.mjs';
import type { InstanceSpec } from './types.mjs';
export interface Control { defaultRunTimeoutMs: number; maxRunTimeoutMs: number; stopGraceMs: number;
  createTimeoutMs: number; startTimeoutMs: number; terminateTimeoutMs: number;
  restart: { maxFailures: number; windowMs: number; baseDelayMs: number; maxDelayMs: number } }
export const DEFAULT_CONTROL: Readonly<Control> = Object.freeze({defaultRunTimeoutMs:30000,maxRunTimeoutMs:300000,stopGraceMs:1000,
  createTimeoutMs:30000,startTimeoutMs:30000,terminateTimeoutMs:5000,
  restart:Object.freeze({maxFailures:3,windowMs:60000,baseDelayMs:500,maxDelayMs:30000})});
export interface ResolvedConfig { readonly spec: InstanceSpec; readonly control: Readonly<Control>; readonly revision: string }
export function object(value: unknown, path: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_CONFIG', `${path}: object required`);
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  requireCondition(Object.keys(value).every(k => allowed.includes(k) && !['__proto__','constructor','prototype'].includes(k)),
    'INVALID_CONFIG', `${path}: unknown or dangerous field`);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => JSON.stringify(k)+':'+canonical(x)).join(',') + '}';
  return JSON.stringify(v);
}
export function resolveInstance(raw: unknown, registry: HarnessRegistry): ResolvedConfig {
  const v = object(raw,'instance'); fields(v,['id','provider','providerConfigVersion','enabled','policy','control','providerConfig'],'instance');
  const id = identifier(v.id,'id'), provider = identifier(v.provider,'provider');
  requireCondition(v.providerConfigVersion === 1, 'CONFIG_VERSION', 'providerConfigVersion: expected 1');
  requireCondition(v.enabled === undefined || typeof v.enabled === 'boolean','INVALID_CONFIG','enabled: boolean required');
  const p = registry.resolve(provider);
  requireCondition(p.descriptor.configContract?.version === 1, 'CONFIG_CONTRACT_UNAVAILABLE', 'Provider does not declare this configuration contract');
  const policy = object(v.policy,'policy'); fields(policy,['subjects','allow','deny','tools'],'policy');
  const c = v.control === undefined ? {} : object(v.control,'control'); fields(c,['defaultRunTimeoutMs','maxRunTimeoutMs','stopGraceMs','createTimeoutMs','startTimeoutMs','terminateTimeoutMs','restart'],'control');
  const restart = c.restart === undefined ? {} : object(c.restart,'control.restart'); fields(restart,['maxFailures','windowMs','baseDelayMs','maxDelayMs'],'control.restart');
  const failures = restart.maxFailures === undefined ? 3 : restart.maxFailures; requireCondition(typeof failures==='number'&&Number.isInteger(failures)&&failures>=1&&failures<=20,'INVALID_CONFIG','restart.maxFailures must be 1..20');
  const control: Control = { defaultRunTimeoutMs: milliseconds(c.defaultRunTimeoutMs === undefined ? 30000 : c.defaultRunTimeoutMs,'control.defaultRunTimeoutMs'),
    maxRunTimeoutMs: milliseconds(c.maxRunTimeoutMs === undefined ? 300000 : c.maxRunTimeoutMs,'control.maxRunTimeoutMs'),
    stopGraceMs: milliseconds(c.stopGraceMs === undefined ? 1000 : c.stopGraceMs,'control.stopGraceMs'),
    createTimeoutMs:milliseconds(c.createTimeoutMs === undefined ? 30000 : c.createTimeoutMs,'createTimeoutMs'),startTimeoutMs:milliseconds(c.startTimeoutMs === undefined ? 30000 : c.startTimeoutMs,'startTimeoutMs'),terminateTimeoutMs:milliseconds(c.terminateTimeoutMs === undefined ? 5000 : c.terminateTimeoutMs,'terminateTimeoutMs'),
    restart:{maxFailures:failures,windowMs:milliseconds(restart.windowMs === undefined ? 60000 : restart.windowMs,'restart.windowMs'),baseDelayMs:milliseconds(restart.baseDelayMs === undefined ? 500 : restart.baseDelayMs,'restart.baseDelayMs'),maxDelayMs:milliseconds(restart.maxDelayMs === undefined ? 30000 : restart.maxDelayMs,'restart.maxDelayMs')} };
  requireCondition(control.restart.baseDelayMs<=control.restart.maxDelayMs,'INVALID_CONFIG','restart base exceeds maximum');
  requireCondition(control.defaultRunTimeoutMs <= control.maxRunTimeoutMs,'INVALID_CONFIG','control: default exceeds max');
  requireCondition(policy.tools===undefined||p.descriptor.features.externalToolMediation,'UNSUPPORTED_CAPABILITY','Provider cannot mediate tool policy');
  const config = p.validateConfig(v.providerConfig);
  const spec: InstanceSpec = { id, provider, enabled: v.enabled ?? true,
    policy: { subjects: names(policy.subjects === undefined ? [] : policy.subjects,'policy.subjects'),
      allow: names(policy.allow === undefined ? [] : policy.allow,'policy.allow'), deny: names(policy.deny === undefined ? [] : policy.deny,'policy.deny'),...(policy.tools===undefined?{}:{tools:names(policy.tools,'policy.tools')}) }, config };
  const revision = createHash('sha256').update(canonical({ spec, control, providerVersion:p.descriptor.version })).digest('hex');
  return freeze({ spec, control, revision });
}
export function parseConfig(text: string, registry: HarnessRegistry): readonly ResolvedConfig[] {
  requireCondition(Buffer.byteLength(text) <= 1048576,'INVALID_CONFIG','file: exceeds 1MiB');
  let raw: unknown; try { raw = JSON.parse(text, (key, value: unknown) => {
    if (['__proto__','constructor','prototype'].includes(key)) throw new HarnessError('INVALID_CONFIG','Dangerous configuration key'); return value;
  }); } catch { throw new HarnessError('INVALID_CONFIG','Invalid JSON configuration'); }
  const v=object(raw,'file'); fields(v,['schemaVersion','instances'],'file');
  requireCondition(v.schemaVersion===1,'CONFIG_VERSION','schemaVersion: expected 1');
  requireCondition(Array.isArray(v.instances)&&v.instances.length<=64,'INVALID_CONFIG','instances: array of at most 64 required');
  const result=v.instances.map(x=>resolveInstance(x,registry));
  requireCondition(new Set(result.map(x=>x.spec.id)).size===result.length,'INVALID_CONFIG','Duplicate instance id');
  return result;
}

/** One-instance file store. Lock is advisory; stale locks require explicit operator review. */
export async function persistConfig(file: string, expectedRevision: string | null, next: ResolvedConfig, registry: HarnessRegistry): Promise<void> {
  requireCondition(path.isAbsolute(file),'INVALID_CONFIG','Config store requires an absolute path');
  const lock = await open(file+'.lock','wx',0o600);
  const temporary = file+'.'+randomUUID()+'.tmp';
  try {
    let current: string | undefined;
    try { current=await readFile(file,'utf8'); } catch(e) { if(!(e instanceof Error && 'code' in e && e.code==='ENOENT')) throw e; }
    if(current===undefined) requireCondition(expectedRevision===null,'CONFIG_CONFLICT','Configuration file disappeared');
    else {
      const old=parseConfig(current,registry);
      requireCondition(old.length===1 && old[0]?.spec.id===next.spec.id && old[0].revision===expectedRevision,'CONFIG_CONFLICT','Stored configuration changed or contains multiple instances');
    }
    const payload=JSON.stringify({schemaVersion:1,instances:[{id:next.spec.id,provider:next.spec.provider,providerConfigVersion:1,
      enabled:next.spec.enabled,policy:next.spec.policy,control:next.control,providerConfig:next.spec.config}]},null,2)+'\n';
    requireCondition(parseConfig(payload,registry)[0]?.revision===next.revision,'INVALID_CONFIG','Configuration cannot round-trip');
    const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(payload);await handle.sync();}finally{await handle.close();}
    await rename(temporary,file);
  }finally{await lock.close();await unlink(file+'.lock');await unlink(temporary).catch(()=>{});}
}
