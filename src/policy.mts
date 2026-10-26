import { names, requireCondition } from './contracts.mjs';
import { object, fields } from './config.mjs';
import type { InstancePolicy } from './types.mjs';
export interface Policy { subjects: string[]; allow: string[]; deny: string[]; tools?: string[] }
export function normalizePolicy(value: InstancePolicy): Policy {
  return {subjects:names(value.subjects ?? [],'subjects'),allow:names(value.allow ?? [],'allow'),deny:names(value.deny ?? [],'deny'),
    ...(value.tools === undefined ? {} : {tools:names(value.tools,'tools')})};
}
export function restrictPolicy(raw: unknown, ceiling: Policy): Policy {
  const value=object(raw,'policy');fields(value,['subjects','allow','deny','tools'],'policy');
  const next=normalizePolicy(value as InstancePolicy);
  requireCondition(next.subjects.every(s=>ceiling.subjects.includes(s))&&next.allow.every(p=>ceiling.allow.includes(p)&&!ceiling.deny.includes(p)),
    'POLICY_CEILING','Dynamic policy cannot exceed configured authority');
  requireCondition(ceiling.deny.every(p=>next.deny.includes(p)),'POLICY_CEILING','Configured denials cannot be removed');
  if(ceiling.tools)requireCondition(next.tools!==undefined&&next.tools.every(t=>ceiling.tools!.includes(t)),'POLICY_CEILING','Tool policy exceeds configured ceiling');
  return next;
}
