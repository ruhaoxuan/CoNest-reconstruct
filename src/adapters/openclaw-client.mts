import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { requireCondition } from '../contracts.mjs';
import type { GatewayClientConstructor } from './openclaw-types.mjs';

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** Only called by an explicitly enabled connection. No import or network side effects in core. */
export async function loadOpenClawClient(root:string):Promise<GatewayClientConstructor> {
  requireCondition(path.isAbsolute(root),'OPENCLAW_SUPPORT_MISMATCH','An absolute support root is required');
  const expected=await readFile(new URL('../../scripts/openclaw-client/package-lock.json',import.meta.url));
  const manifest=JSON.parse(await readFile(path.join(root,'openclaw-client-seal.json'),'utf8')) as {kind?:string;lockSha256?:string;files?:Record<string,string>};
  requireCondition(manifest.kind==='openclaw-client-2026.9.2-v4'&&manifest.lockSha256===sha(expected)&&manifest.files&&Object.keys(manifest.files).length<5000,'OPENCLAW_SUPPORT_MISMATCH','Optional client seal mismatch');
  requireCondition(sha(await readFile(path.join(root,'package-lock.json')))===sha(expected),'OPENCLAW_SUPPORT_MISMATCH','Optional dependency lock changed');
  const actual: string[]=[];
  async function walk(relative:string):Promise<void>{
    for(const e of await readdir(path.join(root,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+e.name:e.name;
      requireCondition(!e.isSymbolicLink(),'OPENCLAW_SUPPORT_MISMATCH','Symlinks are not allowed in the optional support pack');
      if(e.isDirectory())await walk(name);else if(name!=='openclaw-client-seal.json')actual.push(name);
    }
  }
  requireCondition(!(await lstat(path.join(root,'node_modules'))).isSymbolicLink(),'OPENCLAW_SUPPORT_MISMATCH','Shared dependencies are not allowed');
  await walk('');
  requireCondition(actual.length===Object.keys(manifest.files).length,'OPENCLAW_SUPPORT_MISMATCH','Optional client file set changed');
  for(const file of actual)requireCondition(manifest.files[file]===sha(await readFile(path.join(root,file))),'OPENCLAW_SUPPORT_MISMATCH','Optional client file changed');
  const lock=JSON.parse(expected.toString()) as {packages:Record<string,{version?:string}>};
  for(const [name,pin] of Object.entries(lock.packages)){
    if(!name)continue;
    const installed=JSON.parse(await readFile(path.join(root,name,'package.json'),'utf8')) as {version?:string};
    requireCondition(installed.version===pin.version,'OPENCLAW_SUPPORT_MISMATCH','Optional dependency version changed');
  }
  const require=createRequire(path.join(root,'package.json'));
  const module:unknown=await import(pathToFileURL(require.resolve('@openclaw/gateway-client')).href);
  requireCondition(module&&typeof module==='object'&&'GatewayClient' in module&&typeof module.GatewayClient==='function','OPENCLAW_SUPPORT_MISMATCH','Official public GatewayClient export is unavailable');
  return module.GatewayClient as GatewayClientConstructor;
}
