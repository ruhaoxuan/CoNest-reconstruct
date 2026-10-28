import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {parseLabAction,parseSavedJob} from '../dist/lab/contracts.mjs';
import {labPage} from '../dist/lab/page.mjs';
test('lab action contract permits only owned scenarios and rejects external process, route or permission input',()=>{
 const id=randomUUID();assert.equal(parseLabAction({id,action:'run',instanceId:'a',scenario:'model-wait'}).id,id);
 for(const value of [{id,action:'terminate-worker',instanceId:'a',pid:1},{id,action:'run',instanceId:'a',scenario:'normal',baseURL:'https://other.invalid'},{id,action:'run',instanceId:'a',scenario:'normal',permissions:['shell']},{id,action:'cut-stream',runId:'../user'},{id,action:'__proto__'},{id,action:'acknowledge',instanceId:'a',runId:randomUUID(),token:randomUUID(),acceptRisk:'true'}])assert.throws(()=>parseLabAction(value),e=>e.code==='INVALID_REQUEST');
 assert.throws(()=>parseSavedJob({id,runId:id,instanceId:'a',scenario:'normal',state:'failed',executionState:'unknown',events:[{at:'bad date',type:'tool.returned'}]}));
});
test('lab page script enforces view-only controls and requires a fresh risk choice for a different fence',async()=>{
 // Script-level DOM model only: this is not a browser/visual acceptance claim.
 class Element{
  value='';textContent='';disabled=false;checked=false;dataset={};children=[];
  constructor(id=''){this.id=id;}
  append(...children){for(const child of children){this.children.push(child);if(['run','fence'].includes(this.id)&&this.children.length===1)this.value=child.value;}}
  replaceChildren(...children){this.children=[];if(['run','fence'].includes(this.id))this.value='';this.append(...children);}
  set innerHTML(_value){throw Error('Runtime evidence must use textContent');}
 }
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};get('scenario').value='normal';get('token').value='synthetic-script-only-token';
 const state={permissions:['lab:read'],coordinator:'ready',instances:[{id:'a',state:'ready',activeRuns:0,admissionBlocked:false},{id:'b',state:'ready',activeRuns:0,admissionBlocked:false}],jobs:[],fences:[],workers:{a:'ready',b:'ready'},modelReceipts:[],events:[]};
 const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element()},crypto:{randomUUID},setInterval(){},fetch:async(_url,options)=>{if(options.method==='POST'){const runId=randomUUID();state.jobs.push({instanceId:'a',runId,scenario:'normal',state:'running',executionState:'active',events:[],text:''});return {ok:true,json:async()=>({runId})};}return {ok:true,json:async()=>state};}});
 const html=labPage('synthetic-nonce'),script=html.match(/<script nonce="synthetic-nonce">([\s\S]*)<\/script>/)[1];
 new vm.Script(script).runInContext(context);await get('connect').onclick();assert.equal(get('runA').disabled,true);assert.equal(get('crash').disabled,true);
 state.permissions.push('lab:control');const old=randomUUID(),next=randomUUID();state.fences=[{instanceId:'a',runId:old,status:'uncertain',token:randomUUID()}];
 state.jobs=[{instanceId:'a',runId:old,scenario:'model-wait',state:'interrupted',executionState:'unknown',events:[],text:'<img src=x onerror=alert(1)>'}];
 vm.runInContext('render()',context);assert.equal(get('ack').disabled,true);get('risk').checked=true;get('risk').onchange();assert.equal(get('ack').disabled,false);
 state.fences=[{instanceId:'a',runId:next,status:'uncertain',token:randomUUID()}];vm.runInContext('render()',context);assert.equal(get('risk').checked,false);assert.equal(get('ack').disabled,true);
 assert.equal(get('jobs').children[0].children[2].textContent,'<img src=x onerror=alert(1)>');
 state.coordinator='exit-observed';vm.runInContext('render()',context);assert.equal(get('runA').disabled,true);assert.equal(get('restart').disabled,false);
 state.coordinator='ready';state.fences=[];vm.runInContext('render()',context);await get('runA').onclick();assert.equal(get('run').value,state.jobs.at(-1).runId,'A newly accepted run becomes the selected observation target');
});
