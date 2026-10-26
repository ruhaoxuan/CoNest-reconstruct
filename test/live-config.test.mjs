import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnvironmentCredentials } from '../dist/credentials.mjs';
import { createLiveStudioProviders } from '../dist/adapters/studio-live.mjs';
import { createProofStudioProviders } from '../dist/adapters/studio-proof.mjs';
import { createStudioApplication } from '../dist/studio/application.mjs';

test('credential service only resolves allowlisted references and redacts values after rotation', () => {
  const env = { DEEPSEEK_API_KEY: 'synthetic-secret-one', OTHER_SECRET: 'private' }, service = createEnvironmentCredentials(env);
  assert.equal(service.resolve('env:DEEPSEEK_API_KEY'), env.DEEPSEEK_API_KEY);
  assert.throws(() => service.resolve('env:OTHER_SECRET'), e => e.code === 'CREDENTIAL_REFERENCE_DENIED');
  env.DEEPSEEK_API_KEY = 'synthetic-secret-two';
  assert.equal(service.redact('synthetic-secret-one synthetic-secret-two'), '[REDACTED] [REDACTED]');
  assert.throws(() => createEnvironmentCredentials({}).resolve('env:DEEPSEEK_API_KEY'), e => e.code === 'CREDENTIAL_UNAVAILABLE');
});
test('live config accepts references only; missing credentials, unsupported models and proof/live confusion fail locally', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'live-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises'); const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const instance = { id: 'live', provider: 'dsh', providerConfigVersion: 1, policy: { subjects: ['studio'], allow: ['workspace:read'] },
    providerConfig: { workspaceRoot: workspace, sessionPersistenceRoot: path.join(root, 'sessions'),
      model: { name: 'deepseek-v4-flash', credentialRef: 'env:DEEPSEEK_API_KEY' } } };
  const text = value => JSON.stringify({ schemaVersion: 1, instances: [value] });
  const service = createEnvironmentCredentials({ DEEPSEEK_API_KEY: 'synthetic-config-secret' });
  const definitions = createLiveStudioProviders(root, service);
  const app = createStudioApplication(text(instance), definitions);
  assert.equal(app.manager.snapshot('live').state, 'stopped');
  assert.doesNotMatch(JSON.stringify(app.manager.list()), /synthetic-config-secret/);
  assert.throws(() => createStudioApplication(text(instance), createLiveStudioProviders(root, createEnvironmentCredentials({}))), e => e.code === 'CREDENTIAL_UNAVAILABLE');
  assert.throws(() => createStudioApplication(text(instance), createProofStudioProviders(root)));
  for (const model of [{ ...instance.providerConfig.model, apiKey: 'forbidden' }, { name: 'unlisted', credentialRef: 'env:DEEPSEEK_API_KEY' },
    { name: 'deepseek-v4-flash', credentialRef: 'env:OTHER_SECRET' }]) {
    assert.throws(() => createStudioApplication(text({ ...instance, providerConfig: { ...instance.providerConfig, model } }), definitions));
  }
});

test('live workspaces cannot overlap another instance or any session store',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'live-roots-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {mkdir}=await import('node:fs/promises');const a=path.join(root,'a'),b=path.join(root,'b');await mkdir(a);await mkdir(b);
  const instance=(id,workspaceRoot,sessionPersistenceRoot)=>({id,provider:'dsh',providerConfigVersion:1,policy:{subjects:['studio'],allow:['workspace:read']},
    providerConfig:{workspaceRoot,sessionPersistenceRoot,model:{name:'deepseek-v4-flash',credentialRef:'env:DEEPSEEK_API_KEY'}}});
  const defs=createLiveStudioProviders(root,createEnvironmentCredentials({DEEPSEEK_API_KEY:'synthetic-root-secret'}));
  for(const instances of [[instance('a',a,path.join(root,'s1')),instance('b',a,path.join(root,'s2'))],
    [instance('a',a,path.join(a,'sessions'))],[instance('a',root,path.join(root,'sessions'))]]) {
    assert.throws(()=>createStudioApplication(JSON.stringify({schemaVersion:1,instances}),defs),/must not overlap/);
  }
  assert.equal(createStudioApplication(JSON.stringify({schemaVersion:1,instances:[instance('a',a,path.join(root,'s1')),instance('b',b,path.join(root,'s2'))]}),defs).manager.list().length,2);
});
