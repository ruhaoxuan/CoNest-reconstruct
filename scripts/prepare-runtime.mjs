import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const lock=JSON.parse(await readFile('runtime.lock.json','utf8'));
const source=process.argv[2];assert(source,'Usage: node scripts/prepare-runtime.mjs /path/to/pinned/CoNest [--archive /path/to/sdk.tar.gz]');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=args=>execFileSync('git',['-C',path.resolve(source),...args],{maxBuffer:20000000});
// Read the exact committed reference, never its working tree, SDK or node_modules.
assert.equal(git(['rev-parse',lock.commit]).toString().trim(),lock.commit);
const original=name=>git(['show',`${lock.commit}:${name}`]).toString();
const root=path.resolve('.vendor/dsh-runtime');await mkdir('.vendor',{recursive:true});
const rebuild=process.argv.includes('--rebuild');
if(rebuild){const seal=JSON.parse(await readFile(path.join(root,'reconstruct-runtime.json'),'utf8'));assert.equal(seal.kind,'native-dsh-v1');assert.equal(seal.commit,lock.commit);for(const file of ['package.json','pnpm-lock.yaml','scripts/maintenance/sdk.lock.json'])assert.equal(sha(await readFile(path.join(root,file))),seal.files[file]);}
else {try{await lstat(root);throw Error('Runtime destination exists; use --rebuild for a recognized native support pack');}catch(e){if(e.code!=='ENOENT')throw e;}await mkdir(root);}
async function put(name,text){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
const sdkText=original('scripts/maintenance/sdk.lock.json');assert.equal(sha(sdkText),lock.sdkLockSha256);
const sdk=JSON.parse(sdkText);assert.equal(sdk.sha256,lock.sdkArchiveSha256);
const dependencyLock=original('pnpm-lock.yaml');assert.equal(sha(dependencyLock),lock.pnpmLockSha256);
await put('scripts/maintenance/bootstrap.mjs',original('scripts/maintenance/bootstrap.mjs'));await put('scripts/maintenance/sdk.lock.json',sdkText);
const archiveIndex=process.argv.indexOf('--archive'),bootstrap=['scripts/maintenance/bootstrap.mjs'];
if(archiveIndex>=0){assert(process.argv[archiveIndex+1]);bootstrap.push('--archive',path.resolve(process.argv[archiveIndex+1]));}
execFileSync(process.execPath,bootstrap,{cwd:root,stdio:'inherit'});
const needed=new Set(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-llm-pi-ai','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-session-persistence-jsonl','@deepseek-ai/dsh-session-checkpoint-policy','@deepseek-ai/dsh-attachment-local','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-user-approval']);
for(const name of needed){assert(sdk.packages[name],`Missing pinned SDK package ${name}`);const pkg=JSON.parse(await readFile(path.join(root,'.vendor/dsh',sdk.packages[name].directory,'package.json'),'utf8'));for(const dep of Object.keys({...pkg.dependencies,...pkg.peerDependencies}))if(sdk.packages[dep])needed.add(dep);}
const originalPackage=JSON.parse(original('package.json'));const pkg={name:'conest-native-dsh-support',version:'1.0.0',private:true,type:'module',packageManager:lock.packageManager,dependencies:{},devDependencies:{}};
for(const field of ['dependencies','devDependencies'])for(const [name,spec] of Object.entries(originalPackage[field]??{}))if(needed.has(name))pkg[field][name]=spec;
for(const name of needed)assert(pkg.dependencies[name]||pkg.devDependencies[name],`SDK package absent from frozen importer: ${name}`);
await put('package.json',JSON.stringify(pkg,null,2)+'\n');
// Keep exact upstream package snapshots/integrities, selecting only the native SDK importer.
const start=dependencyLock.indexOf('  .:\n'),end=dependencyLock.indexOf('\npackages:',start);assert(start>=0&&end>start);
let section='',rootImporter='  .:\n';
for(const line of dependencyLock.slice(start+5,end).split('\n')){
 const header=line.match(/^    (dependencies|devDependencies|optionalDependencies):$/);if(header){section=header[1];continue;}
 const item=line.match(/^      (?:'([^']+)'|([^\s:][^:]*)):/);if(item){section=section.split(':')[0];const name=item[1]??item[2];section=section+':'+name;}
 const [field,name]=section.split(':');if(name&&needed.has(name)){
  const previous=rootImporter.split('\n').filter(x=>/^    [a-zA-Z]+:$/.test(x)).at(-1);
  if(previous!==`    ${field}:`)rootImporter+=`    ${field}:\n`;
  rootImporter+=line+'\n';
 }
}
await put('pnpm-lock.yaml',dependencyLock.slice(0,start)+rootImporter+dependencyLock.slice(end));
await put('pnpm-workspace.yaml',original('pnpm-workspace.yaml').replace('  openclaw: true\n',''));
await put('patches/node-pty@1.1.0.patch',original('patches/node-pty@1.1.0.patch'));
assert.equal(execFileSync('pnpm',['--version'],{cwd:root,encoding:'utf8'}).trim(),'11.7.0');
if(!rebuild)execFileSync('pnpm',['install','--frozen-lockfile'],{cwd:root,stdio:'inherit'});
const selected={};async function compile(name,text=original(name),target=name){selected[name]=sha(original(name));await put(target,text);await put('dist/'+target.replace(/^src\//,'').replace(/\.ts$/,'.js'),ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText);}
for(const name of ['dsh-cordis','dsh-agent','dsh-approval','dsh-llm','dsh-session','dsh-tools'])await compile(`src/adapters/${name}.ts`);
await compile('src/studio/proof-llm-adapter.ts',original('src/studio/proof-llm-adapter.ts').replaceAll('OpenClaw','CoNest'));
await compile('src/studio/agent-error.ts');
let host=original('src/studio/cordis-bridge-host.ts');
// The retained implementation is only native DSH session/loop handling. No SDK host types,
// filesystem bridge operations, name aliases or Gateway lifecycle are exposed.
host=host.replace(/^import type \{ AnyAgentTool \}.*\n/m,'type AnyAgentTool = {name:string;description:string;parameters:Record<string,unknown>;execute:(id:string,args:unknown,signal:AbortSignal)=>Promise<unknown>};\n');
host=host.replace(/^import type \{ ReadObservation \}.*\n/m,'');
host=host.replace(/^import \{ generatedComposition \}.*\n/m,'const generatedComposition = {tools: [] as {dshName:string}[]};\n');
const methodsStart=host.indexOf('  /** Accept only trusted worker observations'),methodsEnd=host.indexOf('  async runHarnessAgent(');assert(methodsStart>0&&methodsEnd>methodsStart);host=host.slice(0,methodsStart)+host.slice(methodsEnd);
host=host.replace('const required = ["bash"];','const required: string[] = [];');
host=host.replace('./composition.js','../adapters/native-composition.js');
host=host.replaceAll('OpenClaw','CoNest').replaceAll('mapCoNestToolName','mapHostToolName');
// Persisted session IDs are deliberately preserved; changing them is a separate migration.
host=host.replaceAll('    modelRoute?: { apiKey?: string; baseURL?: string };','    modelRoute?: { apiKey?: string; baseURL?: string };\n    execution?: {maxParallelToolCalls:number};');
await compile('src/studio/cordis-bridge-host.ts',host);
let composition=original('src/studio/composition.ts');
const importsEnd=composition.indexOf('export type RunningComposition');
composition=`import {Context,settleFiber,type Fiber} from '../adapters/dsh-cordis.js';
import {AgentRegistry} from '../adapters/dsh-agent.js';
import {ApprovalService} from '../adapters/dsh-approval.js';
import {LlmRuntime} from '../adapters/dsh-llm.js';
import {SessionStore} from '../adapters/dsh-session.js';
import {ToolRuntime} from '../adapters/dsh-tools.js';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai';
import * as JsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl';
const JsonlSessionPersistence = Reflect.get(JsonlModule,'default') ?? JsonlModule;
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import {registerBridgeProofAdapter} from './proof-llm-adapter.js';
import path from 'node:path';\n`+composition.slice(importsEnd);
composition=composition.replace('  modelRoute?: { apiKey?: string; baseURL?: string };','  modelRoute?: { apiKey?: string; baseURL?: string };\n  execution?: {maxParallelToolCalls:number};');
const fsStart=composition.indexOf('    // One policy controls'),fsEnd=composition.indexOf('    fibers.push(\n      await settleFiber(context.plugin(JsonlSessionPersistence',fsStart);assert(fsStart>0&&fsEnd>fsStart);composition=composition.slice(0,fsStart)+composition.slice(fsEnd);
composition=composition.replace('maxParallelToolCalls: 4','maxParallelToolCalls: options.execution?.maxParallelToolCalls ?? 4').replaceAll('OpenClaw','CoNest').replace('filesystem and sandboxed Bash','admitted host tools');
composition=composition.replaceAll("'../adapters/","'./").replace("'./proof-llm-adapter.js'","'../studio/proof-llm-adapter.js'");
await compile('src/studio/composition.ts',composition,'src/adapters/native-composition.ts');
await put('LICENSE.upstream',original('LICENSE'));
await put('NOTICE','Native DSH support code adapted from '+lock.repository+' @ '+lock.commit+'.\nOnly DSH session/composition helpers are retained; no OpenClaw package or service is installed.\n');
const files={};async function walk(relative){for(const e of await readdir(path.join(root,relative),{withFileTypes:true})){const name=relative+'/'+e.name;if(e.isDirectory())await walk(name);else{assert(!e.isSymbolicLink());files[name]=sha(await readFile(path.join(root,name)));}}}
await walk('dist');for(const name of ['package.json','pnpm-lock.yaml','scripts/maintenance/sdk.lock.json'])files[name]=sha(await readFile(path.join(root,name)));
await put('reconstruct-runtime.json',JSON.stringify({kind:'native-dsh-v1',commit:lock.commit,sdkArchiveSha256:lock.sdkArchiveSha256,sourceFiles:selected,files},null,2)+'\n');
console.log(`Prepared native DSH support: ${needed.size} SDK packages; no OpenClaw dependency; ${root}`);
