import {createServer,type ServerResponse} from 'node:http';
import {requireCondition} from '../contracts.mjs';
import type {ModelReceipt} from './contracts.mjs';
import {record,uuid,scenario} from './contracts.mjs';
/** No network forwarding. The only model is this owned localhost deterministic SSE service. */
export async function startLabModel(){
 const receipts:ModelReceipt[]=[],streams=new Map<string,ServerResponse>();
 const server=createServer(async(req,res)=>{
  try{
   requireCondition(req.method==='POST'&&req.url==='/chat/completions'&&req.headers.authorization==='Bearer synthetic-dsh-lab-key','LAB_MODEL_REQUEST','Unexpected fixture request');
   let body='';for await(const chunk of req){body+=String(chunk);requireCondition(Buffer.byteLength(body)<256000,'LAB_MODEL_REQUEST','Fixture input limit');}
   const input=record(JSON.parse(body));requireCondition(input.model==='deepseek-v4-flash'&&Array.isArray(input.messages)&&receipts.length<500,'LAB_MODEL_REQUEST','Invalid model request');
   const match=JSON.stringify(input.messages).match(/CONEST_LAB:([a-f0-9-]{36}):([a-z-]+)/);
   requireCondition(match,'LAB_MODEL_REQUEST','Lab task identity missing');const runId=uuid(match[1]),mode=scenario(match[2]);
   const receipt:ModelReceipt={runId,scenario:mode,at:new Date().toISOString(),stage:'streaming',iteration:receipts.filter(r=>r.runId===runId).length+1};receipts.push(receipt);
   res.once('close',()=>{if(receipt.stage==='streaming')receipt.stage='closed';if(streams.get(runId)===res)streams.delete(runId);});
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
   const send=(delta:unknown,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'local-lab',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
   const tool=input.messages.some(m=>record(m).role==='tool');
   if(mode==='model-wait'){streams.set(runId,res);send({role:'assistant',content:'LOCAL_PARTIAL_PREVIEW'});return;}
   if(mode==='partial-tool'){send({role:'assistant',tool_calls:[{index:0,id:'partial-'+runId,type:'function',function:{name:'lab_receipt',arguments:'{"value":'}}]});receipt.stage='ended';res.end();return;}
   if(mode==='tool-wait'&&!tool){send({role:'assistant',tool_calls:[{index:0,id:'receipt-'+runId,type:'function',function:{name:'lab_receipt',arguments:'{}'}}]});send({},'tool_calls');}
   else{send({role:'assistant',content:tool?'工具收据已返回，本次本地模型任务完成。':'真实 DSH 已通过本机 HTTP/SSE 完成本轮任务。'});send({},'stop');}
   receipt.stage='ended';res.end('data: [DONE]\n\n');
  }catch{if(!res.headersSent)res.writeHead(400);res.end();}
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();requireCondition(address&&typeof address==='object','LAB_START_FAILED','Model fixture address unavailable');
 return {url:`http://127.0.0.1:${address.port}`,receipts,
  cut(runId:string){const res=streams.get(runId);requireCondition(res,'LAB_STAGE','No waiting local model stream');res.destroy();},
  hasStream(runId:string){return streams.has(runId);},
  async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
 };
}
