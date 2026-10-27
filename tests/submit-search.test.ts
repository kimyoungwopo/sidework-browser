import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlan} from '../src/core/validation.ts';
import {assertBrowserAction} from '../src/desktop/browser-policy.ts';
import {parsePlanOutput, PLAN_SCHEMA} from '../src/provider/codex.ts';
import {AgentRuntime} from '../src/core/runtime.ts';
import {RuntimeStore} from '../src/core/store.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {routeTaskPage} from '../src/desktop/task-page-router.ts';
import type {BrowserState, Job} from '../src/contract.ts';
import {isAutomaticAgentAction} from '../src/agent-action-policy.ts';
import type {Observation, AgentScope, ObservedElement} from '../src/contract.ts';
const now=Date.now();
const scope:AgentScope={areaId:'area',goalId:'goal',origin:'https://www.naver.com',allowedOrigins:['https://www.naver.com','https://search.naver.com'],expiresAt:new Date(now+60000).toISOString()};
const query:ObservedElement={ref:'r1',tag:'input',role:'combobox',name:'검색',inputType:'search',sensitive:false,interaction:{kind:'input',submission:{kind:'naver-native-get',method:'get',url:'https://search.naver.com/search.naver'}}};
const observation:Observation={profileId:'p',tabId:'t',revision:1,documentId:'doc',observationMode:'search-form',url:'https://www.naver.com/',title:'NAVER',text:'',elements:[query],capturedAt:new Date(now).toISOString()};
const action={type:'submit_search' as const,ref:'r1'};
test('explicit native submission traverses strict core/provider/browser contracts and exact goal destination policy',()=>{
 assert.deepEqual(validatePlan({thought:'Submit observed native query',action}).action,action);
 assert.doesNotThrow(()=>assertBrowserAction(action));
 const wire={type:'submit_search',url:null,ref:'r1',value:null,direction:null,text:null,x:null,y:null,frameId:null,key:null,maxScreens:null};
 assert.deepEqual(parsePlanOutput(JSON.stringify({thought:'Native submission',action:wire})).action,action);
 assert(PLAN_SCHEMA.properties.action.anyOf.some(v=>v.properties.type.enum.includes('submit_search')));
 assert.equal(PLAN_SCHEMA.properties.action.anyOf.length,13);
 assert.equal(isAutomaticAgentAction(action,observation,scope,now),true);
});

test('submit_search wire rejects malformed refs, unknown fields, every active non-ref payload and missing inactive nulls',()=>{
 const wire={type:'submit_search',url:null,ref:'r1',value:null,direction:null,text:null,x:null,y:null,frameId:null,key:null,maxScreens:null};
 for(const ref of ['', 'query', '#query','r0','r01','r1;alert(1)','r999999999999']) {
  assert.throws(()=>parsePlanOutput(JSON.stringify({thought:'No',action:{...wire,ref}})));
  assert.throws(()=>validatePlan({thought:'No',action:{...action,ref}}));
  assert.throws(()=>assertBrowserAction({...action,ref}));
 }
 for(const [key,value] of Object.entries({...wire,url:'https://search.naver.com/search.naver',value:'css',direction:'down',text:'do it',x:0,y:0,frameId:'screen',key:'Enter',maxScreens:1,selector:'#query',script:'alert(1)'})){
  if(['type','ref'].includes(key))continue;
  assert.throws(()=>parsePlanOutput(JSON.stringify({thought:'No',action:{...wire,[key]:value}})),key);
 }
 for(const key of Object.keys(wire).filter(key=>!['type','ref'].includes(key))){const missing:Record<string,unknown>={...wire};delete missing[key];assert.throws(()=>parsePlanOutput(JSON.stringify({thought:'No',action:missing})),key);}
});

