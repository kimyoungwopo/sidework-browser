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
type Node = { type: string; props: Record<string, unknown>; children: Node[] };
type Element = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> };
async function harness(initial: AppState = fixture()) {
  let state = initial;
  let listener: ((state: AppState) => void) | undefined;
  const commands: AppCommand[] = [];
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
  Object.assign(globalThis, { window: { innerWidth: 1440, addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn), removeEventListener: (name: string) => events.delete(name), setInterval: () => 1, clearInterval: () => {}, sidework: { getState: async () => state, onState: (fn: typeof listener) => { listener = fn; return () => {}; }, dispatch: async (command: AppCommand) => { commands.push(command); return state; } } }, document: { getElementById: () => null } });
  const require = createRequire(new URL('../src/renderer/App.tsx', import.meta.url));
  const load = (file: string): { default: (props: Record<string, unknown>) => unknown } => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/import '\.\/[^']+\.css';/g, '');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} as { default: (props: Record<string, unknown>) => unknown } };
  new Function('require', 'module', 'exports', code)((name: string) => name === 'react' ? hooks : name === './AgentArea' ? load('../src/renderer/AgentArea.tsx') : require(name), module, module.exports);
  return module.exports; };
  const app = load('../src/renderer/App.tsx');
  function expand(value: unknown, path: string): Node[] {
    if (value === null || value === undefined || typeof value === 'boolean') return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => expand(item, `${path}.${index}`));
    if (typeof value !== 'object') return [{ type: '#text', props: { text: String(value) }, children: [] }];
    const element = value as Element;
    if (typeof element.type === 'function') { current = slots.get(path) ?? []; slots.set(path, current); cursor = 0; const result=element.type(element.props);const count=cursor; if(hookCounts.has(path))assert.equal(count,hookCounts.get(path),`hook order ${path}`);hookCounts.set(path,count);return expand(result, `${path}.render`); }
    return [{ type: typeof element.type === 'string' ? element.type : 'fragment', props: element.props, children: expand(element.props.children, `${path}.children`) }];
  }
  let tree: Node[] = [];
  async function render() { for (let i = 0; i < 4; i++) { effects = []; tree = expand({ type: app.default, props: {} }, 'app'); const batch = effects; effects = []; batch.forEach(fn => fn()); await Promise.resolve(); await Promise.resolve(); } }
  const all = (): Node[] => { const walk = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...walk(node.children)]); return walk(tree); };
  const label = (name: string) => { const node = all().find(node => node.props['aria-label'] === name); assert.ok(node, `missing control ${name}`); return node; };
  const text = () => all().filter(node => node.type === '#text').map(node => node.props.text).join('');
  const click = async (name: string) => { const node = label(name); assert.ok(!node.props.disabled, `disabled control ${name}`); (node.props.onClick as () => void)(); await render(); };
  await render();
  return { commands, label, text, click, all, render, events, async update(next: AppState) { state = next; listener?.(next); await render(); }, cleanup() { cleanups.forEach(fn=>fn());Object.assign(globalThis, { window: originalWindow, document: originalDocument }); } };
}


test('root renders real AgentArea and only its native layout; browser shortcuts stay inactive', async () => {
 const state=fixture({surface:'agent'});
 state.tabs=[{...state.tabs[0],id:'agent-tab',ownership:'agent',agentAreaId:'area'}];
 state.activeTabId='agent-tab';state.paneTabIds=['agent-tab'];
 const ui=await harness(state);
 try {
  assert.ok(ui.all().some(n=>n.props.className==='agent-area'));
  assert.equal(ui.all().some(n=>n.props.className==='browser-chrome'),false);
  assert.deepEqual(ui.commands,[{type:'layout.set',top:88,sidebarWidth:0,left:280,bottom:0,hideBrowser:false}]);
  ui.events.get('keydown')?.({key:'t',metaKey:true,preventDefault(){}});
  await ui.render();
  assert.equal(ui.commands.some(c=>c.type==='tab.new'||c.type==='agent.connect'),false);
 } finally {ui.cleanup();}
});


