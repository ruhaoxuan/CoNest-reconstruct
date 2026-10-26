import type { RuntimeCall } from './types.mjs';
export const NATIVE_DSH_PROTOCOL = 1;
export interface NativeSetup { workspaceRoot: string; sessionPersistenceRoot: string; enableBridgeProofAdapter: boolean; modelRoute?: {apiKey?:string;baseURL?:string}; execution?:{maxParallelToolCalls:number} }
export interface NativeHost {
  start(setup: NativeSetup): Promise<void>;
  stop(): Promise<void>;
  runHarnessAgent(options: Record<string,unknown>): Promise<unknown>;
  endHarnessSession(options: Record<string,unknown>): Promise<void>;
}
export interface NativeRequest { kind:'call'; version:1; id:string; operation:RuntimeCall['operation']|'stop'; setup?:NativeSetup; args?:Record<string,unknown> }
export type NativeMessage = NativeRequest | {kind:'ready';version:1} | {kind:'abort';id:string} |
 {kind:'result';id:string;ok:boolean;value?:unknown} | {kind:'callback';id:string;parent:string;name:string;value:unknown} |
 {kind:'callback-result';id:string;ok:boolean;value?:unknown};
/** IPC belongs to a private child; validate its envelope and bound payloads regardless. */
export function nativeMessage(value:unknown): value is NativeMessage {
 if(!value||typeof value!=='object'||!('kind' in value))return false;
 const v=value as Record<string,unknown>;
 if(v.kind==='ready')return v.version===NATIVE_DSH_PROTOCOL;
 if(typeof v.id!=='string'||v.id.length>128)return false;
 if(v.kind==='abort')return true;
 if(v.kind==='call')return v.version===NATIVE_DSH_PROTOCOL&&['start','stop','runHarnessAgent','endHarnessSession'].includes(String(v.operation));
 if(v.kind==='result'||v.kind==='callback-result')return typeof v.ok==='boolean';
 return v.kind==='callback'&&typeof v.parent==='string'&&typeof v.name==='string'&&['tool','event','approval'].includes(v.name);
}
