import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessRegistry,HarnessManager} from '../dist/index.mjs';
import {createLiveStudioProviders} from '../dist/adapters/studio-live.mjs';
import {createEnvironmentCredentials} from '../dist/credentials.mjs';
import {ToolPluginRegistry} from '../dist/tool-plugins.mjs';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'publication-'));await mkdir(path.join(dir,'workspace'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registry=new HarnessRegistry();for(const entry of createLiveStudioProviders(dir,createEnvironmentCredentials({DEEPSEEK_API_KEY:'synthetic-publication-key'})))registry.register(entry.provider);
 const manager=new HarnessManager(registry);const raw={id:'a',provider:'dsh',providerConfigVersion:1,policy:{subjects:['studio'],allow:['workspace:read']},providerConfig:{workspaceRoot:path.join(dir,'workspace'),sessionPersistenceRoot:path.join(dir,'sessions'),model:{name:'deepseek-v4-flash',credentialRef:'env:DEEPSEEK_API_KEY'}}};
 return {registry,manager,raw};
}
test('exported configuration schema covers registered providers, lifecycle fields and trusted plugin IDs',async t=>{
 const {manager}=await fixture(t);const schema=manager.configSchema();assert.match(schema.$schema,/2020-12/);
 const dsh=schema.properties.instances.items.oneOf.find(v=>v.properties.provider.const==='dsh');
 assert.equal(dsh.properties.control.properties.startTimeoutMs.type,'integer');assert.equal(dsh.properties.policy.properties.tools.uniqueItems,true);
 assert.deepEqual(dsh.properties.providerConfig.properties.composition.properties.plugins.items.enum,['workspace.read','workspace.list','workspace.search']);
 assert.equal(dsh.properties.providerConfig.additionalProperties,false);
});
test('configuration-only plugin selection changes the actual published tool contract; new config cannot widen persisted tool authorization',async t=>{
 const {manager,registry,raw}=await fixture(t);manager.createConfigured({...raw,providerConfig:{...raw.providerConfig,composition:{id:'workspace-readonly-v1',plugins:['workspace.read']}}});
 const before=manager.snapshot('a').toolPublication;assert.deepEqual(before.tools.map(t=>t.name),['read_file']);const saved=manager.authorization('a');
 const next=new HarnessManager(registry);next.createConfigured(raw);next.restoreAuthorization('a',saved);
 assert.deepEqual(next.snapshot('a').toolPublication.tools.map(t=>t.name),['read_file']);
 assert.notEqual(manager.configured('a').revision,next.configured('a').revision);
 await next.updatePolicy('a',{subjects:['studio'],allow:['workspace:read'],deny:[]});assert.equal(next.snapshot('a').toolPublication.tools.length,3);
});
test('trusted plugin registry rejects duplicate tools, unknown IDs and missing dependencies',async()=>{
 const r=new ToolPluginRegistry();const tool={name:'read',description:'read',parameters:{type:'object'},permissions:['read']};
 r.register({id:'one',version:'1',requires:['two'],tools:[tool],async create(){return [];}});
 assert.throws(()=>r.publication(['one']),e=>e.code==='PLUGIN_DEPENDENCY');assert.throws(()=>r.publication(['unknown']),e=>e.code==='PLUGIN_NOT_FOUND');
 r.register({id:'two',version:'1',tools:[tool],async create(){return [];}});assert.throws(()=>r.publication(['one','two']),e=>e.code==='INVALID_PROVIDER');
});