test('primary delegation binds exact document and explicit sharing; IME and duplicate gates preserve browsing', async () => {
 const initial=fixture();const ui=await harness(initial);
 try {
  await ui.click('어시스턴트');
  const edit=()=> (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'공개 자료 정리'}});
  edit();await ui.render();
  const send=ui.label('에이전트에게 맡기기');assert.equal(send.props.disabled,true);
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  const key=ui.label('AI에게 요청').props.onKeyDown as (e:unknown)=>void;
  key({key:'Enter',shiftKey:false,nativeEvent:{isComposing:true,keyCode:229},preventDefault(){}});
  assert.equal(ui.commands.some(c=>c.type==='agents.start'),false);
  let finish:((s:AppState)=>void)|undefined;
  window.sidework!.dispatch=command=>{ui.commands.push(command);return command.type==='agents.start'?new Promise<AppState>(resolve=>{finish=resolve;}):Promise.resolve(initial);};
  key({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false,keyCode:13},preventDefault(){}});
  key({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false,keyCode:13},preventDefault(){}});
  await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='agents.start'),[{type:'agents.start',tabId:'user-tab',expectedRevision:7,expectedUrl:'https://example.com/research',prompt:'공개 자료 정리',computerUse:false,shareScreen:true}]);
  assert.equal(ui.label('뒤로 가기').props.disabled,false);
  await ui.click('뒤로 가기');assert.equal(ui.commands.at(-1)?.type,'tab.back');
  finish?.(initial);await ui.render();
  assert.equal(ui.label('AI에게 요청').props.value,'');
  assert.equal(ui.all().some(n=>n.props['aria-label']==='첫 스크롤 동시 시작'),false);
 } finally {ui.cleanup();}
});


test('per-page batch delegates exact consenting documents once into agent area', async () => {
 const initial=fixture();initial.tabs.push({...initial.tabs[0],id:'second',url:'https://example.org/page',revision:9});initial.splitCount=2;initial.paneTabIds=initial.tabs.map(t=>t.id);
 const ui=await harness(initial);
 try {
  await ui.click('화면별 AI');
  for(const i of [1,2]) (ui.label(`화면 ${i} AI 요청`).props.onChange as (e:unknown)=>void)({target:{value:`요청 ${i}`}});
  await ui.render();
  (ui.label('화면별 AI 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  const start=ui.label('입력한 화면 AI 시작').props.onClick as ()=>void;start();start();await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='agents.startSections'),[{type:'agents.startSections',consent:true,tasks:initial.tabs.map((t,i)=>({tabId:t.id,expectedRevision:t.revision,expectedUrl:t.url,prompt:`요청 ${i+1}`}))}]);
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked,false);
 } finally {ui.cleanup();}
});


test('same-request visible-page batch delegates without first-scroll coordination', async () => {
 const initial=fixture();initial.tabs.push({...initial.tabs[0],id:'second',url:'https://example.org/page',revision:9});initial.splitCount=2;initial.paneTabIds=initial.tabs.map(t=>t.id);
 const ui=await harness(initial);
 try {
  await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'같은 요청'}});await ui.render();
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  await ui.click('보이는 화면 일괄 실행');
  assert.deepEqual(ui.commands.filter(c=>c.type==='agents.startSections'),[{type:'agents.startSections',consent:true,tasks:initial.tabs.map(t=>({tabId:t.id,expectedRevision:t.revision,expectedUrl:t.url,prompt:'같은 요청'}))}]);
  assert.equal(ui.commands.some(c=>c.type==='jobs.startVisible'),false);
 } finally {ui.cleanup();}
});


test('browser-first agent-area button reports real active jobs and opens without a provider', async () => {
 const initial=fixture({bridgeReady:false,providerStatus:{installed:false,authenticated:false,liveVerified:false,detail:''}});
 const page={...initial.tabs[0],id:'agent-tab',ownership:'agent' as const,agentAreaId:'area'};initial.agentTabs=[page];
 const job:Job={id:'j',profileId:'default',tabId:page.id,prompt:'작업',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],steps:0,approval:null,answer:null,error:null};
 initial.jobs=[job,{...job,id:'done',status:'completed'},{...job,id:'foreign',profileId:'other'}];initial.activeJobIds=['j','foreign'];
 const ui=await harness(initial);
 try {
  const button=ui.label('에이전트 작업 영역');assert.equal(button.props.disabled,false);
  const text=(nodes:Node[]):string=>nodes.map(n=>n.type==='#text'?String(n.props.text):text(n.children)).join('');
  assert.match(text(button.children),/에이전트 작업 영역.*1/);
  assert.equal(ui.all().find(n=>n.type==='aside')?.props.hidden,true);
  await ui.click('에이전트 작업 영역');assert.equal(ui.commands.at(-1)?.type,'agents.show');
  assert.equal(ui.label('새 탭').props.disabled,false);
  assert.equal(ui.commands.some(c=>c.type==='agent.connect'),false);
 } finally {ui.cleanup();}
});


