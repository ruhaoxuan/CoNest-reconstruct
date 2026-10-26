import type { HarnessRegistry } from './registry.mjs';
import { requireCondition } from './contracts.mjs';
const strings={type:'array',items:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'},uniqueItems:true};
const milliseconds={type:'integer',minimum:1,maximum:300000};
export function configSchema(registry:HarnessRegistry):Record<string,unknown>{
  const variants=registry.list().map(provider=>{
    requireCondition(provider.configContract?.schema,'CONFIG_SCHEMA_UNAVAILABLE','Provider must publish its configuration schema');
    return {type:'object',additionalProperties:false,required:['id','provider','providerConfigVersion','policy','providerConfig'],properties:{
      id:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'},provider:{const:provider.id},providerConfigVersion:{const:1},enabled:{type:'boolean',default:true},
      policy:{type:'object',additionalProperties:false,properties:{subjects:strings,allow:strings,deny:strings,tools:strings}},
      control:{type:'object',additionalProperties:false,properties:{defaultRunTimeoutMs:milliseconds,maxRunTimeoutMs:milliseconds,stopGraceMs:milliseconds,
        createTimeoutMs:milliseconds,startTimeoutMs:milliseconds,terminateTimeoutMs:milliseconds,restart:{type:'object',additionalProperties:false,properties:{maxFailures:{type:'integer',minimum:1,maximum:20},windowMs:milliseconds,baseDelayMs:milliseconds,maxDelayMs:milliseconds}}}},
      providerConfig:provider.configContract.schema}};
  });
  return {$schema:'https://json-schema.org/draft/2020-12/schema',title:'CoNest managed Harness configuration',type:'object',additionalProperties:false,
    required:['schemaVersion','instances'],properties:{schemaVersion:{const:1},instances:{type:'array',maxItems:64,items:{oneOf:variants}}}};
}
