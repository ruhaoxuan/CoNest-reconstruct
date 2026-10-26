import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {nativeMessage} from '../../dist/adapters/native-protocol.mjs';
test('native SDK support installs without an OpenClaw package, client or Gateway',async()=>{
 const root=path.resolve('.vendor/dsh-runtime'),require=createRequire(path.join(root,'package.json'));
 assert.throws(()=>require.resolve('openclaw'),error=>error.code==='MODULE_NOT_FOUND');
 assert(!(await readdir(path.join(root,'node_modules/.pnpm'))).some(name=>/^openclaw@/.test(name)));
 const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 assert(Object.keys({...manifest.dependencies,...manifest.devDependencies}).every(name=>name.startsWith('@deepseek-ai/')));
 const composition=await readFile(path.join(root,'dist/adapters/native-composition.js'),'utf8');
 assert.doesNotMatch(composition,/openclaw|SandboxedFileSystem|ToolBash|ShellEnv/);
 const host=await readFile(path.join(root,'dist/studio/cordis-bridge-host.js'),'utf8');
 assert.doesNotMatch(host,/(?:import|from).*openclaw/);
 assert.match(host,/const generatedComposition = \{ tools: \[\] \}/);
});
test('private DSH IPC rejects unrecognized operations and malformed callback envelopes',()=>{
 assert.equal(nativeMessage({kind:'call',version:1,id:'test',operation:'gateway.start'}),false);
 assert.equal(nativeMessage({kind:'call',version:2,id:'test',operation:'start'}),false);
 assert.equal(nativeMessage({kind:'callback',id:'x',parent:'task',name:'shell',value:{}}),false);
 assert.equal(nativeMessage({kind:'callback',id:'x',parent:'task',name:'tool',value:{}}),true);
});
