import { mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireCondition } from '../contracts.mjs';
import { LocalStateStore } from '../state-store.mjs';
import { createEnvironmentCredentials } from '../credentials.mjs';
import { createLiveStudioProviders } from '../adapters/studio-live.mjs';
import { createProofStudioProviders } from '../adapters/studio-proof.mjs';
import { createStudioApplication, readStudioConfig } from './application.mjs';
import { startStudio } from './server.mjs';

const mode = process.env.CONEST_RECONSTRUCT_MODE ?? 'proof';
requireCondition(mode === 'proof' || mode === 'live', 'INVALID_CONFIG', 'Mode must be proof or live');
const credentials = createEnvironmentCredentials();
const state = path.resolve(process.env.CONEST_RECONSTRUCT_STATE ?? '.local/reconstruct-studio');
const port = Number(process.env.CONEST_RECONSTRUCT_PORT ?? 18801);
requireCondition(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_CONFIG', 'Invalid Studio port');
await mkdir(state, { recursive: true, mode: 0o700 });
// Respect older launchers which predate the SQLite lease as well.
let previousPid:unknown;
try{previousPid=(JSON.parse(await readFile(path.join(state,'connection.json'),'utf8')) as {pid?:unknown}).pid;}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
if(typeof previousPid==='number'&&Number.isInteger(previousPid)&&previousPid>0&&previousPid!==process.pid){
  let alive=true;try{process.kill(previousPid,0);}catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ESRCH')alive=false;}
  requireCondition(!alive,'STATE_IN_USE','Stop the previous coordinator or choose an independent state directory');
}
const configured = process.env.CONEST_RECONSTRUCT_CONFIG;
requireCondition(configured === undefined || configured.trim().length > 0, 'INVALID_CONFIG', 'Configuration path cannot be empty');
const configFile = path.resolve(configured ?? path.join(state, 'instances.json'));
requireCondition(mode !== 'live' || configured !== undefined, 'INVALID_CONFIG', 'Live mode requires an explicit instance config');
if (configured === undefined) {
  const workspace = path.join(state, 'workspace');await mkdir(workspace, { recursive: true });
  const initial = { schemaVersion: 1, instances: [{ id: 'dsh-demo', provider: 'dsh', providerConfigVersion: 1,
    policy: { subjects: ['studio'], allow: ['host:tools'] },
    control: { defaultRunTimeoutMs: 15000, maxRunTimeoutMs: 300000, stopGraceMs: 5000 },
    providerConfig: { workspaceRoot: await realpath(workspace), sessionPersistenceRoot: path.join(state, 'sessions') } }] };
  try { await writeFile(configFile, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
}
const runtime = path.resolve('.vendor/dsh-runtime');
const store = await LocalStateStore.open(state,text=>credentials.redact(text));
let studio:Awaited<ReturnType<typeof startStudio>>;
try {
  for(const reference of store.credentialRevocations())credentials.revoke!(reference);
  const definitions=mode==='live'?createLiveStudioProviders(runtime,credentials):createProofStudioProviders(runtime);
  const app=createStudioApplication(await readStudioConfig(configFile),definitions,
    {persistAuthorization:(id,record)=>store.saveAuthorization(id,record),onEvent:event=>store.record(event)});
  for(const [id,record] of Object.entries(store.authorizations()))if(app.manager.list().some(i=>i.id===id))app.manager.restoreAuthorization(id,record);
  for(const instance of app.manager.list())await store.saveAuthorization(instance.id,app.manager.authorization(instance.id));
  const token=randomUUID(),viewerToken=randomUUID();
  studio=await startStudio({...app,store,token,additionalTokens:[{token:viewerToken,permissions:['state:read']}],port,mode,redact:text=>credentials.redact(text),
    async credentialControl(reference,revoked){
      requireCondition(['env:DEEPSEEK_API_KEY'].includes(reference),'CREDENTIAL_REFERENCE_DENIED','Unsupported reference');
      await store.setCredentialRevoked(reference,revoked);if(revoked)credentials.revoke!(reference);else credentials.restore!(reference);
    }});
  const connectionFile=path.join(state,'connection.json');
  try{
    await writeFile(connectionFile,JSON.stringify({url:studio.url,token,mode,pid:process.pid},null,2)+'\n',{mode:0o600});
    await writeFile(path.join(state,'viewer-connection.json'),JSON.stringify({url:studio.url,token:viewerToken,mode,pid:process.pid,access:'read-only'},null,2)+'\n',{mode:0o600});
  }catch(error){await studio.close();throw error;}
  console.log(JSON.stringify({ready:true,url:studio.url,connectionFile,configFile,instances:app.manager.list().length,mode,modelRequests:mode==='live'?'on-task':'disabled'}));
} catch(error){store.close();throw error;}
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;try{await studio.close();process.exitCode=0;}catch{process.exitCode=1;console.error('Studio cleanup failed; inspect resource status before restarting');}};
process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
