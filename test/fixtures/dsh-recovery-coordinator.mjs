// Test-only coordinator: real SDK + trusted localhost model injection, synthetic credential only.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {LocalStateStore} from '../../dist/state-store.mjs';
import {createEnvironmentCredentials} from '../../dist/credentials.mjs';
import {createLiveStudioProviders} from '../../dist/adapters/studio-live.mjs';
import {createStudioApplicationV2} from '../../dist/studio/application.mjs';
import {startStudio} from '../../dist/studio/server.mjs';
const [root,baseURL]=process.argv.slice(2);
if(new URL(baseURL).hostname!=='127.0.0.1')throw Error('Local test endpoint required');
const store=await LocalStateStore.open(root);
const app=createStudioApplicationV2(await readFile(path.join(root,'instances.json'),'utf8'),createLiveStudioProviders(path.resolve('.vendor/dsh-runtime'),createEnvironmentCredentials({DEEPSEEK_API_KEY:'synthetic-recovery-key'}),{baseURL}),{
 executions:{save:record=>store.saveExecution(record),remove:(record,evidence)=>store.removeExecution(record,evidence)},onEvent:event=>store.record(event)
});
app.manager.restoreExecutions(store.executionFences());
const studio=await startStudio({...app,store,token:'synthetic-private-fixture-token-for-local-tests',port:0,mode:'live'});
process.send({url:studio.url});
process.once('SIGTERM',()=>{void studio.close().then(()=>process.exit(0),()=>process.exit(1));});
