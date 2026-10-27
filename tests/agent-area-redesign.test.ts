import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { DEFAULT_SETTINGS, type AppCommand, type AppState, type Job } from '../src/contract.ts';

function fixture(): AppState {
  const tab = { id:'agent-tab', profileId:'default', title:'자료 조사', url:'https://example.com/research', revision:7, ownership:'agent' as const, agentAreaId:'area', isLoading:false, canGoBack:false, canGoForward:false };
  const job: Job = { id:'job-a', prompt:'실제 조사 요청', profileId:'default', tabId:tab.id, status:'running', createdAt:'2026-10-25T00:00:00Z', updatedAt:'2026-10-25T00:00:00Z', events:[], artifacts:[], answer:null, error:null, approval:null, steps:2, agentScope:{areaId:'area',origin:'https://example.com',expiresAt:'2099-01-01T00:00:00Z'} };
  return { profiles:[{id:'default',name:'기본',incognito:false}], activeProfileId:'default', tabs:[tab], activeTabId:tab.id, splitCount:1, paneTabIds:[tab.id], jobs:[job], activeJobId:job.id, settings:DEFAULT_SETTINGS, memory:[], providerStatus:{installed:true,authenticated:true,liveVerified:false,detail:''}, browserReady:true, bridgeReady:true, agentConnecting:false, error:null, appVersion:'test' };
}

function goalFixture(): AppState {
 const state=fixture();
 state.goalTasks=[{id:'goal',profileId:'default',title:'두 문서 비교',prompt:'원래 사용자 요청',status:'running',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',error:null,children:[
 {id:'child-a',title:'AbortController 조사',prompt:'첫 문서 원래 요청',status:'running',context:{profileId:'default',tabId:'agent-tab'},jobId:'job-a',answer:null,error:null},
 {id:'child-b',title:'ResizeObserver 조사',prompt:'두 번째 원래 요청',status:'completed',context:{profileId:'default',tabId:'second'},jobId:'job-b',answer:null,error:null},
 {id:'blocked',title:'접근 불가 문서',prompt:'비공개 문서',status:'blocked',context:null,jobId:null,answer:null,error:'접근 권한 없음'}]}];
 state.tabs.push({...state.tabs[0],id:'second',title:'두 번째 페이지'});
 state.jobs[0].prompt='첫 문서 원래 요청\n[앱 실행 범위] 호스트 지시';
 state.jobs.push({...state.jobs[0],id:'job-b',tabId:'second',status:'completed',prompt:'두 번째 원래 요청\n[앱 실행 범위] 호스트 지시',answer:'실제 조사 결과',artifacts:[{id:'artifact',name:'실제 결과 파일',kind:'screenshot',path:'/private/hidden.png',createdAt:'2026-10-25T00:00:00Z'}]});
 state.splitCount=2;state.paneTabIds=['agent-tab','second'];return state;
}

test('real named goal children navigate inspection without focusing or hiding native peers',async()=>{
 const base=goalFixture(),ui=await harness(base);
 try {
  const nav=ui.label('작업 목록');assert.equal(nav.type,'nav');
  assert.equal(ui.label('작업 선택 · AbortController 조사').type,'button');
  assert.equal(ui.label('작업 선택 · AbortController 조사').props['aria-pressed'],true);
  assert.match(ui.text(),/두 문서 비교/);assert.match(ui.text(),/접근 불가 문서/);
  assert.equal(ui.all().some(n=>n.type==='select'),false);
  await ui.click('작업 선택 · ResizeObserver 조사');
  assert.match(ui.text(),/실제 조사 결과/);
  await ui.update({...base,activeJobId:'job-a',jobs:base.jobs.map(j=>({...j,steps:8}))});
  assert.equal(ui.label('작업 선택 · ResizeObserver 조사').props['aria-pressed'],true);
  assert.equal(ui.all().filter(n=>n.props['data-native-tab']).length,2);
  assert.equal(ui.commands.some(c=>c.type==='tab.activate'),false);
 }finally{ui.cleanup();}
});

