/** V1 custom submitTask hooks only. Built-in applications use validated V2 results. */
export function legacyStudioText(result:unknown):string{return typeof result==='object'&&result!==null&&'finalText' in result?String(result.finalText):JSON.stringify(result)??'';}
