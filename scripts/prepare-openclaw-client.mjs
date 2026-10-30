import {mkdir,readFile,writeFile,readdir,lstat,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const project=fileURLToPath(new URL('../',import.meta.url));
const root=path.join(project,'.vendor/openclaw-client');
assert.equal(process.argv.length,2,'Preparation takes no path, package or version overrides');
await mkdir(path.dirname(root),{recursive:true});
await mkdir(root); // Refuse all existing state, including an incomplete installation.
for(const name of ['package.json','package-lock.json'])await copyFile(path.join(project,'scripts/openclaw-client',name),path.join(root,name));
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const names=Object.keys(lock.packages).filter(Boolean);
assert.deepEqual(names.sort(),['node_modules/@openclaw/gateway-client','node_modules/@openclaw/gateway-protocol','node_modules/ipaddr.js','node_modules/typebox','node_modules/ws'].sort());
for(const name of names){const pin=lock.packages[name];assert(pin.integrity?.startsWith('sha512-'));assert(pin.resolved?.startsWith('https://registry.npmjs.org/'));}
const require=createRequire(import.meta.url);
const npm=process.env.npm_execpath??require.resolve('npm/bin/npm-cli.js');
assert(path.isAbsolute(npm),'Run this preparation using npm run prepare:openclaw');
execFileSync(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--omit=optional','--workspaces=false'],{cwd:root,stdio:'inherit',env:{...process.env,npm_config_update_notifier:'false'}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={};
async function walk(relative){for(const e of await readdir(path.join(root,relative),{withFileTypes:true})){
 const name=relative?relative+'/'+e.name:e.name;assert(!e.isSymbolicLink(),'Support pack must not share dependencies');
 if(e.isDirectory())await walk(name);else files[name]=sha(await readFile(path.join(root,name)));
}}
assert(!(await lstat(path.join(root,'node_modules'))).isSymbolicLink());await walk('');
await writeFile(path.join(root,'openclaw-client-seal.json'),JSON.stringify({kind:'openclaw-client-2026.9.2-v4',lockSha256:sha(await readFile(path.join(root,'package-lock.json'))),files},null,2)+'\n');
console.log('Prepared optional official OpenClaw client 2026.9.2 + protocol v4; no Gateway installed or started.');
