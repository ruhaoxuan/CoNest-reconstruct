import path from 'node:path';
import {startDshFaultLab} from '../dist/lab/server.mjs';
const port=Number(process.env.CONEST_LAB_PORT??18807);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('CONEST_LAB_PORT must be 0..65535');
const lab=await startDshFaultLab({stateRoot:path.resolve(process.env.CONEST_LAB_STATE??'.local/dsh-fault-lab'),runtimeRoot:path.resolve('.vendor/dsh-runtime'),port});
console.log(JSON.stringify({ready:true,url:lab.url,connectionFile:lab.connectionFile,kind:'real-dsh-local-model-fault-lab',paidInference:false}));
let closing=false;const close=()=>{if(closing)return;closing=true;void lab.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;console.error('Lab cleanup failed; retain state for inspection');});};
process.once('SIGINT',close);process.once('SIGTERM',close);
