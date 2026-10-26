import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {HarnessRegistry,HarnessManager} from '../dist/index.mjs';
import {createEnvironmentCredentials} from '../dist/credentials.mjs';
import {createLiveStudioProviders} from '../dist/adapters/studio-live.mjs';
const registry=new HarnessRegistry(),credentials=createEnvironmentCredentials();
for(const entry of createLiveStudioProviders(path.resolve('.vendor/dsh-runtime'),credentials))registry.register(entry.provider);
const json=JSON.stringify(new HarnessManager(registry).configSchema(),null,2)+'\n';
const args=process.argv.slice(2);
if(args.length===2&&args[0]==='--out'){const file=path.resolve(args[1]);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,json);console.log(file);}
else if(!args.length)process.stdout.write(json);
else throw Error('Usage: node scripts/config-schema.mjs [--out file]');
