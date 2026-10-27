import { parseDshResult, record } from './validation.mjs';
import { parseTaskResultV2, parseProgressV2 } from '../public-v2.mjs';
import type { TaskResultV2, ProgressV2 } from '../public-v2.mjs';
export function dshPublicResult(raw:unknown):TaskResultV2{
 const result=parseDshResult(raw);
 return parseTaskResultV2({schemaVersion:2,content:[{type:'text',text:result.finalText}],...(result.usage.inputTokens>0||result.usage.outputTokens>0?{usage:{source:'provider-reported',...(result.usage.inputTokens>0?{inputTokens:result.usage.inputTokens}:{}),...(result.usage.outputTokens>0?{outputTokens:result.usage.outputTokens}:{})}}:{})});
}
export function dshPublicProgress(raw:unknown):ProgressV2|undefined{
 const value=record(raw);if(value.kind!=='tool')return undefined;
 const {callId,name,status,preview,durationMs,previewTruncated,errorCode}=value;
 if(status==='running')return parseProgressV2({kind:'tool.started',callId,name});
 return parseProgressV2({kind:'tool.finished',callId,name,status,...(preview!==undefined?{preview}:{}),...(durationMs!==undefined?{durationMs}:{}),...(previewTruncated!==undefined?{previewTruncated}:{}),...(errorCode!==undefined?{errorCode}:{})});
}
