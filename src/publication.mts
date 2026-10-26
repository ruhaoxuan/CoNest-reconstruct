import { createHash } from 'node:crypto';
import { identifier, names, requireCondition, freeze } from './contracts.mjs';
import type { ToolSchema, ToolPublication } from './types.mjs';
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function publishTools(tools:readonly ToolSchema[]):ToolPublication{
  requireCondition(tools.length<=256,'INVALID_PROVIDER','Too many published tools');
  const result=tools.map(tool=>{identifier(tool.name,'tool');requireCondition(tool.parameters&&typeof tool.parameters==='object'&&!Array.isArray(tool.parameters),'INVALID_PROVIDER','Tool parameters must be a schema');
    return {name:tool.name,description:tool.description,parameters:structuredClone(tool.parameters),permissions:names(tool.permissions,'tool.permissions')};});
  requireCondition(new Set(result.map(t=>t.name)).size===result.length,'INVALID_PROVIDER','Duplicate published tool');
  result.sort((a,b)=>a.name.localeCompare(b.name));
  return freeze({revision:createHash('sha256').update(canonical(result)).digest('hex'),tools:result});
}
