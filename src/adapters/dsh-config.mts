export const WORKSPACE_PLUGINS=['workspace.read','workspace.list','workspace.search'] as const;
export const DSH_CONFIG_SCHEMA={type:'object',additionalProperties:false,required:['workspaceRoot','sessionPersistenceRoot'],properties:{
  workspaceRoot:{type:'string',minLength:1,description:'Absolute existing directory; checked at runtime'},sessionPersistenceRoot:{type:'string',minLength:1,description:'Absolute path; namespaces must not overlap'},
  execution:{type:'object',additionalProperties:false,properties:{maxParallelToolCalls:{type:'integer',minimum:1,maximum:16,default:4}}},
  model:{type:'object',additionalProperties:false,required:['name','credentialRef'],properties:{name:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'},credentialRef:{type:'string',pattern:'^env:[A-Z][A-Z0-9_]{0,63}$'}}},
  composition:{type:'object',additionalProperties:false,required:['id','plugins'],properties:{id:{const:'workspace-readonly-v1'},plugins:{type:'array',uniqueItems:true,maxItems:3,items:{enum:WORKSPACE_PLUGINS}}}}
}};
