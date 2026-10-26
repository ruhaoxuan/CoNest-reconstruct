import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { parseConfig } from '../config.mjs';
import type { ResolvedConfig } from '../config.mjs';
import { requireCondition } from '../contracts.mjs';
import type { ManagerOptions } from '../manager.mjs';
import { HarnessManager } from '../manager.mjs';
import { HarnessRegistry } from '../registry.mjs';
import type { HarnessProvider, HarnessEvent } from '../types.mjs';

/** Trusted application extensions. JSON selects registered providers, never modules. */
export interface StudioProvider {
  readonly provider: HarnessProvider;
  readonly permissions: readonly string[];
  permissionsFor?(config:unknown):readonly string[];
  validateInput(input: string): string;
  validateInstances?(instances: readonly ResolvedConfig[]): void;
}

export async function readStudioConfig(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1048577);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    requireCondition(size <= 1048576, 'INVALID_CONFIG', 'Configuration exceeds 1MiB');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}

export function createStudioApplication(text: string, definitions: readonly StudioProvider[], options: ManagerOptions = {}) {
  const registry = new HarnessRegistry();
  const entries = new Map<string, StudioProvider>();
  for (const entry of definitions) {
    registry.register(entry.provider);
    entries.set(entry.provider.id, entry);
  }
  // Validate the entire document, including cross-instance constraints, before creation.
  const configs = parseConfig(text, registry);
  for (const entry of definitions) entry.validateInstances?.(configs.filter(c => c.spec.provider === entry.provider.id));
  const manager = new HarnessManager(registry,options);
  for (const { spec, control } of configs) manager.createConfigured({
    id: spec.id, provider: spec.provider, providerConfigVersion: 1,
    enabled: spec.enabled, policy: spec.policy, control, providerConfig: spec.config,
  });
  return { manager, async submitTask(id: string, input: string, signal: AbortSignal, onEvent?: (event: HarnessEvent) => void): Promise<unknown> {
    const entry = entries.get(manager.snapshot(id).provider);
    requireCondition(entry, 'PROVIDER_NOT_FOUND', 'Studio provider is unavailable');
    const result = await manager.run(id, { runId: randomUUID(), subject: 'studio',
      input: entry.validateInput(input), permissions: entry.permissionsFor?.(manager.configured(id)?.spec.config)??entry.permissions }, { signal, onEvent });
    return result.output;
  } };
}
