import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { DEFAULT_SETTINGS, type AppState, type AppCommand, type Job } from '../src/contract.ts';

function fixture(patch: Partial<AppState> = {}): AppState {
 const tab = {id:'user-tab',profileId:'default',ownership:'user' as const,title:'사용자 페이지',url:'https://example.com/research',revision:7,isLoading:false,canGoBack:true,canGoForward:false};
 return {profiles:[{id:'default',name:'기본',incognito:false}],activeProfileId:'default',tabs:[tab],activeTabId:tab.id,splitCount:1,paneTabIds:[tab.id],jobs:[],activeJobIds:[],activeJobId:null,settings:DEFAULT_SETTINGS,memory:[],providerStatus:{installed:true,authenticated:true,liveVerified:false,detail:''},browserReady:true,bridgeReady:true,agentConnecting:false,error:null,appVersion:'test',...patch};
}
import type { GoalTask } from '../src/goal-contract.ts';

type Node = { type: string; props: Record<string, unknown>; children: Node[] };
type Element = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> };
async function harness(initial: AppState = fixture()) {
  let state = initial;
  let listener: ((state: AppState) => void) | undefined;
  const commands: AppCommand[] = [];
  const focused:string[]=[];
  let rejectStart = false;
  let startWait:Promise<void>|undefined;
  const events = new Map<string, (event: unknown) => void>();
  const slots = new Map<string, unknown[]>();
  const hookCounts = new Map<string, number>();
  const cleanups = new Set<() => void>();
  let current: unknown[] = [], cursor = 0;
  let effects: (() => void)[] = [];
  const hooks = { ...React,
    useState(value: unknown) { const owner = current, index = cursor++; if (!(index in owner)) owner[index] = value; return [owner[index], (next: unknown) => { owner[index] = typeof next === 'function' ? next(owner[index]) : next; }]; },
    useRef(value: unknown) { const index = cursor++; return current[index] ??= { current: value }; },
    useCallback(fn: unknown, deps: unknown[]) { const index = cursor++; const previous = current[index] as { fn: unknown; deps: unknown[] } | undefined; if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) current[index] = { fn, deps }; return (current[index] as { fn: unknown }).fn; },
    useEffect(fn: () => void | (() => void), deps: unknown[]) {
      const index=cursor++, owner=current;
      const previous=owner[index] as {deps:unknown[];cleanup?:()=>void}|undefined;
      if(!previous || deps.length!==previous.deps.length || deps.some((dep,i)=>dep!==previous.deps[i])) {
        previous?.cleanup?.();if(previous?.cleanup)cleanups.delete(previous.cleanup);
        const entry:{deps:unknown[];cleanup?:()=>void}={deps};owner[index]=entry;
        effects.push(()=>{const cleanup=fn();if(cleanup){entry.cleanup=cleanup;cleanups.add(cleanup);}});
      }
    },
  };
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { window: { innerWidth: 1440, addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn), removeEventListener: (name: string) => events.delete(name), setInterval: () => 1, clearInterval: () => {}, sidework: { getState: async () => state, onState: (fn: typeof listener) => { listener = fn; return () => {}; }, dispatch: async (command: AppCommand) => { commands.push(command); if(command.type==='goals.start')await startWait; if(command.type==='goals.start' && rejectStart) throw new Error('request failed'); return state; } } }, document: { getElementById: () => null } });
  const require = createRequire(new URL('../src/renderer/App.tsx', import.meta.url));
  const load = (file: string): { default: (props: Record<string, unknown>) => unknown } => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/import '\.\/[^']+\.css';/g, '');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} as { default: (props: Record<string, unknown>) => unknown } };
  new Function('require', 'module', 'exports', code)((name: string) => name === 'react' ? hooks : ['./AgentArea','./GoalTasks'].includes(name) ? load('../src/renderer/'+name.slice(2)+'.tsx') : require(name), module, module.exports);
  return module.exports; };
  const app = load('../src/renderer/App.tsx');
  function expand(value: unknown, path: string): Node[] {
    if (value === null || value === undefined || typeof value === 'boolean') return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => expand(item, `${path}.${index}`));
    if (typeof value !== 'object') return [{ type: '#text', props: { text: String(value) }, children: [] }];
    const element = value as Element;
    if (typeof element.type === 'function') { current = slots.get(path) ?? []; slots.set(path, current); cursor = 0; const result=element.type(element.props);const count=cursor; if(hookCounts.has(path))assert.equal(count,hookCounts.get(path),`hook order ${path}`);hookCounts.set(path,count);return expand(result, `${path}.render`); }
    const ref=element.props.ref as {current:unknown}|undefined;if(ref)ref.current={focus(){focused.push(String(element.props['aria-label']));}};
    return [{ type: typeof element.type === 'string' ? element.type : 'fragment', props: element.props, children: expand(element.props.children, `${path}.children`) }];
  }
  let tree: Node[] = [];
  async function render() { for (let i = 0; i < 4; i++) { effects = []; tree = expand({ type: app.default, props: {} }, 'app'); const batch = effects; effects = []; batch.forEach(fn => fn()); await Promise.resolve(); await Promise.resolve(); } }
  const all = (): Node[] => { const walk = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...walk(node.children)]); return walk(tree); };
  const label = (name: string) => { const node = all().find(node => node.props['aria-label'] === name); assert.ok(node, `missing control ${name}`); return node; };
  const text = () => all().filter(node => node.type === '#text').map(node => node.props.text).join('');
  const click = async (name: string) => { const node = label(name); assert.ok(!node.props.disabled, `disabled control ${name}`); (node.props.onClick as () => void)(); await render(); };
  await render();
  return { focused, holdStart(){let release!:()=>void;startWait=new Promise<void>(resolve=>{release=resolve;});return release;}, failStart(value:boolean) { rejectStart=value; }, commands, label, text, click, all, render, events, async update(next: AppState) { state = next; listener?.(next); await render(); }, cleanup() { cleanups.forEach(fn=>fn());Object.assign(globalThis, { window: originalWindow, document: originalDocument }); } };
}

