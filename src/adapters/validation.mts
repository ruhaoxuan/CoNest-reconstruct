import { requireCondition } from '../contracts.mjs';
import type { DshRunResult } from './types.mjs';
export function record(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RESPONSE', 'Expected an object');
  return value as Record<string, unknown>;
}
/** Runtime RPC is untyped input even when both sides were compiled. */
export function parseDshResult(value: unknown): DshRunResult {
  const result = record(value);
  requireCondition(['sessionId', 'provider', 'model', 'finalText'].every(k => typeof result[k] === 'string') &&
    typeof result.sessionReused === 'boolean' &&
    ['eventCount', 'modelIterations'].every(k => Number.isSafeInteger(result[k]) && Number(result[k]) >= 0),
    'INVALID_RESPONSE', 'Malformed DSH result metadata');
  for (const key of ['finalContent', 'finalMediaUrls', 'toolCalls', 'toolResults'])
    requireCondition(Array.isArray(result[key]), 'INVALID_RESPONSE', `Malformed ${key}`);
  requireCondition((result.finalContent as unknown[]).every(v => {
    const item = record(v); return item.type === 'text' && typeof item.text === 'string';
  }) && (result.finalMediaUrls as unknown[]).every(v => typeof v === 'string'), 'INVALID_RESPONSE', 'Malformed final content');
  requireCondition((result.toolCalls as unknown[]).every(v => {
    const item = record(v); return ['callId', 'name', 'arguments'].every(k => typeof item[k] === 'string');
  }) && (result.toolResults as unknown[]).every(v => {
    const item = record(v); return typeof item.callId === 'string' && typeof item.text === 'string' && typeof item.isError === 'boolean';
  }), 'INVALID_RESPONSE', 'Malformed tool results');
  const usage = record(result.usage);
  requireCondition(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].every(k =>
    typeof usage[k] === 'number' && Number.isFinite(usage[k]) && usage[k] >= 0), 'INVALID_RESPONSE', 'Malformed usage');
  return result as unknown as DshRunResult;
}
