import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {PageAuthority} from '../src/desktop/page-authority';
import {AgentRuntime} from '../src/core/runtime';
import {RuntimeStore} from '../src/core/store';
import {routeTaskPage,takeTaskPageControl} from '../src/desktop/task-page-router';
import type {BrowserPort,BrowserState,Job,Observation} from '../src/contract';
const context={profileId:'default',tabId:'user-tab'};
const state:BrowserState={profiles:[{id:'default',name:'Default',incognito:false}],activeProfileId:'default',activeTabId:'user-tab',paneTabIds:['user-tab','peer'],tabs:['user-tab','peer'].map(id=>({id,profileId:'default',title:id,url:'https://fixture.test/',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'live'}))};
function job(id:string,tabId:string,executionEpoch=0):Job{return {id,profileId:'default',tabId,prompt:'fixture',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,executionEpoch};}

test('wire command metadata is projected out of public page-control state',()=>{
 const authority=new PageAuthority(),command={type:'tab.takeControl',...context};authority.takeControl(state,[],command);assert.deepEqual(authority.getState(state),[{...context,state:'reclaiming'}]);
});

test('real user-created tabs can be reclaimed while peer and fresh-request epochs remain independent',()=>{
 const authority=new PageAuthority(),a=job('a','user-tab'),b=job('b','peer'),jobs=[a,b];
 authority.assertRequest(jobs,context,'a','observe');authority.assertRequest(jobs,{profileId:'default',tabId:'peer'},'b','observe');
 const receipt=authority.takeControl(state,jobs,context);assert.deepEqual(receipt.jobIds,['a']);assert.equal(authority.getState(state)[0]!.state,'reclaiming');
 assert.throws(()=>authority.assertRequest(jobs,context,'a','observe'));assert.throws(()=>authority.assertRequest([job('late-start','user-tab')],context,'late-start','observe'));
 assert.doesNotThrow(()=>authority.assertRequest(jobs,{profileId:'default',tabId:'peer'},'b','execute'));
 authority.completeTakeControl(context,receipt.generation,true);assert.equal(authority.getState(state)[0]!.state,'user');
 const fresh=authority.bindInput({...context,prompt:'new consent'}),next=job('new','user-tab',fresh.executionEpoch);assert.equal(fresh.executionEpoch,1);authority.assertRequest([next,b],context,'new','observe');assert.deepEqual(authority.getState(state),[]);
});

test('shared real authority and routing discard late A data while B proceeds without a global wait',async()=>{
 const authority=new PageAuthority(),jobs=[job('a','user-tab'),job('b','peer')];let finish!:(value:Observation)=>void;
 const sample:Observation={...context,revision:0,url:'https://fixture.test/',title:'fixture',text:'fixture data',elements:[],capturedAt:''};
 const browser:BrowserPort={observe:async target=>target.tabId==='user-tab'?await new Promise(resolve=>{finish=resolve;}):{...sample,...target},execute:async()=>{throw new Error('unused');}};
 const services={authority,browser,readJobs:()=>jobs,readState:()=>state};
 const a=routeTaskPage(services,{kind:'browser.request',id:'a',operation:'observe',context,jobId:'a'});
 const cancelled:string[]=[];await takeTaskPageControl({...services,invalidate:()=>{},publish:()=>{},cancelJob:async id=>{cancelled.push(id);}},context);assert.deepEqual(cancelled,['a']);
 const b=await routeTaskPage(services,{kind:'browser.request',id:'b',operation:'observe',context:{profileId:'default',tabId:'peer'},jobId:'b'});assert.equal('tabId' in b&&b.tabId,'peer');
 finish(sample);await assert.rejects(a,/epoch|reclaim|authorized/i);assert.equal(authority.getState(state)[0]!.state,'user');
});

test('cancellation failure stays unknown instead of declaring user control acknowledged',async()=>{
 const authority=new PageAuthority();await assert.rejects(takeTaskPageControl({authority,readJobs:()=>[job('a','user-tab')],readState:()=>state,invalidate:()=>{},publish:()=>{},cancelJob:async()=>{throw new Error('uncertain cancellation');}},context));assert.equal(authority.getState(state)[0]!.state,'unknown');
});

test('authority-bound ordinary input can actually start the real runtime without an optional document',async()=>{
 const root=await mkdtemp(join(homedir(),'.hermes/cache/scratch/authority-runtime-')),authority=new PageAuthority();
 const runtime=new AgentRuntime({store:new RuntimeStore(root),onChange:()=>{},planner:{next:async()=>({thought:'done',action:{type:'finish',text:'fixture done'}})},browser:{observe:async target=>({...target,revision:0,url:'https://fixture.test/',title:'fixture',text:'public fixture',elements:[],capturedAt:''}),execute:async()=>{throw new Error('not used');}}});
 try{
  await runtime.initialize();const input=authority.bindInput({...context,prompt:'read fixture'});assert.equal('initialDocument' in input,false);
  const id=await runtime.start(input);for(let n=0;n<200&&runtime.snapshot().activeJobId;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(runtime.snapshot().jobs.find(job=>job.id===id)!.status,'completed');assert.equal(runtime.snapshot().jobs.find(job=>job.id===id)!.executionEpoch,0);
 }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true});}
});
