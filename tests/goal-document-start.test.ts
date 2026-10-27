import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRuntime} from '../src/core/runtime';
import {RuntimeStore} from '../src/core/store';
import type {TaskInput} from '../src/contract';

test('fresh goal startup binds the exact document instance, not an earlier pre-plan DOM-content revision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'goal-doc-start-'));
 async function check(documentId:string,goal=true,binding=true){
  const runtime=new AgentRuntime({store:new RuntimeStore(join(dir,`${documentId}-${goal}-${binding}`)),browser:{observe:async context=>({...context,revision:2,url:'https://example.com/docs',title:'Docs',text:'Fresh dynamically loaded public content',elements:[],capturedAt:'now',readingViewport:{documentId,scrollY:0,height:800,scrollHeight:800,text:'Fresh content'}}),execute:async()=>{assert.fail('Read-only startup must not execute an action');}},planner:{next:async input=>({thought:'Fresh observation obtained',action:{type:'finish',text:input.observation.text}})},onChange:()=>{}});
  try{
   await runtime.initialize();
   const input:TaskInput={prompt:'Read this task-owned page',profileId:'p',tabId:'a',initialDocument:{url:'https://example.com/docs',revision:1,...binding?{documentId:'doc-a'}:{}},agentScope:{areaId:'area-a',origin:'https://example.com',expiresAt:new Date(Date.now()+600000).toISOString(),...goal?{goalId:'goal-a',allowedOrigins:['https://example.com']}:{} }};
   if(!goal&&binding){await assert.rejects(runtime.start(input));return;}
   await runtime.start(input);for(let i=0;i<500&&runtime.snapshot().activeJobId;i++)await new Promise(resolve=>setTimeout(resolve,3));
   assert.equal(runtime.snapshot().jobs[0]!.status,goal&&binding&&documentId==='doc-a'?'completed':'failed');
  }finally{await runtime.shutdown();}
 }
 try{await check('doc-a');await check('doc-b');await check('doc-a',false,false);await check('doc-a',false,true);}finally{await rm(dir,{recursive:true,force:true});}
});
