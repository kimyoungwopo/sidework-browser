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

test('Aside shell keeps ordinary and agent tabs separate and exposes actual profile tasks', async () => {
 const initial=fixture();initial.agentTabs=[{...initial.tabs[0],id:'agent-tab',ownership:'agent',title:'Agent document'}];
 const job:Job={id:'real-job',profileId:'default',tabId:'user-tab',prompt:'실제 자료 정리',status:'completed',createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',events:[],artifacts:[],steps:2,approval:null,answer:'실제 결과',error:null};
 initial.jobs=[job,{...job,id:'private',profileId:'other',prompt:'다른 프로필 작업'}];
 const ui=await harness(initial);
 try {
  const sidebar=ui.label('브라우저 사이드바');assert.ok(sidebar);
  assert.equal(ui.all().some(n=>n.props.className==='tab-strip'),false);
  const tabs=ui.label('브라우저 탭');const walk=(nodes:Node[]):Node[]=>nodes.flatMap(n=>[n,...walk(n.children)]);
  assert.equal(walk(tabs.children).some(n=>n.props.text==='Agent document'),false);
  assert.ok(ui.text().includes('실제 자료 정리'));assert.equal(ui.text().includes('다른 프로필 작업'),false);
  await ui.click('새 탭');assert.equal(ui.commands.at(-1)?.type,'tab.new');
  await ui.click('사용자 페이지 닫기');assert.deepEqual(ui.commands.at(-1),{type:'tab.close',tabId:'user-tab'});
  await ui.click('Agent document · 에이전트 작업 영역에서 열기');assert.equal(ui.commands.at(-1)?.type,'agents.show');
 }finally{ui.cleanup();}
});

test('browser tabs expose labelled panels and roving keyboard activation without claiming IME keys',async()=>{
 const base=fixture();base.tabs.push({...base.tabs[0],id:'other-tab',title:'다른 페이지'});
 const ui=await harness(base);
 try{
  const tabs=ui.all().filter(node=>node.props.role==='tab'&&node.props['aria-label']);
  assert.equal(tabs[0].props.tabIndex,0);assert.equal(tabs[1].props.tabIndex,-1);
  assert.equal(tabs[0].props['aria-controls'],'browser-content');
  assert.equal(ui.label('웹페이지 영역').props['aria-labelledby'],'browser-tab-user-tab');
  const handler=tabs[0].props.onKeyDown;assert.equal(typeof handler,'function');
  let focus=-1,prevented=false;const targets=[0,1].map(index=>({focus(){focus=index;}}));
  const event={key:'ArrowDown',ctrlKey:false,metaKey:false,altKey:false,nativeEvent:{isComposing:false},currentTarget:{closest(){return{querySelectorAll(){return targets;}};}},preventDefault(){prevented=true;}};
  (handler as (event:unknown)=>void)(event);await ui.render();
  assert.equal(prevented,true);assert.equal(focus,1);assert.deepEqual(ui.commands.at(-1),{type:'tab.activate',tabId:'other-tab'});
  const count=ui.commands.length;(handler as (event:unknown)=>void)({...event,nativeEvent:{isComposing:true}});await ui.render();assert.equal(ui.commands.length,count);
 }finally{ui.cleanup();}
});

test('new tab Search and Ask share the draft and authenticated blank-tab goals need no page handoff', async () => {
 const initial=fixture();initial.tabs=[{...initial.tabs[0],url:'about:blank',title:'새 탭'}];
 const ui=await harness(initial);
 try {
  ui.label('새 탭 작업 시작');
  (ui.label('새 탭 검색 또는 주소').props.onChange as (e:unknown)=>void)({target:{value:'보존할 요청'}});await ui.render();
  await ui.click('Ask');assert.equal(ui.label('새 탭 AI 요청').props.value,'보존할 요청');
  (ui.label('새 탭 AI 요청').props.onKeyDown as (e:unknown)=>void)({key:'Enter',shiftKey:false,nativeEvent:{isComposing:true,keyCode:229},preventDefault(){}});await ui.render();
  assert.equal(ui.commands.some(c=>c.type==='agents.start'),false);
  assert.equal(ui.commands.some(c=>c.type==='goals.start'),false,'IME composition must not submit a goal');
  assert.ok(ui.text().includes('일반 탭의 로그인은 공유하지 않습니다'));
  assert.equal(ui.label('새 탭 요청 보내기').props.disabled,false);
  await ui.click('현재 페이지 요청 열기');assert.equal(ui.label('AI에게 요청').props.value,'보존할 요청');
  await ui.click('사이드바 닫기');await ui.click('Search');
  assert.equal(ui.label('새 탭 검색 또는 주소').props.value,'보존할 요청');
  (ui.label('새 탭 검색 폼').props.onSubmit as (e:unknown)=>void)({preventDefault(){}});await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='tab.navigate').at(-1),{type:'tab.navigate',url:'보존할 요청'});
 }finally{ui.cleanup();}
});

