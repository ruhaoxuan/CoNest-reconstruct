import type { HarnessProvider, RegisteredProvider } from './types.mjs';
import { identifier, providerDescriptor, requireCondition } from './contracts.mjs';

export class HarnessRegistry {
  #providers = new Map<string, RegisteredProvider>();
  register<C, O>(provider: HarnessProvider<C, O>) {
    const descriptor = providerDescriptor(provider);
    requireCondition(!this.#providers.has(descriptor.id), 'PROVIDER_EXISTS', 'Provider is already registered');
    // Snapshot method bindings and metadata; later descriptor mutation cannot reroute instances.
    this.#providers.set(descriptor.id, Object.freeze({ descriptor,
      validateConfig: provider.validateConfig.bind(provider), createInstance: (config: unknown) => provider.createInstance(config as C) }));
  }
  list() { return [...this.#providers.values()].map(p => structuredClone(p.descriptor)); }
  resolve(id: string) {
    identifier(id, 'provider id');
    const provider = this.#providers.get(id);
    requireCondition(provider, 'PROVIDER_NOT_FOUND', 'Provider is not registered');
    return provider;
  }
}
