import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.vendor/conest');
const hash=x=>createHash('sha256').update(x).digest('hex');
const patches=[
 ['src/studio/composition.ts', s=>s.replace('export type CompositionOptions = {','export type CompositionOptions = {\n  execution?: { maxParallelToolCalls: number };').replace('maxParallelToolCalls: 4','maxParallelToolCalls: options.execution?.maxParallelToolCalls ?? 4')],
 ['src/studio/cordis-bridge-host.ts',s=>s.replaceAll('modelRoute?: { apiKey?: string; baseURL?: string };','modelRoute?: { apiKey?: string; baseURL?: string };\n    execution?: { maxParallelToolCalls: number };')],
];
const manifest={id:'config-parallel-v1',patches:[]};
for(const [file,patch] of patches){
 const expected=execFileSync('git',['-C',process.argv[2]??'/Users/keyako/rhx/2026/work/CoNest','show',`57e0f0dbf19ab3ec9c9c6f57d2484077524ec28b:${file}`],{encoding:'utf8'});
 const current=await readFile(path.join(root,file),'utf8');assert.equal(current,expected,'Source drift or overlay already applied');
 const changed=patch(current);assert.notEqual(changed,current);
 manifest.patches.push({file,before:hash(current),after:hash(changed),patchHash:hash(changed+'\n'+current)});
}
// Validate all originals before modifying any source.
for(const [file,patch] of patches) await writeFile(path.join(root,file),patch(await readFile(path.join(root,file),'utf8')));
execFileSync('pnpm',['build'],{cwd:root,stdio:'inherit'});
const seal=JSON.parse(await readFile(path.join(root,'reconstruct-runtime.json'),'utf8'));
async function walk(rel){for(const e of await readdir(path.join(root,rel),{withFileTypes:true})){const n=rel+'/'+e.name;if(e.isDirectory())await walk(n);else seal.files[n]=hash(await readFile(path.join(root,n)));}}
await walk('dist');seal.overlay=manifest;
await writeFile(path.join(root,'reconstruct-runtime.json'),JSON.stringify(seal,null,2)+'\n');
await writeFile('overlay-config.lock.json',JSON.stringify(manifest,null,2)+'\n');
console.log('Applied audited research overlay config-parallel-v1');
