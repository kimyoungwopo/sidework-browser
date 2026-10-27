import test from 'node:test';
import assert from 'node:assert/strict';
import {routeTaskPage} from '../src/desktop/task-page-router';
import type {BrowserState,Job,Observation} from '../src/contract';

test('new goal scopes need a main-ledger check before and after cross-origin native RPC',async()=>{
 const context={profileId:'p',tabId:'a'};
 const scope={areaId:'area-a',origin:'https://example.com',expiresAt:new Date(Date.now()+600000).toISOString(),goalId:'goal-a',allowedOrigins:['https://example.com','https://developer.mozilla.org']};
 const job:Job={...context,id:'j',prompt:'Read',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,agentScope:scope};
 const state:BrowserState={profiles:[],activeProfileId:'p',activeTabId:'user',agentPaneTabIds:['a'],tabs:[{id:'a',profileId:'p',url:'https://example.com/start',title:'A',revision:1,isLoading:false,canGoBack:false,canGoForward:false,ownership:'agent',lifecycle:'live',agentAreaId:'area-a'}]};
 let native=0,checks=0,revoked=false;
 const services={authority:{assertRequest:()=>{},registerResult:()=>{}},readJobs:()=>[job],readState:()=>state,assertGoal:()=>{checks++;if(revoked)throw new Error('goal revoked');},browser:{observe:async()=>({...context,revision:1,url:state.tabs[0]!.url,title:'Docs',text:'Actual page',elements:[],capturedAt:''}) satisfies Observation,execute:async()=>{native++;state.tabs[0]!.url='https://developer.mozilla.org/docs';return{context,message:'Navigated'};}}};
 const request={kind:'browser.request' as const,id:'q',operation:'execute' as const,context:{...context,jobId:'j',expectedRevision:1},action:{type:'navigate' as const,url:'https://developer.mozilla.org/docs'}};
 await routeTaskPage(services,request);assert.equal(native,1);assert(checks>=2);
 const observation={kind:'browser.request' as const,id:'o',operation:'observe' as const,context,jobId:'j'};
 const value=await routeTaskPage(services,observation);assert('url' in value&&value.url.includes('mozilla'));
 await assert.rejects(routeTaskPage({...services,assertGoal:undefined},observation));
 revoked=true;await assert.rejects(routeTaskPage(services,request));assert.equal(native,1);
});