test('panel tabs have one keyboard stop and arrow navigation controls a real labelled panel',async()=>{
 const ui=await harness();try{
  await ui.click('어시스턴트');
  const tabs=ui.all().filter(node=>node.props.role==='tab'&&String(node.props.id||'').startsWith('panel-tab-'));
  assert.equal(tabs.length,3);assert.deepEqual(tabs.map(node=>node.props.tabIndex),[0,-1,-1]);
  assert.equal(ui.all().find(node=>node.props.id==='task-panel-content')?.props.role,'tabpanel');
  let focus=-1;const targets=[0,1,2].map(index=>({focus(){focus=index;}}));
  const handler=tabs[0].props.onKeyDown;assert.equal(typeof handler,'function');
  (handler as (event:unknown)=>void)({key:'ArrowRight',ctrlKey:false,metaKey:false,altKey:false,nativeEvent:{isComposing:false},currentTarget:{closest(){return{querySelectorAll(){return targets;}};}},preventDefault(){}});await ui.render();
  assert.equal(focus,1);assert.equal(ui.all().find(node=>node.props.id==='panel-tab-history')?.props['aria-selected'],true);
  assert.equal(ui.all().find(node=>node.props.id==='task-panel-content')?.props['aria-labelledby'],'panel-tab-history');
 }finally{ui.cleanup();}
});

test('new-tab mode explains the active action and associates unavailable execution with its input',async()=>{
 const base=fixture();base.tabs[0].url='about:blank';const ui=await harness(base);
 try{
  assert.equal(ui.label('새 탭 검색 또는 주소').props['aria-describedby'],'home-mode-help');
  assert.match(String(ui.all().find(node=>node.props.id==='home-mode-help')?.children.map(node=>node.props.text).join('')),/Enter/);
  await ui.click('Ask');
  assert.equal(ui.label('새 탭 AI 요청').props['aria-describedby'],'home-mode-help');
  assert.equal(ui.label('새 탭 요청 보내기').props['aria-describedby'],'home-mode-help');
  assert.equal(ui.all().find(node=>node.props.id==='home-mode-help')?.props.role,'status');
 }finally{ui.cleanup();}
});

test('central search keeps IME fallback Enter local and layout follows compact native geometry', async () => {
 const initial=fixture();initial.tabs=[{...initial.tabs[0],url:'about:blank'}];
 const ui=await harness(initial);
 try {
  let prevented=false;
  (ui.label('새 탭 검색 또는 주소').props.onKeyDown as (e:unknown)=>void)({key:'Enter',nativeEvent:{isComposing:false,keyCode:229},preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'IME fallback Enter must not submit navigation');
  assert.deepEqual(ui.commands.filter(c=>c.type==='layout.set').at(-1),{type:'layout.set',left:228,top:56,bottom:0,sidebarWidth:0,hideBrowser:true});
  window.innerWidth=1099;ui.events.get('resize')?.({});await ui.render();
  assert.deepEqual(ui.commands.filter(c=>c.type==='layout.set').at(-1),{type:'layout.set',left:64,top:56,bottom:0,sidebarWidth:0,hideBrowser:true});
  ui.label('일반 탭');ui.label('에이전트 탭');
  const css=readFileSync(new URL('../src/renderer/aside-shell.css',import.meta.url),'utf8');
  assert.match(css,/--rail-width:\s*228px/);assert.match(css,/@media \(max-width: 1099px\)[\s\S]*--rail-width:\s*64px/);
  assert.match(css,/\.app-shell \.browser-surface\s*\{[^}]*top:\s*56px/);
  assert.match(css,/\.app-shell \.pane-header\s*\{[^}]*height:\s*32px/);
 }finally{ui.cleanup();}
});