test('blank Ask starts a context-free goal and preserves the shared draft after rejection', async () => {
 const base=fixture();base.tabs[0].url='about:blank';const ui=await harness(base);
 try {
  (ui.label('새 탭 검색 또는 주소').props.onChange as (event:unknown)=>void)({target:{value:'  독립 자료 조사  '}});await ui.render();await ui.click('Ask');
  assert.equal(ui.label('새 탭 요청 보내기').props.disabled,false);
  ui.failStart(true);
  await (ui.label('새 탭 요청 폼').props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault(){}});await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='goals.start').at(-1),{type:'goals.start',prompt:'  독립 자료 조사  '});
  assert.equal(ui.label('새 탭 AI 요청').props.value,'  독립 자료 조사  ');
  ui.failStart(false);
  await (ui.label('새 탭 요청 폼').props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault(){}});await ui.render();
  assert.equal(ui.commands.filter(c=>c.type==='goals.start').length,2);
  assert.equal(ui.commands.some(c=>c.type==='agents.start'),false);
 }finally{ui.cleanup();}
});

function goal(patch:Partial<GoalTask>={}):GoalTask{return {id:'goal-exact',profileId:'default',title:'여행 자료와 이미지',prompt:'자료와 이미지 준비',status:'running',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',error:null,children:[{id:'research',title:'공개 자료 조사',prompt:'자료 찾기',status:'running',context:{profileId:'default',tabId:'agent-tab'},jobId:'child-job',answer:null,error:null},{id:'image',title:'이미지 만들기',prompt:'이미지 생성',status:'blocked',context:null,jobId:null,answer:null,error:'이미지 생성기가 연결되지 않았습니다.'}],...patch};}
function childJob():Job{return {id:'child-job',profileId:'default',tabId:'agent-tab',prompt:'자료 찾기',status:'running',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',steps:3,events:[{id:'event',kind:'observation',text:'원문 두 페이지 확인',at:'2026-10-25T00:00:00Z'}],artifacts:[],approval:null,answer:null,error:null};}
test('root task owns named child progress, real answers and exact stop without navigating ordinary tabs',async()=>{
 const base=fixture({goalTasks:[goal()],jobs:[childJob()],activeJobIds:['child-job']});base.agentTabs=[{...base.tabs[0],id:'agent-tab',ownership:'agent',title:'조사 페이지'}];
 const ui=await harness(base);try{
  await ui.click('작업 열기 · 여행 자료와 이미지');
  assert.ok(ui.text().includes('공개 자료 조사'));assert.ok(ui.text().includes('이미지 만들기'));
  assert.ok(ui.text().includes('진행 중 · 3단계'));assert.ok(ui.text().includes('원문 두 페이지 확인'));
  assert.ok(ui.text().includes('이미지 생성기가 연결되지 않았습니다.'));
  assert.equal(ui.all().some(n=>n.type==='img'),false);
  assert.equal(ui.commands.some(c=>c.type==='tab.activate'||c.type==='agents.show'),false);
  await ui.click('공개 자료 조사 화면 보기');assert.deepEqual(ui.commands.at(-1),{type:'agents.show'});
  await ui.click('공개 자료 조사 직접 사용');assert.deepEqual(ui.commands.at(-1),{type:'tab.takeControl',profileId:'default',tabId:'agent-tab'});
  await ui.click('여행 자료와 이미지 중지');assert.deepEqual(ui.commands.at(-1),{type:'goals.cancel',goalId:'goal-exact'});
  const done=goal({status:'partial'});done.children[0]={...done.children[0],status:'completed',answer:'실제 원문에서 확인한 결과'};
  await ui.update({...base,goalTasks:[done],jobs:[{...childJob(),status:'completed',answer:'실제 원문에서 확인한 결과'}],activeJobIds:[]});
  assert.ok(ui.text().includes('일부 완료'));assert.ok(ui.text().includes('실제 원문에서 확인한 결과'));
  assert.equal(ui.label('주소 또는 검색어').props.value,'https://example.com/research');
 }finally{ui.cleanup();}
});

test('current page attachment retains exact document and consent contract',async()=>{
 const ui=await harness();try{
  await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (event:unknown)=>void)({target:{value:'현재 페이지 정리'}});await ui.render();
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,true);
  (ui.label('선택 화면 공유 동의').props.onChange as (event:unknown)=>void)({target:{checked:true}});await ui.render();
  await (ui.all().find(n=>n.type==='form'&&n.props.className==='composer')!.props.onSubmit as (e:unknown)=>Promise<void>)({preventDefault(){}});await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='agents.start').at(-1),{type:'agents.start',prompt:'현재 페이지 정리',tabId:'user-tab',expectedRevision:7,expectedUrl:'https://example.com/research',computerUse:false,shareScreen:true});
  assert.equal(ui.commands.some(c=>c.type==='goals.start'),false);
 }finally{ui.cleanup();}
});
test('background task updates never steal composer focus or replace the ordinary draft',async()=>{
 const base=fixture({goalTasks:[goal()],jobs:[childJob()],activeJobIds:['child-job']});const ui=await harness(base);try{
  assert.deepEqual(ui.focused,[]);await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (event:unknown)=>void)({target:{value:'다음 독립 요청 초안'}});await ui.render();
  ui.focused.length=0;
  await ui.update({...base,jobs:[{...childJob(),status:'completed'}],activeJobIds:[],goalTasks:[goal({status:'partial'})]});
  assert.deepEqual(ui.focused,[]);assert.equal(ui.label('AI에게 요청').props.value,'다음 독립 요청 초안');
  assert.equal(ui.label('주소 또는 검색어').props.value,'https://example.com/research');
 }finally{ui.cleanup();}
});
test('goal child approval targets exact job and ticket and refuses stale documents',async()=>{
 const base=fixture({goalTasks:[goal({status:'awaiting_approval'})],jobs:[{...childJob(),status:'awaiting_approval',approval:{id:'ticket-exact',digest:'digest',context:{profileId:'default',tabId:'agent-tab'},revision:7,expiresAt:'2099-01-01T00:00:00Z',summary:'공개 문서 열기',action:{type:'navigate',url:'https://example.com/source'}}}],activeJobIds:['child-job'],agentPaneTabIds:['agent-tab']});
 base.agentTabs=[{...base.tabs[0],id:'agent-tab',ownership:'agent',agentAreaId:'area-exact'}];base.goalTasks![0].children[0].status='awaiting_approval';
 const ui=await harness(base);try{
  await ui.click('작업 열기 · 여행 자료와 이미지');await ui.click('공개 자료 조사 이번 행동 허용');
  assert.deepEqual(ui.commands.at(-1),{type:'job.approve',jobId:'child-job',approvalId:'ticket-exact',allow:true});
  assert.equal(ui.label('공개 자료 조사 이번 행동 허용').props.disabled,true);
  const changed={...base,agentTabs:[{...base.agentTabs![0],revision:8}],jobs:[{...base.jobs[0],approval:{...base.jobs[0].approval!,id:'new-ticket'}}]};await ui.update(changed);
  assert.equal(ui.label('공개 자료 조사 이번 행동 허용').props.disabled,true);
  await ui.click('공개 자료 조사 행동 거부');assert.deepEqual(ui.commands.at(-1),{type:'job.approve',jobId:'child-job',approvalId:'new-ticket',allow:false});
 }finally{ui.cleanup();}
});
test('blank Ask offers Codex preparation and retains IME, Shift Enter and mode drafts',async()=>{
 const base=fixture();base.tabs[0].url='about:blank';base.providerStatus.authenticated=false;const ui=await harness(base);try{
  await ui.click('Ask');ui.label('Codex 준비');assert.equal(ui.label('새 탭 요청 보내기').props.disabled,true);
  (ui.label('새 탭 AI 요청').props.onChange as (e:unknown)=>void)({target:{value:'보존할 초안'}});await ui.render();
  await ui.update({...base,providerStatus:{...base.providerStatus,authenticated:true}});
  const key=ui.label('새 탭 AI 요청').props.onKeyDown as (e:unknown)=>void;
  key({key:'Enter',shiftKey:false,nativeEvent:{isComposing:true,keyCode:229},preventDefault(){}});
  key({key:'Enter',shiftKey:true,nativeEvent:{isComposing:false},preventDefault(){}});await ui.render();
  assert.equal(ui.commands.some(c=>c.type==='goals.start'),false);await ui.click('Search');assert.equal(ui.label('새 탭 검색 또는 주소').props.value,'보존할 초안');
  await ui.click('Ask');key({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false},preventDefault(){}});await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='goals.start').at(-1),{type:'goals.start',prompt:'보존할 초안'});
 }finally{ui.cleanup();}
});