test('agent confirmation cannot open or steal focus into the ordinary browser sidebar', async () => {
 const initial=fixture();const page={...initial.tabs[0],id:'agent-tab',ownership:'agent' as const,agentAreaId:'area'};initial.agentTabs=[page];
 const job:Job={id:'agent-job',profileId:'default',tabId:page.id,prompt:'에이전트 요청',status:'awaiting_approval',createdAt:'',updatedAt:'',events:[],artifacts:[],steps:1,answer:null,error:null,agentScope:{areaId:'area',origin:'https://example.com',expiresAt:'2099-01-01T00:00:00Z'},approval:{id:'ticket',digest:'digest',context:{profileId:'default',tabId:page.id},revision:7,expiresAt:'2099-01-01T00:00:00Z',summary:'중요 행동',action:{type:'navigate',url:'https://example.com/next'}}};
 initial.jobs=[job];initial.activeJobIds=[job.id];
 const ui=await harness(initial);
 try {
  assert.equal(ui.all().find(n=>n.type==='aside')?.props.hidden,true);
  await ui.click('어시스턴트');
  assert.equal(ui.all().some(n=>n.props['aria-label']==='행동 승인 요청'),false);
  await ui.update({...initial,surface:'agent',tabs:[page],activeTabId:page.id,paneTabIds:[page.id]});
  ui.label('확인이 필요한 행동');
  assert.equal(ui.events.has('keydown'),false);
  await ui.update(initial);assert.ok(ui.events.has('keydown'));
 }finally{ui.cleanup();}
});


test('primary handoff shares visibly and keeps the full Korean action label readable', async () => {
 const ui=await harness();
 try {
  await ui.click('어시스턴트');
  const details=ui.all().find(n=>n.type==='details'&&n.props.className==='composer-options');assert.ok(details);
  const walk=(nodes:Node[]):Node[]=>nodes.flatMap(n=>[n,...walk(n.children)]);
  assert.equal(walk(details.children).some(n=>n.props['aria-label']==='선택 화면 공유 동의'),false,'required consent cannot live inside a closed optional disclosure');
  const css=readFileSync(new URL('../src/renderer/styles.css',import.meta.url),'utf8');
  assert.match(css,/\.send-button\s*\{[^}]*width:\s*auto/,'full action label must not fit in an icon-only box');
 } finally{ui.cleanup();}
});


test('changed document revokes sharing and capacity blocks agents without blocking navigation', async () => {
 const initial=fixture(),ui=await harness(initial);
 try {
  await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'요청'}});await ui.render();
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,false);
  const changed={...initial,tabs:[{...initial.tabs[0],revision:8}]};await ui.update(changed);
  assert.equal(ui.label('선택 화면 공유 동의').props.checked,false);
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,true);
  const jobs=Array.from({length:8},(_,i):Job=>({id:`busy-${i}`,tabId:`hidden-${i}`,profileId:'default',prompt:'진행',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],steps:0,answer:null,error:null,approval:null}));
  await ui.update({...changed,jobs,activeJobIds:jobs.map(j=>j.id)});
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,true);
  assert.equal(ui.label('새 탭').props.disabled,false);
  assert.equal(ui.label('주소 또는 검색어').props.disabled,false);
 }finally{ui.cleanup();}
});

test('primary delegation rejects overlong prompts before allocating a job', async () => {
 const ui=await harness();
 try {
  await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'가'.repeat(8001)}});await ui.render();
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,true);
  (ui.label('AI에게 요청').props.onKeyDown as (e:unknown)=>void)({key:'Enter',shiftKey:false,nativeEvent:{isComposing:false,keyCode:13},preventDefault(){}});await ui.render();
  assert.equal(ui.commands.some(c=>c.type==='agents.start'),false);
 }finally{ui.cleanup();}
});


test('duplicate visible-batch click cannot release the first batch page reservations', async () => {
 const initial=fixture();initial.tabs.push({...initial.tabs[0],id:'second'});initial.splitCount=2;initial.paneTabIds=initial.tabs.map(t=>t.id);
 const ui=await harness(initial);let finish:((s:AppState)=>void)|undefined;
 try {
  await ui.click('어시스턴트');
  (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'일괄 요청'}});await ui.render();
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  window.sidework!.dispatch=command=>{ui.commands.push(command);return command.type==='agents.startSections'?new Promise<AppState>(resolve=>{finish=resolve;}):Promise.resolve(initial);};
  const start=ui.label('보이는 화면 일괄 실행').props.onClick as ()=>void;start();start();await ui.render();
  assert.equal(ui.commands.filter(c=>c.type==='agents.startSections').length,1);
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled,true,'pages stay reserved until the real batch finishes');
 }finally{finish?.(initial);await ui.render();ui.cleanup();}
});
