import type { ProviderDescriptor } from './types.mjs';
/** Versioned provider contract. No framework SDK or paid model is required. */
export const PROTOCOL_VERSION = 1;
export const STATES = Object.freeze(['disabled', 'stopped', 'starting', 'ready', 'draining', 'stopping', 'failed']);
export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HarnessError';
    this.code = code;
  }
}
export function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new HarnessError(code, message);
}
export function identifier(value: unknown, label: string): string {
  requireCondition(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value),
    'INVALID_REQUEST', `${label} must be a bounded identifier`);
  return value;
}
export function milliseconds(value: unknown, label: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 300_000,
    'INVALID_REQUEST', `${label} must be 1..300000 ms`);
  return value;
}
export function names(value: unknown, label: string): string[] {
  requireCondition(Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 128),
    'INVALID_REQUEST', `${label} must be a bounded string list`);
  return [...new Set(value as string[])];
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Providers are trusted code. This descriptor is NOT a sandbox attestation. */
export function providerDescriptor(provider: ProviderDescriptor & { validateConfig: unknown; createInstance: unknown }): ProviderDescriptor {
  identifier(provider?.id, 'provider id');
  requireCondition(typeof provider.version === 'string' && provider.version.length > 0,
    'INVALID_PROVIDER', 'Provider version is required');
  requireCondition(provider.protocolVersion === PROTOCOL_VERSION, 'PROTOCOL_MISMATCH', 'Unsupported provider protocol');
  requireCondition(typeof provider.validateConfig === 'function' && typeof provider.createInstance === 'function',
    'INVALID_PROVIDER', 'Provider must validate configuration and create an instance');
  requireCondition(typeof provider.features?.cooperativeCancel === 'boolean' &&
    ['owned', 'attached', 'remote'].includes(provider.features?.processControl),
    'INVALID_PROVIDER', 'Provider must describe cancellation and process ownership');
  return freeze(structuredClone({ id: provider.id, version: provider.version,
    protocolVersion: provider.protocolVersion, features: provider.features, ...(provider.configContract ? { configContract: provider.configContract } : {}) }));
}
