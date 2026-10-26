import type { RuntimeClientConstructor } from './types.mjs';
import { NATIVE_DSH_PROTOCOL } from './native-protocol.mjs';
import { NativeDshClient } from './native-client.mjs';
import { record } from './validation.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requireCondition } from '../contracts.mjs';
/** Validate the native SDK support pack; management and IPC belong to this project. */
export async function loadPinnedClient(root:string):Promise<RuntimeClientConstructor>{
 const lock=record(JSON.parse(await readFile(new URL('../../runtime.lock.json',import.meta.url),'utf8')));
 requireCondition(lock.workerProtocol===NATIVE_DSH_PROTOCOL&&lock.runtimeKind==='native-dsh-v1','RUNTIME_MISMATCH','Unsupported native SDK protocol');
 const seal=record(JSON.parse(await readFile(path.join(root,'reconstruct-runtime.json'),'utf8')));
 requireCondition(seal.kind==='native-dsh-v1'&&seal.commit===lock.commit&&seal.sdkArchiveSha256===lock.sdkArchiveSha256,'RUNTIME_MISMATCH','Native DSH support provenance mismatch');
 const files=record(seal.files);requireCondition(files['dist/studio/cordis-bridge-host.js']&&files['dist/adapters/native-composition.js']&&files['scripts/maintenance/sdk.lock.json']===lock.sdkLockSha256,'RUNTIME_MISMATCH','Native SDK seal is incomplete');
 for(const [file,expected] of Object.entries(files)){
  requireCondition(!path.isAbsolute(file)&&!file.split(/[\\/]/).includes('..'),'RUNTIME_MISMATCH','Unsafe sealed path');
  requireCondition(createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')===expected,'RUNTIME_MISMATCH',`Native SDK drift: ${file}`);
 }
 const manifest=record(JSON.parse(await readFile(path.join(root,'package.json'),'utf8')));
 for(const group of ['dependencies','devDependencies','optionalDependencies'])for(const name of Object.keys(record(manifest[group]??{})))requireCondition(name.startsWith('@deepseek-ai/'),'RUNTIME_MISMATCH','Unexpected SDK support dependency');
 return class PinnedNativeDshClient extends NativeDshClient {constructor(options:ConstructorParameters<RuntimeClientConstructor>[0]){super(root,options);}};
}
