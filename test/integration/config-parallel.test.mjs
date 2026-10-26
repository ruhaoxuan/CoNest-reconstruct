import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadPinnedClient } from '../../dist/adapters/pinned-runtime.mjs';
test('audited composition parameters change actual DSH parallel tool execution', {timeout:30000}, async t=>{
 const runtime=path.resolve('.vendor/conest');await loadPinnedClient(runtime);
 const {CordisBridgeHost}=await import(pathToFileURL(path.join(runtime,'dist/studio/host-runtime.js')).href);
 const {LlmAdapter}=await import(pathToFileURL(path.join(runtime,'dist/adapters/dsh-llm.js')).href);
 for(const parallel of [1,2]){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'config-parallel-')));const host=new CordisBridgeHost();
  try{
   await host.start({workspaceRoot:root,sessionPersistenceRoot:path.join(root,'sessions'),execution:{maxParallelToolCalls:parallel}});
   const context=host.composition.context; // Test-only instrumentation of the fixed upstream class.
   assert.equal(context.agentLoop.config.maxParallelToolCalls,parallel);
   class Model extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id};}
    async *stream(input){
     if(input.messages.some(m=>m.role==='tool'||m.content?.some(b=>b.type==='tool-result'))){
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,textDelta:'DONE'};
      yield {type:'block-end',index:0,block:{type:'text',text:'DONE'}};yield {type:'finish',reason:{kind:'stop'}};return;
     }
     for(let index=0;index<2;index++){const id='parallel-'+index;
      yield {type:'block-start',index,blockType:'tool-call'};yield {type:'tool-call-delta',index,id,name:'parallel-tool',argumentsDelta:'{}'};
      yield {type:'block-end',index,block:{type:'tool-call',id,name:'parallel-tool',arguments:'{}'}};
     }yield {type:'finish',reason:{kind:'tool-calls'}};
    }
   }
   context.llm.registerAdapter(['parallel-proof'],new Model());let active=0,peak=0,calls=0;
   const dispose = context.tools.register({name:'parallel-tool',description:'Synthetic read-only safe tool',parameters:{},
    output:{schema:{},render:()=>[{type:'text',text:'ok'}]},isConcurrencySafe:()=>true,
    async execute(){calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,60));active--;return {};}});
   try { await host.runHarnessAgent({task:'parallel',sessionKey:'s',provider:'parallel-proof',model:'test',timeoutMs:10000,
    toolPolicy:{allow:['parallel-tool']}}); } finally { dispose(); }
   assert.equal(calls,2);assert.equal(peak,parallel);
  }finally{await host.stop();await rm(root,{recursive:true,force:true});}
 }
});
