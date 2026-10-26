import { requireCondition } from './contracts.mjs';

export interface CredentialService {
  resolve(reference: string): string;
  redact(text: string): string;
}
/** Explicit allowlist: configuration cannot read arbitrary environment variables. */
export function createEnvironmentCredentials(env: NodeJS.ProcessEnv = process.env): CredentialService {
  const known = new Set<string>();
  return {
    resolve(reference) {
      requireCondition(reference === 'env:DEEPSEEK_API_KEY', 'CREDENTIAL_REFERENCE_DENIED', 'Unsupported credential reference');
      const value = env.DEEPSEEK_API_KEY?.trim();
      requireCondition(value && value.length >= 8 && value.length <= 4096 && !/\s/.test(value),
        'CREDENTIAL_UNAVAILABLE', 'Set DEEPSEEK_API_KEY in the launching environment');
      known.add(value); return value;
    },
    redact(text) {
      // Redact both current and previously resolved credentials (including after rotation).
      const current = env.DEEPSEEK_API_KEY?.trim();
      const values = [...known, ...(current && current.length >= 8 ? [current] : [])].sort((a, b) => b.length - a.length);
      let safe = text;
      for (const value of values) safe = safe.split(value).join('[REDACTED]');
      return safe;
    },
  };
}
