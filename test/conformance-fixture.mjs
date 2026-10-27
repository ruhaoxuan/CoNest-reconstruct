import {HarnessManager,HarnessRegistry} from '../dist/index.mjs';import {createTestProvider} from '../dist/testing.mjs';
export function configureFixture(t,provider,config,request,entered){
 const contexts=[],registry=new HarnessRegistry();registry.register({...provider,async createInstance(...args){const instance=await provider.createInstance(...args);return {...instance,async run(task,context){contexts.push(context);return instance.run(task,context);}};}});
 const manager=new HarnessManager(registry);for(const id of ['a','b'])manager.create({id,provider:provider.id,config:config(id),policy:{subjects:['test'],allow:['host:tools']}});
 t.after(()=>Promise.all(manager.list().map(i=>manager.stop(i.id,{graceMs:6000}))));return {manager,contexts,entered,request};
}
export async function syntheticFixture(t,scenario){const entered=Promise.withResolvers();const provider=createTestProvider('synthetic',{run(){entered.resolve();}});return configureFixture(t,provider,()=>({mode:scenario==='wait'?'wait':'echo',delayMs:5000}),runId=>({schemaVersion:2,runId,subject:'test',input:{type:'text',text:'CONFORMANCE_OK'},session:{mode:'ephemeral'}}),entered.promise);}
