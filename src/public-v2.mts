import { HarnessError, freeze, identifier, milliseconds, names, requireCondition } from './contracts.mjs';
export const PUBLIC_CONTRACT_VERSION=2;
export type JsonValue=null|boolean|number|string|readonly JsonValue[]|{readonly [key:string]:JsonValue};
export type ContentV2={readonly type:'text';readonly text:string}|{readonly type:'json';readonly value:JsonValue};
export interface TaskResultV2 {readonly schemaVersion:2;readonly content:readonly ContentV2[];readonly usage?:{readonly inputTokens?:number;readonly outputTokens?:number;readonly source:'provider-reported'|'estimated'}}
export type ProgressV2={readonly kind:'text.delta';readonly text:string}|
 {readonly kind:'tool.started';readonly callId:string;readonly name:string}|
 {readonly kind:'tool.finished';readonly callId:string;readonly name:string;readonly status:'completed'|'failed'|'cancelled';readonly preview?:string;readonly durationMs?:number;readonly previewTruncated?:boolean;readonly errorCode?:string}|
 {readonly kind:'notice';readonly code:string};
export interface TaskRequestV2 {readonly schemaVersion:2;readonly runId:string;readonly subject:string;readonly input:{readonly type:'text';readonly text:string};readonly permissions?:readonly string[];readonly timeoutMs?:number;readonly session:{readonly mode:'ephemeral'};readonly requirements?:{readonly mediatedTools?:true;readonly confirmedCancellation?:true}}
function object(value:unknown,allowed:readonly string[]):Record<string,unknown>{requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value),'INVALID_PROVIDER_RESULT','Expected public object');const v=value as Record<string,unknown>;requireCondition(Object.keys(v).every(k=>allowed.includes(k)),'INVALID_PROVIDER_RESULT','Unknown public field');return v;}
function bounded(value:unknown,max:number):asserts value is string{requireCondition(typeof value==='string'&&Buffer.byteLength(value)<=max,'INVALID_PROVIDER_RESULT','Public text exceeds limit');}
function json(value:unknown,depth=0,budget={nodes:0,bytes:0}):asserts value is JsonValue {
 requireCondition(++budget.nodes<=10000&&depth<=16,'INVALID_PROVIDER_RESULT','Public JSON exceeds limit');
 if(typeof value==='string'){budget.bytes+=Buffer.byteLength(value);requireCondition(budget.bytes<=128000,'INVALID_PROVIDER_RESULT','Public JSON exceeds byte limit');return;}
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='number'){requireCondition(Number.isFinite(value),'INVALID_PROVIDER_RESULT','Non-finite public JSON');return;}
 requireCondition(typeof value==='object'&&value!==null&&(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'INVALID_PROVIDER_RESULT','Non-JSON public value');
 if(!Array.isArray(value))for(const key of Object.keys(value)){budget.bytes+=Buffer.byteLength(key);requireCondition(budget.bytes<=128000,'INVALID_PROVIDER_RESULT','Public JSON exceeds byte limit');}
 for(const item of Array.isArray(value)?value:Object.values(value))json(item,depth+1,budget);
}
function resultV2(raw:unknown):TaskResultV2 {
 const v=object(raw,['schemaVersion','content','usage']);requireCondition(v.schemaVersion===2&&Array.isArray(v.content)&&v.content.length<=64,'INVALID_PROVIDER_RESULT','Invalid public result');
 for(const rawItem of v.content){const item=object(rawItem,['type','text','value']);if(item.type==='text'){requireCondition(!('value'in item),'INVALID_PROVIDER_RESULT','Invalid text content');bounded(item.text,64000);}else{requireCondition(item.type==='json'&&!('text'in item)&&'value'in item,'INVALID_PROVIDER_RESULT','Invalid content type');json(item.value);}}
 if(v.usage!==undefined){const u=object(v.usage,['source','inputTokens','outputTokens']);requireCondition(u.source==='provider-reported'||u.source==='estimated','INVALID_PROVIDER_RESULT','Invalid usage source');for(const key of ['inputTokens','outputTokens'])if(u[key]!==undefined)requireCondition(typeof u[key]==='number'&&Number.isFinite(u[key])&&u[key]>=0,'INVALID_PROVIDER_RESULT','Invalid token count');}
 requireCondition(Buffer.byteLength(JSON.stringify(v))<=128000,'INVALID_PROVIDER_RESULT','Public result exceeds limit');return freeze(structuredClone(v)) as unknown as TaskResultV2;
}
function progressV2(raw:unknown):ProgressV2 {
 const v=object(raw,['kind','text','callId','name','status','preview','durationMs','previewTruncated','errorCode','code']);
 const fields:Record<string,readonly string[]>={'text.delta':['kind','text'],'tool.started':['kind','callId','name'],'tool.finished':['kind','callId','name','status','preview','durationMs','previewTruncated','errorCode'],notice:['kind','code']};
 requireCondition(typeof v.kind==='string'&&Object.hasOwn(fields,v.kind)&&Object.keys(v).every(k=>fields[v.kind as string]!.includes(k)),'INVALID_PROVIDER_EVENT','Invalid public progress');
 if(v.kind==='text.delta')bounded(v.text,8000);
 if(v.kind==='notice')requireCondition(typeof v.code==='string'&&/^[A-Z_]{1,64}$/.test(v.code),'INVALID_PROVIDER_EVENT','Invalid notice code');
 if(v.kind==='tool.started'||v.kind==='tool.finished'){bounded(v.callId,128);bounded(v.name,128);requireCondition(Boolean(v.callId&&v.name),'INVALID_PROVIDER_EVENT','Tool identity missing');}
 if(v.kind==='tool.finished'){requireCondition(['completed','failed','cancelled'].includes(String(v.status)),'INVALID_PROVIDER_EVENT','Invalid tool status');if(v.preview!==undefined)bounded(v.preview,8000);if(v.durationMs!==undefined)requireCondition(typeof v.durationMs==='number'&&Number.isFinite(v.durationMs)&&v.durationMs>=0,'INVALID_PROVIDER_EVENT','Invalid duration');if(v.previewTruncated!==undefined)requireCondition(typeof v.previewTruncated==='boolean','INVALID_PROVIDER_EVENT','Invalid preview flag');if(v.errorCode!==undefined)requireCondition(typeof v.errorCode==='string'&&/^[A-Z_]{1,64}$/.test(v.errorCode),'INVALID_PROVIDER_EVENT','Invalid error code');}
 return freeze(structuredClone(v)) as unknown as ProgressV2;
}
/** First runtime increment intentionally rejects continuing sessions and interactive tools. */
function requestV2(raw:unknown):TaskRequestV2 {
 const v=object(raw,['schemaVersion','runId','subject','input','permissions','timeoutMs','session','requirements']);requireCondition(v.schemaVersion===2,'PROTOCOL_MISMATCH','Expected public task V2');identifier(v.runId,'runId');identifier(v.subject,'subject');const input=object(v.input,['type','text']);requireCondition(input.type==='text','UNSUPPORTED_CAPABILITY','Only text input is supported');bounded(input.text,64000);
 const session=object(v.session,['mode','id','epoch']);requireCondition(session.mode==='ephemeral','UNSUPPORTED_CAPABILITY','Continuing sessions are not implemented in this increment');requireCondition(Object.keys(session).length===1,'INVALID_REQUEST','Ephemeral sessions cannot select a native session');if(v.permissions!==undefined)names(v.permissions,'permissions');if(v.timeoutMs!==undefined)milliseconds(v.timeoutMs,'timeoutMs');
 if(v.requirements!==undefined){const r=object(v.requirements,['mediatedTools','confirmedCancellation']);requireCondition(Object.values(r).every(value=>value===true),'INVALID_REQUEST','Requirements must be explicit true');requireCondition(r.confirmedCancellation!==true,'UNSUPPORTED_CAPABILITY','Confirmed cancellation is not advertised by this entry');}
 return freeze(structuredClone(v)) as unknown as TaskRequestV2;
}
export function publicText(result:TaskResultV2):string{return result.content.map(item=>item.type==='text'?item.text:JSON.stringify(item.value)).join('\n');}

function checked<T>(code:string,work:()=>T,preserve:readonly string[]=[]):T{try{return work();}catch(cause){if(cause instanceof HarnessError&&preserve.includes(cause.code))throw cause;throw new HarnessError(code,'Public contract validation failed');}}
export function parseTaskResultV2(raw:unknown):TaskResultV2{return checked('INVALID_PROVIDER_RESULT',()=>resultV2(raw));}
export function parseProgressV2(raw:unknown):ProgressV2{return checked('INVALID_PROVIDER_EVENT',()=>progressV2(raw));}
export function parseTaskRequestV2(raw:unknown):TaskRequestV2{return checked('INVALID_REQUEST',()=>requestV2(raw),['PROTOCOL_MISMATCH','UNSUPPORTED_CAPABILITY']);}
