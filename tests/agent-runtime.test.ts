import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserPort, Observation, PlanStep, TaskInput } from '../src/contract.ts';
const done:PlanStep={thought:'Verified local control',action:{type:'finish',text:'Completed'}};
const input:TaskInput={prompt:'Select the local tab',profileId:'p',tabId:'t',agentScope:{areaId:'owned-area',origin:'https://example.test',expiresAt:new Date(Date.now()+600000).toISOString()}};
const observation:Observation={profileId:'p',tabId:'t',revision:1,url:'https://example.test/',title:'Local navigation',text:'Local tabs',capturedAt:'now',elements:[{ref:'r1',tag:'button',role:'tab',name:'Details',inputType:'',sensitive:false,interaction:{kind:'local'}}]};
async function until(predicate:()=>boolean){for(let n=0;n<500;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,3));}assert.fail('Agent task did not reach expected state');}

test('a delegated scope that expires inside model planning stops instead of asking for permission',async t=>{
 const root=await mkdtemp(join(tmpdir(),'agent-expiry-'));let clock=Date.now(),calls=0;
 t.mock.method(Date,'now',()=>clock);
 const scoped={...input,agentScope:{...input.agentScope!,expiresAt:new Date(clock+1000).toISOString()}};
 const runtime=new AgentRuntime({store:new RuntimeStore(root),browser:{observe:async()=>structuredClone(observation),execute:async(_a,context)=>{calls++;return{context,message:'Not allowed'};}},planner:{next:async()=>{clock+=2000;return{thought:'Late routine plan',action:{type:'click',ref:'r1'}};}},onChange:()=>{}});
 try{await runtime.initialize();await runtime.start(scoped);await until(()=>!runtime.snapshot().activeJobId||runtime.snapshot().jobs[0]!.status==='awaiting_approval');assert.equal(runtime.snapshot().jobs[0]!.status,'failed');assert.equal(calls,0);assert.equal(runtime.snapshot().jobs[0]!.approval,null);}
 finally{await runtime.shutdown();t.mock.restoreAll();await rm(root,{recursive:true,force:true});}
});

test('delegated task epochs survive persistence but restart never resumes their execution authority',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-restart-')),store=new RuntimeStore(root);
 const browser:BrowserPort={observe:async()=>structuredClone(observation),execute:async()=>{throw new Error('No execution');}};
 const runtime=new AgentRuntime({store,browser,planner:{next:async()=>new Promise<PlanStep>(()=>{})},onChange:()=>{}});
 let recovered:AgentRuntime|undefined;
 try{
  await runtime.initialize();await runtime.start({...input,executionEpoch:0});
  const saved=await store.load();assert.equal(saved.jobs[0]!.executionEpoch,0);assert.deepEqual(saved.jobs[0]!.agentScope,input.agentScope);
  recovered=new AgentRuntime({store,browser,planner:{next:async()=>{assert.fail('Restart must not resume a model');}},onChange:()=>{}});
  await recovered.initialize();assert.equal(recovered.snapshot().jobs[0]!.status,'interrupted');assert.equal(recovered.snapshot().activeJobId,null);
 }finally{await recovered?.shutdown();await runtime.shutdown();await rm(root,{recursive:true,force:true});}
});

test('a delegated agent task performs a trusted routine local click without a per-action approval',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-runtime-'));let calls=0,plans=0,approvals=0;
 const browser:BrowserPort={observe:async()=>structuredClone(observation),execute:async(action,context)=>{assert.equal(action.type,'click');calls++;return{context,message:'Selected local tab'};}};
 const runtime=new AgentRuntime({store:new RuntimeStore(root),browser,planner:{next:async()=>++plans===1?{thought:'Select observed local tab',action:{type:'click',ref:'r1'}}:done},onChange:s=>{if(s.jobs.some(j=>j.status==='awaiting_approval'))approvals++;}});
 try{await runtime.initialize();await runtime.start(input);await until(()=>!runtime.snapshot().activeJobId);assert.equal(runtime.snapshot().jobs[0]!.status,'completed');assert.equal(calls,1);assert.equal(approvals,0);}
 finally{await runtime.shutdown();await rm(root,{recursive:true,force:true});}
});
