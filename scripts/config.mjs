import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HarnessRegistry,parseConfig } from '../dist/index.mjs';
import { createDshProvider } from '../dist/adapters/dsh.mjs';
if(process.argv.length!==3) throw Error('Usage: node scripts/config.mjs /absolute/config.json');
const registry=new HarnessRegistry();
registry.register(createDshProvider({runtimeRoot:path.resolve('.vendor/dsh-runtime'),resolveTurn(){throw Error('Validation does not execute tasks');}}));
console.log(JSON.stringify(parseConfig(await readFile(process.argv[2],'utf8'),registry),null,2));
