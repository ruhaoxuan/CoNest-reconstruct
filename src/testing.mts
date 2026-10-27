import { parseTaskResultV2 } from './public-v2.mjs';
import type { HarnessProvider, AdmittedTask } from './types.mjs';
type Config = { mode: 'echo' | 'wait' | 'fail' | 'ignore-cancel' | 'uncertain'; delayMs: number; failStart: boolean };
import { PROTOCOL_VERSION, requireCondition } from './contracts.mjs';

/** Finite noncooperative work lets tests verify truthful cleanup accounting. */
export function createTestProvider(id = 'test.echo', hooks: { start?: () => void; stop?: () => void; run?: (task: AdmittedTask) => void } = {}): HarnessProvider<Config, { text: string }> {
  return {
    projectResult(raw){requireCondition(raw!==null&&typeof raw==='object'&&'text' in raw&&typeof raw.text==='string','INVALID_PROVIDER_RESULT','Invalid echo result');return parseTaskResultV2({schemaVersion:2,content:[{type:'text',text:raw.text}]});},
    projectProgress(){return {kind:'notice',code:'TASK_ENTERED'};},
    configContract:{version:1,fields:[],schema:{type:'object',additionalProperties:false,properties:{mode:{enum:['echo','wait','fail','ignore-cancel','uncertain']},delayMs:{type:'integer',minimum:1,maximum:5000},failStart:{type:'boolean'}}}},
    id, version: '0.1.0', protocolVersion: PROTOCOL_VERSION,
    features: { cooperativeCancel: true, processControl: 'owned', toolGateway: false, resume: false },
    validateConfig(raw) {
      requireCondition(raw !== null && typeof raw === "object" && !Array.isArray(raw), "INVALID_CONFIG", "Configuration must be an object");
      const input = raw as Record<string, unknown>;
      requireCondition(raw && typeof raw === 'object' && !Array.isArray(raw) &&
        Object.keys(raw).every(k => ['mode', 'delayMs', 'failStart'].includes(k)), 'INVALID_CONFIG', 'Unknown test configuration');
      const config = { mode: input.mode ?? 'echo', delayMs: input.delayMs ?? 20, failStart: input.failStart ?? false };
      requireCondition(typeof config.mode === 'string' && ['echo', 'wait', 'fail', 'ignore-cancel', 'uncertain'].includes(config.mode) &&
        typeof config.delayMs === 'number' && Number.isInteger(config.delayMs) && config.delayMs >= 1 && config.delayMs <= 5000 &&
        typeof config.failStart === 'boolean', 'INVALID_CONFIG', 'Invalid test configuration');
      return config as Config;
    },
    async createInstance(config) {
      return {
        async start() { hooks.start?.(); if (config.failStart) throw new Error('Synthetic start failure'); },
        async run(request, { signal, emit, markUncertain }) {
          hooks.run?.(request); emit({ phase: 'entered' });
          if(config.mode==='uncertain'){markUncertain();return {text:'Synthetic uncertainty only; no remote work was started'};}
          if (config.mode === 'fail') throw new Error('Synthetic task failure');
          if (config.mode === 'wait' || config.mode === 'ignore-cancel') {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, config.delayMs);
              const abort = () => { clearTimeout(timer); reject(signal.reason); };
              if (config.mode === 'wait') {
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              }
            });
          }
          return { text: request.input };
        },
        async stop() { hooks.stop?.(); },
      };
    },
  };
}
