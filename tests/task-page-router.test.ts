import test from 'node:test';
import assert from 'node:assert/strict';
import type {BrowserPort,Job,Observation} from '../src/contract';
import {routeTaskPage,takeTaskPageControl} from '../src/desktop/task-page-router';
const context={profileId:'p',tabId:'a'};
const job:Job={...context,id:'j',prompt:'read',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,executionEpoch:0};
const observation:Observation={...context,revision:0,url:'https://fixture.test/',title:'fixture',text:'public fixture',elements:[],capturedAt:''};

test('delegated execution cannot use a same-profile user page without its native agent-area binding',async()=>{
 let calls=0;
 const scoped:Job={...job,agentScope:{areaId:'area-a',origin:'https://fixture.test',expiresAt:new Date(Date.now()+600000).toISOString()}};
 const browser:BrowserPort={observe:async()=>observation,execute:async(_action,c)=>{calls++;return{context:c,message:'Should not execute'};}};
 const page={id:'a',profileId:'p',title:'User page',url:observation.url,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user' as const,revision:0,lifecycle:'live' as const};
 await assert.rejects(routeTaskPage({authority:{assertRequest:()=>{},registerResult:()=>{}},browser,readJobs:()=>[scoped],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',paneTabIds:['a'],tabs:[page]})},{kind:'browser.request',id:'scoped',operation:'execute',context:{...context,jobId:'j',expectedRevision:0},action:{type:'scroll',direction:'down'}}));
 assert.equal(calls,0);
});

test('open_tab cannot grant an existing agent page by returning its identifier',async()=>{
 let registered=0;
 const authority={assertRequest:()=>{},registerResult:()=>{registered++;}};
 const browser:BrowserPort={observe:async()=>observation,execute:async()=>({context:{profileId:'p',tabId:'already-existing'},message:'fake open result'})};
 const existing={id:'already-existing',profileId:'p',title:'existing',url:'https://fixture.test/',isLoading:false,canGoBack:false,canGoForward:false,ownership:'agent' as const,revision:0};
 await assert.rejects(routeTaskPage({authority,browser,readJobs:()=>[job],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',tabs:[existing]})},{kind:'browser.request',id:'open',operation:'execute',context:{...context,jobId:'j',expectedRevision:0},action:{type:'open_tab',url:'https://fixture.test/'}}),/new|existing/i);assert.equal(registered,0);
});

test('takeover revokes and invalidates synchronously before worker acknowledgement',async()=>{
 const order:string[]=[];let finish!:()=>void;
 const authority={takeControl:()=>{order.push('revoke');return{jobIds:['j'],generation:1};},completeTakeControl:(_context:typeof context,generation:number,ok:boolean)=>{order.push(`complete:${generation}:${ok}`);}};
 const pending=takeTaskPageControl({authority,readJobs:()=>[job],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',tabs:[]}),invalidate:()=>order.push('invalidate'),publish:()=>order.push('publish'),cancelJob:async id=>{order.push(`cancel:${id}`);await new Promise<void>(resolve=>{finish=resolve;});}},context);
 assert.deepEqual(order,['revoke','invalidate','publish','cancel:j']);finish();await pending;assert.deepEqual(order.slice(-2),['complete:1:true','publish']);
});

test('execute results are checked after dispatch and registered only while authority still holds',async()=>{
 let revoked=false,registered=0,calls=0,finish!:(result:{context:typeof context;message:string})=>void;
 const authority={assertRequest:()=>{if(revoked)throw new Error('revoked');},registerResult:()=>{registered++;}};
 const browser:BrowserPort={observe:async()=>observation,execute:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
 const services={authority,browser,readJobs:()=>[job],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',tabs:[]})};
 const request={kind:'browser.request' as const,id:'exec',operation:'execute' as const,context:{...context,jobId:'j',expectedRevision:0},action:{type:'scroll' as const,direction:'down' as const}};
 const pending=routeTaskPage(services,request);assert.equal(calls,1);revoked=true;finish({context,message:'done'});await assert.rejects(pending,/revoked/);assert.equal(registered,0);
 revoked=false;const success=routeTaskPage(services,request);finish({context,message:'done'});await success;assert.equal(registered,1);
});

test('a revoked in-flight observation is not returned after a user takeover',async()=>{
 let revoked=false,finish!:(observation:Observation)=>void,calls=0;
 const authority={assertRequest:()=>{if(revoked)throw new Error('revoked');},registerResult:()=>{}};
 const browser:BrowserPort={observe:()=>{calls++;return new Promise(resolve=>{finish=resolve;});},execute:async()=>{throw new Error('unused');}};
 const pending=routeTaskPage({authority,browser,readJobs:()=>[job],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',tabs:[]})},{kind:'browser.request',id:'r',operation:'observe',context,jobId:'j'});
 assert.equal(calls,1);revoked=true;finish(observation);await assert.rejects(pending,/revoked/);
 await assert.rejects(routeTaskPage({authority,browser,readJobs:()=>[job],readState:()=>({profiles:[],activeProfileId:'p',activeTabId:'a',tabs:[]})},{kind:'browser.request',id:'r2',operation:'observe',context,jobId:'j'}));assert.equal(calls,1);
});
