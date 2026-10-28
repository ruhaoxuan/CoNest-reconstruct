import { requireCondition } from '../contracts.mjs';
import type { InstanceSnapshot } from '../types.mjs';
import type { ExecutionFence } from '../execution-journal.mjs';
export const SCENARIOS = ['normal','model-wait','partial-tool','tool-wait'] as const;
export type Scenario = typeof SCENARIOS[number];
export type Evidence = { at:string; type:string; runId?:string; instanceId?:string; callId?:string };
export type LabJob = {id:string;runId:string;instanceId:string;scenario:Scenario;state:string;text:string;executionState:string;events:Evidence[]};
export type CoordinatorSnapshot = {instances:InstanceSnapshot[];fences:ExecutionFence[];jobs:LabJob[];workers:Record<string,string>};
export type ModelReceipt = {runId:string;scenario:Scenario;at:string;stage:'streaming'|'ended'|'closed';iteration:number};
export type LabAction = {id:string;action:'run';instanceId:'a'|'b';scenario:Scenario}
 | {id:string;action:'cancel'|'release-tool'|'cut-stream';runId:string}
 | {id:string;action:'terminate-worker'|'restart-instance';instanceId:'a'|'b'}
 | {id:string;action:'crash-coordinator'|'restart-coordinator'}
 | {id:string;action:'acknowledge';instanceId:'a'|'b';runId:string;token:string;acceptRisk:boolean};
export function record(value:unknown):Record<string,unknown>{requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value),'INVALID_REQUEST','Expected object');return value as Record<string,unknown>;}
export function uuid(value:unknown):string{requireCondition(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value),'INVALID_REQUEST','Expected UUID');return value;}
export function scenario(value:unknown):Scenario{requireCondition(SCENARIOS.includes(value as Scenario),'INVALID_REQUEST','Unknown lab scenario');return value as Scenario;}
export function parseLabAction(value:unknown):LabAction{
 const v=record(value);uuid(v.id);
 const fields:Record<string,readonly string[]>={run:['instanceId','scenario'],cancel:['runId'],'cut-stream':['runId'],'release-tool':['runId'],'terminate-worker':['instanceId'],'restart-instance':['instanceId'],'crash-coordinator':[],'restart-coordinator':[],acknowledge:['instanceId','runId','token','acceptRisk']};
 requireCondition(typeof v.action==='string'&&Object.hasOwn(fields,v.action),'INVALID_REQUEST','Unknown lab action');
 const keys=['id','action',...fields[v.action]!];requireCondition(Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)),'INVALID_REQUEST','Unexpected action fields');
 if(keys.includes('instanceId'))requireCondition(v.instanceId==='a'||v.instanceId==='b','INVALID_REQUEST','Unknown lab instance');
 if(keys.includes('runId'))uuid(v.runId);if(keys.includes('scenario'))scenario(v.scenario);
 if(keys.includes('token')){uuid(v.token);requireCondition(typeof v.acceptRisk==='boolean','INVALID_REQUEST','Risk choice required');}
 return v as LabAction;
}
export function parseSavedJob(raw:unknown):LabJob{
 const v=record(raw);const runId=uuid(v.runId);requireCondition(v.id===runId&&(v.instanceId==='a'||v.instanceId==='b')&&typeof v.state==='string'&&typeof v.executionState==='string','STATE_INVALID','Invalid lab history');
 return {id:runId,runId,instanceId:v.instanceId,scenario:scenario(v.scenario),state:v.state,text:typeof v.text==='string'?v.text.slice(0,8000):'',executionState:v.executionState,events:Array.isArray(v.events)?v.events.slice(-100).map(raw=>{const e=record(raw);requireCondition(typeof e.at==='string'&&Number.isFinite(Date.parse(e.at))&&typeof e.type==='string'&&/^[a-z0-9.-]{1,80}$/.test(e.type),'STATE_INVALID','Invalid evidence');return {at:e.at,type:e.type,...(e.runId===runId?{runId}:{}),...(e.instanceId===v.instanceId?{instanceId:v.instanceId as string}:{}),...(typeof e.callId==='string'?{callId:e.callId.slice(0,512)}:{})};}):[]};
}
