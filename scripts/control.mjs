import {readFile} from 'node:fs/promises';
import {HarnessRpcClient} from '../dist/rpc.mjs';
const [connectionFile,method,raw='{}']=process.argv.slice(2);
if(!connectionFile||!method)throw Error('Usage: node scripts/control.mjs connection.json method [JSON params]');
const connection=JSON.parse(await readFile(connectionFile,'utf8'));
if(typeof connection.url!=='string'||typeof connection.token!=='string')throw Error('Invalid workbench connection file');
const client=new HarnessRpcClient(connection.url.replace(/\/$/,'')+'/rpc',()=>connection.token);
try{console.log(JSON.stringify(await client.request(method,JSON.parse(raw)),null,2));}catch(error){console.error(error.code??'CONTROL_FAILED');process.exitCode=1;}