test('goal acceptance keeps draft and locks profile switching while the start request is in flight',async()=>{
 const base=fixture();base.tabs[0].url='about:blank';const ui=await harness(base);let release=()=>{};
 try{
  await ui.click('Ask');(ui.label('새 탭 AI 요청').props.onChange as (e:unknown)=>void)({target:{value:'접수 대기 초안'}});await ui.render();
  release=ui.holdStart();(ui.label('새 탭 요청 폼').props.onSubmit as (e:unknown)=>void)({preventDefault(){}});await ui.render();
  assert.equal(ui.label('새 탭 AI 요청').props.value,'접수 대기 초안');
  await ui.click('프로필 관리');assert.equal(ui.all().find(n=>n.props['data-testid']==='profile-default')?.props.disabled,true);
  release();await ui.render();assert.equal(ui.label('새 탭 AI 요청').props.value,'접수 대기 초안');
 }finally{release();ui.cleanup();}
});

test('cancelling stays visibly in flight with repeat stop disabled and profile switching locked',async()=>{
 const ui=await harness(fixture({goalTasks:[goal({status:'cancelling'})]}));try{
  await ui.click('작업 열기 · 여행 자료와 이미지');assert.ok(ui.text().includes('중지 중'));
  assert.equal(ui.label('여행 자료와 이미지 중지').props.disabled,true);
  await ui.click('프로필 관리');assert.equal(ui.all().find(n=>n.props['data-testid']==='profile-default')?.props.disabled,true);
 }finally{ui.cleanup();}
});
