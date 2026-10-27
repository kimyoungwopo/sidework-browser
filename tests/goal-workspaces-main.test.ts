import test from 'node:test';
import assert from 'node:assert/strict';
import {GoalWorkspaces} from '../src/desktop/goal-workspaces';
import type {BrowserState,Job,Observation,TaskInput} from '../src/contract';
import type {GoalPlan} from '../src/goal-contract';

function fixture(){
 const state:BrowserState={profiles:[{id:'p',name:'P',incognito:false}],activeProfileId:'p',activeTabId:'user',paneTabIds:['user'],agentPaneTabIds:[],tabs:[{id:'user',profileId:'p',title:'새 탭',url:'about:blank',revision:0,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',lifecycle:'live'}]};
 const order:string[]=[],sent:TaskInput[]=[],jobs:Job[]=[],cancelled:string[]=[];
 let plan:GoalPlan={title:'두 공식 문서 비교',tasks:[{title:'문서 A',prompt:'A의 공식 자료를 읽고 출처와 함께 요약',url:'https://example.com/a',allowedOrigins:['https://example.com'],blocker:null},{title:'문서 B',prompt:'B의 독립적인 공식 자료를 읽고 출처와 함께 요약',url:'https://developer.mozilla.org/docs',allowedOrigins:['https://developer.mozilla.org'],blocker:null}]};
 let held:Promise<void>|undefined,ready=true;
 const workspace=new GoalWorkspaces({readState:()=>state,readJobs:()=>jobs,ready:()=>ready,agentSlots:()=>2,ensureHost:async()=>({}),plan:async()=>{await held;return structuredClone(plan);},cancelPlan:async()=>{},createPage:async input=>{const id='agent-'+state.agentPaneTabIds!.length;order.push('create:'+id);state.agentPaneTabIds!.push(id);state.tabs.push({...state.tabs[0]!,id,title:id,url:input.url,revision:1,ownership:'agent',agentAreaId:'area-'+id});return{areaId:'area-'+id,context:{profileId:'p',tabId:id}};},settle:async()=>{},observe:async context=>{const page=state.tabs.find(t=>t.id===context.tabId)!;return{...context,revision:page.revision,url:page.url,title:page.title,text:'Actual fixture text',elements:[],capturedAt:'',readingViewport:{documentId:page.id,scrollY:0,height:100,scrollHeight:100,text:'Actual fixture text'}} satisfies Observation;},send:async input=>{sent.push(input);order.push('start:'+input.tabId);const id='job-'+input.tabId;jobs.push({...input,id,status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0});return id;},cancelJob:async id=>{cancelled.push(id);const j=jobs.find(j=>j.id===id);if(j)j.status='cancelled';},onChange:()=>{}});
 return{workspace,state,order,sent,jobs,cancelled,hold:(p:Promise<void>)=>{held=p;},setPlan:(value:GoalPlan)=>{plan=value;},setReady:(value:boolean)=>{ready=value;}};
}

test('blank-tab request creates a parent first, then distinct task-owned pages without consuming the user tab',async()=>{
 const f=fixture(),before=structuredClone(f.state);let release!:()=>void;f.hold(new Promise<void>(resolve=>{release=resolve;}));
 const id=await f.workspace.start('두 에이전트로 문서를 비교해줘');
 assert.equal(f.workspace.getState()[0]?.status,'planning');assert.equal(f.sent.length,0);assert.deepEqual(f.state,before);
 release();await f.workspace.drainPreparations();
 const goal=f.workspace.getState().find(g=>g.id===id)!;
 assert.equal(goal.children.length,2);assert.equal(f.sent.length,2);assert.notEqual(f.sent[0]!.prompt,f.sent[1]!.prompt);
 assert.equal(f.state.activeTabId,'user');assert.deepEqual(f.state.paneTabIds,['user']);assert.deepEqual(f.state.tabs.filter(t=>!t.agentAreaId),before.tabs);
 assert.deepEqual(f.order.slice(0,2),['create:agent-0','create:agent-1']);
 assert(f.sent.every(input=>input.computerUse===false&&input.shareScreen===false&&input.agentScope?.goalId===id));
});
