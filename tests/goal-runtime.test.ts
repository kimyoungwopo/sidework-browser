import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRuntime} from '../src/core/runtime';
import {RuntimeStore} from '../src/core/store';
import type {Observation,PlannerInput} from '../src/contract';

test('goal job continues after automatic navigation to an explicitly granted second public origin',async()=>{
 const root=await mkdtemp(join(tmpdir(),'goal-runtime-'));
 let current='https://example.com/start',plans=0,approvals=0,revision=1;
 const inputs:PlannerInput[]=[];
 const runtime=new AgentRuntime({store:new RuntimeStore(root),browser:{observe:async context=>({...context,revision,url:current,title:'Docs',text:'Observed '+current,elements:[],capturedAt:'now'}) satisfies Observation,execute:async(action,context)=>{assert.equal(action.type,'navigate');if(action.type==='navigate'){current=action.url;revision++;}return{context,message:'Actual fixture navigation'};}},planner:{next:async input=>{inputs.push(input);return ++plans===1?{thought:'Read the other granted documentation',action:{type:'navigate',url:'https://developer.mozilla.org/en-US/docs/Web/API/AbortController'}}:{thought:'Observed second page',action:{type:'finish',text:'Observed '+input.observation.url}};}},onChange:state=>{if(state.jobs.some(job=>job.status==='awaiting_approval'))approvals++;}});
 try{
  await runtime.initialize();await runtime.start({prompt:'Compare granted pages',profileId:'p',tabId:'a',agentScope:{areaId:'area-a',origin:'https://example.com',expiresAt:new Date(Date.now()+600000).toISOString(),goalId:'goal-a',allowedOrigins:['https://example.com','https://developer.mozilla.org']}});
  for(let i=0;i<500&&runtime.snapshot().activeJobId;i++)await new Promise(resolve=>setTimeout(resolve,3));
  const job=runtime.snapshot().jobs[0]!;assert.equal(job.status,'completed');assert.equal(approvals,0);assert.equal(plans,2);assert.match(job.answer!,/developer.mozilla.org/);assert.equal(inputs.length,2);
 }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true});}
});