test('selected detail leads with actual results and discloses the original child request',async()=>{
 const ui=await harness(goalFixture());
 try{
  await ui.click('작업 선택 · ResizeObserver 조사');
  const detail=ui.label('선택 작업 상세');
  const texts=(node:Node):string=>node.type==='#text'?String(node.props.text):node.children.map(texts).join('');
  assert.ok(texts(detail).indexOf('실제 조사 결과')<texts(detail).indexOf('두 번째 원래 요청'));
  const request=ui.label('원래 요청');assert.equal(request.type,'details');
  assert.match(texts(request),/두 번째 원래 요청/);assert.doesNotMatch(texts(request),/앱 실행 범위|호스트 지시/);
  assert.equal(ui.label('작업 선택 · ResizeObserver 조사').props['data-job-id'],'job-b');
  await ui.click('결과 파일 열기 · 실제 결과 파일');
  assert.deepEqual(ui.commands.at(-1),{type:'artifact.open',jobId:'job-b',artifactId:'artifact'});
  assert.doesNotMatch(ui.text(),/private\/hidden/);
 }finally{ui.cleanup();}
});

test('frozen left sidebar and native grid geometry share exact safe layout',async()=>{
 const ui=await harness(goalFixture());
 try{
  assert.deepEqual(ui.commands,[{type:'layout.set',left:280,sidebarWidth:0,top:88,bottom:0,hideBrowser:false}]);
  assert.equal(ui.all().filter(n=>n.props.className==='agent-area-pane-chrome').length,2);
  assert.equal(ui.all().some(n=>['img','iframe','webview','canvas'].includes(n.type)),false);
  const css=readFileSync(new URL('../src/renderer/agent-area.css',import.meta.url),'utf8');
  assert.match(css,/\.agent-area-grid\s*\{[^}]*top: 88px;[^}]*right: 0;[^}]*bottom: 0;[^}]*left: 280px;/);
  assert.match(css,/\.agent-area-inspector\s*\{[^}]*top: 56px;[^}]*right: auto;[^}]*bottom: 0;[^}]*left: 0;[^}]*width: 280px;/);
  assert.match(css,/\.agent-area-heading\s*\{[^}]*height: 56px;/);
  assert.match(css,/\.agent-area-main-chrome\s*\{[^}]*height: 32px;[^}]*margin-left: 280px;/);
  assert.match(css,/\.agent-area-pane-chrome\s*\{[^}]*height: 32px;/);
  assert.match(css,/min-width: 1000px/);assert.match(css,/#fafdfe/);assert.match(css,/#eaf8fa/);
  const src=readFileSync(new URL('../src/renderer/AgentArea.tsx',import.meta.url),'utf8');
  assert.match(src,/import.*AGENT_AREA_LAYOUT.*from '\.\.\/agent-area-layout'/);
  assert.doesNotMatch(src,/\.focus\(|fetch\(|window\.open\(|tab\.preview|autoFocus/);
 }finally{ui.cleanup();}
});

function approvalFixture():AppState {
  const base=fixture();
  return {...base,jobs:[{...base.jobs[0],status:'awaiting_approval',approval:{id:'approval-exact',action:{type:'fill',ref:'field',value:'SECRET_ACTION_VALUE'},digest:'digest-bound',context:{profileId:'default',tabId:'agent-tab'},revision:7,expiresAt:'2099-01-01T00:00:00Z',summary:'SECRET_SUMMARY'}}]};
}

test('approval is exceptional, displays only safe binding metadata, and targets exact current IDs',async()=>{
  const base=approvalFixture();
  base.tabs[0].url='https://user:password@example.com/research?token=SECRET_TOKEN#SECRET_HASH';
  const ui=await harness(base);
  try{
    assert.match(ui.text(),/확인이 필요한 행동/);
    assert.match(ui.text(),/중요한 행동이거나 영향 범위를 확인하지 못한 조작입니다\./);
    assert.match(ui.text(),/digest-bound/);assert.match(ui.text(),/2099-01-01/);
    assert.match(ui.text(),/https:\/\/example.com\/research/);
    assert.doesNotMatch(ui.text(),/SECRET_ACTION_VALUE|SECRET_SUMMARY|SECRET_TOKEN|SECRET_HASH|user:password/);
    await ui.click('확인 후 이 행동 실행');
    assert.deepEqual(ui.commands.at(-1),{type:'job.approve',jobId:'job-a',approvalId:'approval-exact',allow:true});
    assert.equal(ui.label('확인 후 이 행동 실행').props.disabled,true,'consumed IDs cannot be replayed');
  }finally{ui.cleanup();}
});

test('approval fails closed for stale revision expired scope wrong profile missing or unassigned targets and offline runtime',async()=>{
  const base=approvalFixture(), job=base.jobs[0],approval=job.approval!;
  const patches:Partial<AppState>[]=[
    {tabs:[{...base.tabs[0],revision:8}]}, {tabs:[]}, {tabs:[{...base.tabs[0],ownership:'user',agentAreaId:undefined}]},
    {tabs:[{...base.tabs[0],lifecycle:'dormant'}]}, {activeProfileId:'other'}, {profiles:[]},
    {jobs:[{...job,approval:{...approval,context:{...approval.context,profileId:'other'}}}]},
    {jobs:[{...job,approval:{...approval,context:{...approval.context,tabId:'other'}}}]},
    {jobs:[{...job,approval:{...approval,expiresAt:'2000-01-01T00:00:00Z'}}]},
    {jobs:[{...job,approval:{...approval,expiresAt:'invalid'}}]},
    {jobs:[{...job,agentScope:{...job.agentScope!,expiresAt:'2000-01-01T00:00:00Z'}}]},
    {tabs:[{...base.tabs[0],agentAreaId:'another-area'}]}, {browserReady:false}, {bridgeReady:false},
  ];
  for(const patch of patches){
    const ui=await harness({...base,...patch});
    try{
      const allow=ui.all().find(n=>n.props['aria-label']==='확인 후 이 행동 실행');
      if(allow){assert.equal(allow.props.disabled,true,JSON.stringify(patch));allow.props.onClick();await ui.render();}
      assert.equal(ui.commands.some(c=>c.type==='job.approve'),false,JSON.stringify(patch));
    }finally{ui.cleanup();}
  }
});

test('approval guards stale handlers, pending dispatch, and actual expiry without layout churn',async()=>{
  const base=approvalFixture();let release:((v:boolean)=>void)|undefined;
  const ui=await harness(base,command=>command.type==='job.approve'?new Promise<boolean>(resolve=>{release=resolve;}):Promise.resolve(true));
  try{
    const stale=ui.label('확인 후 이 행동 실행').props.onClick;
    await ui.update({...base,jobs:[{...base.jobs[0],approval:{...base.jobs[0].approval!,id:'new-ticket'}}]});
    stale();await ui.render();
    assert.equal(ui.commands.some(c=>c.type==='job.approve'),false);
    await ui.click('확인 후 이 행동 실행');
    assert.equal(ui.label('확인 후 이 행동 실행').props.disabled,true);
    ui.label('확인 후 이 행동 실행').props.onClick();await ui.render();
    assert.equal(ui.commands.filter(c=>c.type==='job.approve').length,1);
    release?.(true);await ui.render();
    assert.equal(ui.commands.filter(c=>c.type==='layout.set').length,1);
  }finally{release?.(true);ui.cleanup();}
});

test('approval expires on the clock, blocks a retained click, and never exposes a routine allow',async()=>{
  const base=approvalFixture();
  const expiry=new Date(Date.now()+80).toISOString();
  const ui=await harness({...base,jobs:[{...base.jobs[0],approval:{...base.jobs[0].approval!,expiresAt:expiry}}]});
  try{
    const click=ui.label('확인 후 이 행동 실행').props.onClick;
    await new Promise(resolve=>setTimeout(resolve,100));await ui.render();
    assert.equal(ui.label('확인 후 이 행동 실행').props.disabled,true);
    click();await ui.render();assert.equal(ui.commands.some(c=>c.type==='job.approve'),false);
    for(const job of [{...base.jobs[0],approval:null},{...base.jobs[0],status:'running' as const},{...base.jobs[0],status:'unknown' as const}]){
      await ui.update({...base,jobs:[job]});
      assert.equal(ui.all().some(n=>n.props['aria-label']==='확인 후 이 행동 실행'),false);
    }
  }finally{ui.cleanup();}
});

test('exact native page stop and takeover commands leave all peers present',async()=>{
 const ui=await harness(goalFixture());
 try{
  await ui.click('에이전트 페이지 1 · 자료 조사 직접 사용');
  assert.deepEqual(ui.commands.at(-1),{type:'tab.takeControl',profileId:'default',tabId:'agent-tab'});
  await ui.click('에이전트 페이지 1 · 자료 조사 작업 중지');
  assert.deepEqual(ui.commands.at(-1),{type:'job.cancel',jobId:'job-a'});
  assert.equal(ui.all().filter(n=>n.props['data-native-tab']).length,2);
  assert.equal(ui.commands.some(c=>c.type==='tab.activate'||c.type==='goals.cancel'),false);
 }finally{ui.cleanup();}
});

test('empty workspace is honest and legacy task names distinguish historical jobs on one page',async()=>{
 const base=fixture(),ui=await harness({...base,jobs:[],tabs:[],paneTabIds:[],activeJobId:null});
 try{
  assert.match(ui.text(),/에이전트 작업 없음/);assert.match(ui.text(),/빈 에이전트 화면 1/);
  assert.equal(ui.all().filter(n=>n.props['data-native-tab']).length,0);
  assert.equal(ui.all().some(n=>['img','canvas','iframe','webview'].includes(n.type)),false);
  assert.equal(ui.all().some(n=>n.props['data-job-id']),false);
  await ui.update({...base,jobs:[base.jobs[0],{...base.jobs[0],id:'historical',prompt:'이전 별도 요청\n이어지는 상세',status:'completed'}]});
  ui.label('작업 선택 · 실제 조사 요청');
  ui.label('작업 선택 · 이전 별도 요청');
 }finally{ui.cleanup();}
});

test('blocked children are non-action rows and foreign goals never enter task navigation',async()=>{
 const base=goalFixture();base.goalTasks!.push({...base.goalTasks![0],id:'foreign',profileId:'other',title:'다른 프로필 비밀 목표'});
 const ui=await harness(base);
 try{
  assert.match(ui.text(),/접근 불가 문서실행 불가 · 접근 권한 없음/);
  assert.doesNotMatch(ui.text(),/다른 프로필 비밀 목표/);
  assert.equal(ui.all().filter(n=>n.props['data-job-id']).length,2);
  assert.equal(ui.all().some(n=>n.props['aria-label']==='작업 선택 · 접근 불가 문서'),false);
 }finally{ui.cleanup();}
});

// Execute real JSX and handlers, substituting only React hook scheduling and window I/O.
type Change = {target:{value:string}};
type Props = Record<string,unknown> & {style:Record<string,unknown>;onClick:()=>unknown;onChange:(event:Change)=>unknown};
type Node = {type:string;props:Props;children:Node[]};
function props(value:unknown):Props {
  const raw=value&&typeof value==='object'?value as Record<string,unknown>:{};
  return {...raw,style:raw.style&&typeof raw.style==='object'?raw.style as Record<string,unknown>:{},
    onClick:typeof raw.onClick==='function'?raw.onClick as ()=>unknown:()=>assert.fail('Missing click handler'),
    onChange:typeof raw.onChange==='function'?raw.onChange as (event:Change)=>unknown:()=>assert.fail('Missing change handler')};
}
async function harness(initial:AppState, dispatchOverride?:(command:AppCommand)=>Promise<boolean>) {
  let state=initial, current:unknown[]=[],cursor=0, effects:(()=>void|(()=>void))[]=[];
  const slots=new Map<string,unknown[]>(),cleanups:(()=>void)[]=[],events=new Map<string,()=>void>();
  const commands:AppCommand[]=[];
  const hooks={...React,
    useState<T>(value:T|(()=>T)):[T,(next:T|((previous:T)=>T))=>void]{const owner=current,index=cursor++;if(!(index in owner))owner[index]=typeof value==='function'?(value as ()=>T)():value;return [owner[index] as T,(next)=>{owner[index]=typeof next==='function'?(next as (previous:T)=>T)(owner[index] as T):next;}];},
    useRef<T>(value:T):{current:T}{const index=cursor++;return (current[index]??={current:value}) as {current:T};},
    useEffect(fn:()=>void|(()=>void),deps:readonly unknown[]){const index=cursor++,previous=current[index];if(!Array.isArray(previous)||deps.length!==previous.length||deps.some((d,i)=>!Object.is(d,previous[i]))){current[index]=deps;effects.push(fn);}},
  };
  const originalWindow=globalThis.window;
  Object.assign(globalThis,{window:{addEventListener:(name:string,fn:()=>void)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)}});
  const require=createRequire(new URL('../src/renderer/AgentArea.tsx',import.meta.url));
  const source=readFileSync(new URL('../src/renderer/AgentArea.tsx',import.meta.url),'utf8').replace("import './agent-area.css';",'');
  const code=transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
  const module={exports:{} as {default:(props:{state:AppState;dispatch:(command:AppCommand)=>Promise<boolean>})=>unknown}};
  new Function('require','module','exports',code)((name:string)=>name==='react'?hooks:require(name),module,module.exports);
  const dispatch=async(command:AppCommand)=>{commands.push(command);return dispatchOverride?dispatchOverride(command):true;};
  function expand(value:unknown,path:string):Node[]{
    if(value==null||typeof value==='boolean')return [];
    if(Array.isArray(value))return value.flatMap((v,i)=>expand(v,`${path}.${i}`));
    if(typeof value!=='object')return [{type:'#text',props:props({text:String(value)}),children:[]}];
    const element=value as {type?:unknown;props?:unknown},attributes=props(element.props);
    if(typeof element.type==='function'){current=slots.get(path)??[];slots.set(path,current);cursor=0;return expand((element.type as (props:Props)=>unknown)(attributes),`${path}.render`);}
    return [{type:typeof element.type==='string'?element.type:'fragment',props:attributes,children:expand(attributes.children,`${path}.children`)}];
  }
  let tree:Node[]=[];
  async function render(){for(let i=0;i<3;i++){effects=[];tree=expand({type:module.exports.default,props:{state,dispatch}},'app');for(const fn of effects){const cleanup=fn();if(cleanup)cleanups.push(cleanup);}await Promise.resolve();}}
  const all=():Node[]=>{const walk=(ns:Node[]):Node[]=>ns.flatMap(n=>[n,...walk(n.children)]);return walk(tree);};
  const label=(name:string)=>{const n=all().find(n=>n.props['aria-label']===name);assert.ok(n,`missing ${name}`);return n;};
  await render();
  return {commands,all,label,render,events,text:()=>all().filter(n=>n.type==='#text').map(n=>n.props.text).join(''),async click(name:string){const n=label(name);assert.ok(!n.props.disabled,`disabled ${name}`);n.props.onClick();await render();},async update(next:AppState){state=next;await render();},async select(value:string){label('검사할 에이전트 작업').props.onChange({target:{value}});await render();},cleanup(){cleanups.forEach(fn=>fn());Object.assign(globalThis,{window:originalWindow});}};
}