for(const scenario of ['read-only','legacy','manual','unknown-outcome','cancelled-outcome'] as const)test(`runtime native submission has no approval escape or retry: ${scenario}`,async()=>{
 const dir=await mkdtemp(join(homedir(),'.hermes/cache/scratch/submit-search-runtime-'));let executed=0,plans=0;let cancellation:Promise<void>|undefined;
 const runtime=new AgentRuntime({store:new RuntimeStore(dir),onChange:()=>{},browser:{observe:async()=>({...structuredClone(observation),capturedAt:new Date().toISOString()}),execute:async(_action,context)=>{executed++;if(scenario==='cancelled-outcome')return new Promise<never>(()=>setImmediate(()=>{cancellation=runtime.cancel(context.jobId);}));throw Error('Native dispatch outcome unknown');}},planner:{next:async()=>{plans++;return {thought:'Submit only observed query',action};}}});
 try{
  await runtime.initialize();if(scenario==='read-only')await runtime.updateSettings({permissionMode:'read-only'});
  const bound=structuredClone(scope);bound.expiresAt=new Date(Date.now()+60000).toISOString();
  if(scenario==='legacy'){delete bound.goalId;delete bound.allowedOrigins;}
  await runtime.start({profileId:'p',tabId:'t',prompt:'Search public CSS',computerUse:false,shareScreen:false,...scenario==='manual'?{}:{agentScope:bound}});
  for(let n=0;n<200&&runtime.snapshot().activeJobId;n++)await new Promise(resolve=>setTimeout(resolve,2));
  await cancellation;
  const job=runtime.snapshot().jobs[0]!;
  assert.equal(job.approval,null);assert(!job.events.some(event=>event.kind==='approval'));assert.equal(plans,1);
  if(scenario.includes('outcome')){assert.equal(executed,1);assert.equal(job.status,'unknown');}
  else {assert.equal(executed,0);assert.equal(job.status,'failed');}
 }finally{await runtime.shutdown();await rm(dir,{recursive:true,force:true});}
});

for(const scenario of ['valid','legacy','manual','read-only','computer','share','cancelled','expired','destination','unknown-ref','duplicate-ref','stale-ref','foreign-doc','stale-revision','foreign-tab','foreign-frame','post-observe-cancel','foreign-result','foreign-navigation'] as const)test(`main independently validates native submission and navigation receipt: ${scenario}`,async()=>{
 const job:Job={id:'j',profileId:'p',tabId:'t',prompt:'Search',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,executionEpoch:0,computerUse:false,shareScreen:false,agentScope:structuredClone(scope)};
 const fresh=structuredClone(observation);
 const state:BrowserState={profiles:[{id:'p',name:'P',incognito:false}],activeProfileId:'p',activeTabId:null,agentPaneTabIds:['t'],tabs:[{id:'t',profileId:'p',title:'NAVER',url:observation.url,isLoading:false,canGoBack:false,canGoForward:false,ownership:'agent',agentAreaId:'area',lifecycle:'live',revision:1}]};
 let mode:'guard'|'read-only'='guard',executed=0,registered=0,revoked=false;
 switch(scenario){
  case 'legacy':delete job.agentScope!.goalId;delete job.agentScope!.allowedOrigins;break;
  case 'manual':delete job.agentScope;state.tabs[0]!.ownership='user';break;
  case 'read-only':mode='read-only';break;
  case 'computer':job.computerUse=true;break;
  case 'share':job.shareScreen=true;break;
  case 'cancelled':job.status='cancelled';break;
  case 'expired':job.agentScope!.expiresAt=new Date(now-1).toISOString();break;
  case 'destination':job.agentScope!.allowedOrigins=['https://www.naver.com'];break;
  case 'unknown-ref':fresh.elements=[];break;
  case 'duplicate-ref':fresh.elements.push(structuredClone(query));break;
  case 'stale-ref':fresh.elements[0]!.ref='r2';break;
  case 'foreign-doc':fresh.observationMode=undefined;fresh.documentId=undefined;break;
  case 'stale-revision':fresh.revision++;break;
  case 'foreign-tab':fresh.tabId='other';break;
  case 'foreign-frame':fresh.url='https://www.naver.com/other';break;
 }
 const services={authority:{assertRequest:()=>{if(revoked)throw Error('cancelled');},registerResult:()=>{registered++;}},readJobs:()=>[job],readState:()=>state,readPermissionMode:()=>mode,assertGoal:()=>{},browser:{observe:async()=>{if(scenario==='post-observe-cancel')revoked=true;return fresh;},execute:async()=>{executed++;state.tabs[0]!.url=scenario==='foreign-navigation'?'https://evil.test/':'https://search.naver.com/search.naver?query=css%20tutorial';return {context:{profileId:'p',tabId:scenario==='foreign-result'?'other':'t'},message:'Native submission dispatched'};}}};
 const request={kind:'browser.request' as const,id:'request',operation:'execute' as const,context:{profileId:'p',tabId:'t',jobId:'j',expectedRevision:1},action};
 if(scenario==='valid') {assert.deepEqual((await routeTaskPage(services,request) as {context:unknown}).context,{profileId:'p',tabId:'t'});assert.equal(registered,1);}
 else {await assert.rejects(routeTaskPage(services,request),scenario);assert.equal(registered,0);if(!['foreign-result','foreign-navigation'].includes(scenario))assert.equal(executed,0);}
});
