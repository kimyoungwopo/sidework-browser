import test from 'node:test';import assert from 'node:assert/strict';import {taskContext,assertExecutingJob} from '../src/desktop/tasks';import type{BrowserState,Job}from'../src/contract';
import * as tasks from '../src/desktop/tasks';
test('queued actions from cancelled or other-pane computer jobs cannot execute',()=>{
 const job:Job={id:'j',profileId:'default',tabId:'b',prompt:'test',status:'running',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,createdAt:'',updatedAt:'',computerUse:true,shareScreen:true};
 const context={profileId:'default',tabId:'b',jobId:'j',expectedRevision:1};assert.doesNotThrow(()=>assertExecutingJob([job],context));assert.throws(()=>assertExecutingJob([{...job,status:'cancelled'}],context));assert.throws(()=>assertExecutingJob([job],{...context,tabId:'a'}));assert.throws(()=>assertExecutingJob([],context));
});
const s:BrowserState={profiles:[{id:'default',name:'normal',incognito:false},{id:'private',name:'private',incognito:true}],activeProfileId:'default',activeTabId:'a',paneTabIds:['a','b'],tabs:['a','b','hidden'].map(id=>({id,profileId:'default',url:'https://example.test/',title:id,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:1}))};
test('visible batch binding preserves consent and builds a complete DOM cohort without hidden or busy targets',()=>{
 assert.equal(typeof tasks.visibleBatchInputs,'function');
 const command={type:'jobs.startVisible' as const,prompt:'read',shareScreen:true as const,computerUse:false,synchronizedScroll:true};
 const inputs=tasks.visibleBatchInputs(s,[],command);assert.deepEqual(inputs.map(i=>i.tabId),['a','b']);assert(inputs.every(i=>i.computerUse===false&&i.shareScreen===true));
 const active:Job={id:'busy',profileId:'default',tabId:'a',prompt:'x',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0};
 assert.throws(()=>tasks.visibleBatchInputs(s,[active],command),/busy|실행|진행/i);
 assert.throws(()=>tasks.visibleBatchInputs({...s,paneTabIds:['a']},[],command));
 assert.throws(()=>tasks.visibleBatchInputs({...s,paneTabIds:['a','a']},[],command));
});
test('smooth-scroll execution metadata cannot escape its synchronized DOM job binding',()=>{
 const job:Job={id:'j',profileId:'default',tabId:'a',prompt:'x',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,synchronizedScroll:true};
 const context={profileId:'default',tabId:'a',jobId:'j',expectedRevision:1,smoothScroll:true};
 assert.doesNotThrow(()=>assertExecutingJob([job],context));
 assert.throws(()=>assertExecutingJob([{...job,synchronizedScroll:false}],context));
 assert.throws(()=>assertExecutingJob([{...job,computerUse:true}],context));
 assert.throws(()=>assertExecutingJob([job],{...context,tabId:'b'}));
 assert.throws(()=>assertExecutingJob([job],context,false));
});
test('owned scroll cancellation starts immediately after worker post, not after its response',async()=>{
 assert.equal(typeof tasks.cancelOwnedExecution,'function');const order:string[]=[];let finish!:()=>void;
 const cancelled=tasks.cancelOwnedExecution(()=>{order.push('worker posted');return new Promise<void>(resolve=>{finish=resolve;});},async()=>{order.push('native stopped');});
 await Promise.resolve();assert.deepEqual(order,['worker posted','native stopped']);finish();await cancelled;
 let stopFinished=false;const error=new Error('worker offline');
 await assert.rejects(tasks.cancelOwnedExecution(()=>{throw error;},async()=>{await Promise.resolve();stopFinished=true;}),error);
 assert.equal(stopFinished,true);
});
test('owned cancellation clears control visuals and scroll without waiting for worker response',async()=>{
 const order:string[]=[];let finish!:()=>void;
 const cancelling=tasks.cancelOwnedExecution(()=>{order.push('worker');return new Promise<void>(resolve=>{finish=resolve;});},async()=>{order.push('scroll');},async()=>{order.push('visuals');});
 await Promise.resolve();assert.deepEqual(order,['worker','scroll','visuals']);finish();await cancelling;
});

test('task binding uses explicit visible pane, consent and nonprivate profile, never focused global retargeting',()=>{assert.deepEqual(taskContext(s,'b',true,true),{profileId:'default',tabId:'b'});assert.throws(()=>taskContext(s,'b',true,false));assert.throws(()=>taskContext(s,'hidden',true,true));assert.throws(()=>taskContext({...s,activeProfileId:'private',tabs:s.tabs.map(t=>({...t,profileId:'private'}))},'a',true,true));});
