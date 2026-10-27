import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserWindow } from 'electron';
import type {Job} from '../src/contract.ts';
import vm from 'node:vm';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';

class FakeSession extends EventEmitter {
  cleared = 0;
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  async clearStorageData() { this.cleared++; }
  async clearCache() {}
  flushStorageData() {}
}
const sessions = new Map<string, FakeSession>();
class FakeContents extends EventEmitter {
  url = 'about:blank'; destroyed = false; loads: string[] = []; backgroundThrottling = true;
  mainFrame = {}; isolatedScripts:string[]=[];
  async executeJavaScriptInIsolatedWorld(_world:number,scripts:{code:string}[]):Promise<unknown>{this.isolatedScripts.push(...scripts.map(item=>item.code));return undefined;}
  static load: ((contents: FakeContents, url: string) => Promise<void>) | undefined;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  setWindowOpenHandler() {}
  setBackgroundThrottling(value: boolean) { this.backgroundThrottling = value; }
  getURL() { return this.url; }
  getTitle() { return 'Fixture'; }
  isLoading() { return false; }
  isDestroyed() { return this.destroyed; }
  async loadURL(url: string) {
    this.loads.push(url);
    await FakeContents.load?.(this, url);
    this.url = url;
    this.emit('did-start-navigation', { isMainFrame: true });
    this.emit('did-navigate');
  }
  close() { this.destroyed = true; this.emit('destroyed'); }
}
class FakeView {
  static all: FakeView[] = [];
  webContents = new FakeContents(); visible = false; bounds: unknown;
  constructor(readonly options: { webPreferences: Record<string, unknown> }) { FakeView.all.push(this); }
  setVisible(value: boolean) { this.visible = value; }
  setBounds(value: unknown) { this.bounds = value; }
}
class FakeWindow extends EventEmitter {
  destroyed = false;
  children = new Set<FakeView>();
  additions: FakeView[] = [];
  contentView = {
    addChildView: (view: FakeView) => { this.additions.push(view); this.children.add(view); },
    removeChildView: (view: FakeView) => { this.children.delete(view); },
  };
  getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
  isDestroyed() { return this.destroyed; }
}
Object.assign(globalThis, { __goalElectronMock: { WebContentsView: FakeView, session: {
  fromPartition: (partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, new FakeSession());
    return sessions.get(partition);
  },
} } });
registerHooks({
  resolve(specifier, context, next) { return specifier === 'electron' ? { url: 'goal:electron', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'goal:electron' ? { format: 'module', source: 'export const {WebContentsView, session} = globalThis.__goalElectronMock', shortCircuit: true } : next(url, context); },
});
const { BrowserController } = await import('../src/desktop/browser.ts');
const nativeHost = (host: FakeWindow) => host as unknown as BrowserWindow;
async function setup() {
  const dataRoot = await mkdtemp(join(homedir(), '.hermes/cache/scratch/goal-browser-'));
  const window = new FakeWindow(), host = new FakeWindow();
  const controller = new BrowserController({ window: nativeHost(window), dataRoot, onChange: () => {} });
  await controller.initialize();
  await controller.navigate('https://ordinary.test/article');
  return { controller, window, host, dataRoot, cleanup: async () => {
    FakeContents.load = undefined;
    await controller.dispose();
    await rm(dataRoot, { recursive: true, force: true });
  } };
}

// Real serialized observe/act plus runtime planning; only transport/planner are fixtures.
function searchDocument(){
 let callback:(records:unknown[])=>void=()=>{};
 const world=vm.createContext({URL,crypto:{randomUUID:()=> 'native-search-doc'},MutationObserver:class {constructor(cb:(records:unknown[])=>void){callback=cb;}observe(){}takeRecords(){return [];}}});
 vm.runInContext(`
  const nodes=[];
  function element(tagName,attrs={},textContent=''){
   const el={tagName,attrs,textContent,nodeType:1,isConnected:true,childNodes:[],value:'private-route-state',disabled:false,readOnly:false,checked:false,
    get attributes(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));},
    getAttribute(key){return this.attrs[key]??null;},getRootNode(){return document;},
    getBoundingClientRect(){const x=this===submit?200:10;return {x,y:10,left:x,top:10,right:x+100,bottom:40,width:100,height:30};},
    contains(node){return node===this||this.childNodes.includes(node);},matches(){return false;},dispatchEvent(){}};
   nodes.push(el);return el;
  }
  const window={innerWidth:1000,innerHeight:800,scrollX:0,scrollY:0};
  const location={href:'https://www.naver.com/'};
  const document={title:'NAVER',baseURI:location.href,addEventListener(){},removeEventListener(){},querySelectorAll(selector){return selector==='form'?[form]:selector.includes('dialog')?[]:nodes;},elementFromPoint(x){return x>150?submit:field;},elementsFromPoint(x){return [this.elementFromPoint(x),form,html];}};
  const html=element('HTML');html.scrollHeight=800;document.createRange=()=>({setStart(){},setEnd(){},getClientRects(){return [];}});document.documentElement=html;document.body=html;document.activeElement=html;
  const form=element('FORM',{method:'get',action:'https://search.naver.com/search.naver',role:'search'});form.innerText='검색 AI 검색';form.parentElement=html;
  const field=element('INPUT',{type:'search',name:'query',id:'query',role:'combobox'});field.type='search';field.focus=()=>{document.activeElement=field;};
  const submit=element('BUTTON',{type:'submit',id:'search-btn'},'검색');submit.value='';
  const hidden=element('INPUT',{type:'hidden',name:'where'});
  form.elements=[field,submit,hidden];form.childNodes=[...form.elements];html.childNodes=[form];
  for(const el of form.elements){el.form=form;el.parentElement=form;}
  const decoration=element('DIV',{style:'background:conic-gradient(from 85deg,transparent,cyan);opacity:0'});decoration.value=undefined;decoration.parentElement=form;form.childNodes.push(decoration);
  let getComputedStyle=()=>({display:'block',visibility:'visible'});
  class HTMLInputElement {} class HTMLTextAreaElement {}
  Object.defineProperty(HTMLInputElement.prototype,'value',{set(value){this.value=value;}});
  class Event{constructor(type){this.type=type;}}
  Object.assign(globalThis,{window,location,document,getComputedStyle,HTMLInputElement,HTMLTextAreaElement,Event});
 `,world);
 return {world,news(){callback([{type:'characterData',target:{nodeType:3,textContent:'Rotating news'}}]);},animate(){vm.runInContext("decoration.attrs.style+=';opacity:1'",world);callback([{type:'attributes',attributeName:'style',target:vm.runInContext('decoration',world)}]);}};
}

test('goal runtime dispatches explicit hidden-native submission once and records its authorized same-page navigation receipt',async t=>{
 const env=await setup();let runtime:AgentRuntime|undefined;
 try{
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'submit-goal',url:'https://www.naver.com/',host:nativeHost(env.host)});
  const wc=[...env.host.children][0]!.webContents,doc=searchDocument();
  vm.runInContext(`for(const el of nodes)el.ownerDocument=document;getComputedStyle=e=>({display:e===submit?'none':'block',visibility:'visible'});class HTMLFormElement {};HTMLFormElement.prototype.requestSubmit=function(button){if(this!==form||button!==submit)throw Error('wrong native submit');window.nativeSubmissions=(window.nativeSubmissions??0)+1;};Object.assign(globalThis,{HTMLFormElement});`,doc.world);
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async(_world:number,items:{code:string}[])=>{
   if(/window\.__sideworkDOM\.(snapshot|act)\(/.test(items[0]!.code))return vm.runInContext(items[0]!.code,doc.world);
  });
  const dispatched:string[]=[];
  runtime=new AgentRuntime({store:new RuntimeStore(join(env.dataRoot,'runtime')),
   browser:{observe:(context,options)=>env.controller.observe(context,options),execute:async(action,context)=>{const value=await env.controller.execute(action,context);dispatched.push(action.type);return value;}},
   planner:{next:async input=>{
    const count=input.history.filter(event=>event.kind==='action').length,ref=input.observation.elements[0]!.ref;
    return {thought:'Native public query only',action:count===0?{type:'fill',ref,value:'css tutorial'}:count===1?{type:'submit_search',ref}:{type:'finish',text:'Native query submitted'}};
   }},onChange:snapshot=>env.controller.updateControlJobs(snapshot.jobs)});
  await runtime.initialize();
  await runtime.start({prompt:'Search Naver',...page.context,computerUse:false,shareScreen:false,agentScope:{areaId:page.areaId,goalId:'submit-goal',origin:'https://www.naver.com',allowedOrigins:['https://www.naver.com','https://search.naver.com'],expiresAt:new Date(Date.now()+60000).toISOString()}});
  for(let n=0;n<500&&runtime.snapshot().activeJobId;n++)await new Promise(resolve=>setTimeout(resolve,3));
  const job=runtime.snapshot().jobs[0]!;
  assert.equal(job.status,'completed',JSON.stringify(job.events));assert.deepEqual(dispatched,['fill','submit_search']);
  assert.equal(vm.runInContext('window.nativeSubmissions',doc.world),1);assert.equal(job.approval,null);
 }finally{await runtime?.shutdown();t.mock.restoreAll();await env.cleanup();}
});

test('bounded runtime planning survives repeated passive Naver news and in-form decoration updates and executes focused native fill',async t=>{
 const env=await setup();let runtime:AgentRuntime|undefined;
 try{
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'focused-goal',url:'https://www.naver.com/',host:nativeHost(env.host)});
  const wc=[...env.host.children][0]!.webContents,doc=searchDocument();
  const scripts:string[]=[];
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async(_world:number,items:{code:string}[])=>{
   scripts.push(...items.map(item=>item.code));
   if(/window\.__sideworkDOM\.(snapshot|act)\(/.test(items[0]!.code))return vm.runInContext(items[0]!.code,doc.world);
  });
  let plans=0,executions=0;
  runtime=new AgentRuntime({store:new RuntimeStore(join(env.dataRoot,'runtime')),
   browser:{observe:(context,options)=>env.controller.observe(context,options),execute:async(action,context)=>{const result=await env.controller.execute(action,context);executions++;return result;}},
   planner:{next:async input=>{
    plans++;
    if(input.history.some(event=>event.kind==='action'))return {thought:'Verified native fill',action:{type:'finish',text:'Filled'}};
    for(let n=0;n<5;n++){doc.news();doc.animate();await new Promise<void>(resolve=>setImmediate(resolve));}
    return {thought:'Fill only the observed native query',action:{type:'fill',ref:input.observation.elements.find(el=>el.interaction?.kind==='input')!.ref,value:'public weather search'}};
   }},onChange:snapshot=>env.controller.updateControlJobs(snapshot.jobs)});
  await runtime.initialize();
  await runtime.start({prompt:'Search Naver',...page.context,computerUse:false,initialDocument:{url:'https://www.naver.com/',revision:env.controller.getAgentState().tabs[0]!.revision,documentId:'native-search-doc'},agentScope:{areaId:page.areaId,goalId:'focused-goal',origin:'https://www.naver.com',allowedOrigins:['https://www.naver.com','https://search.naver.com'],expiresAt:new Date(Date.now()+60000).toISOString()}});
  for(let n=0;n<500&&runtime.snapshot().activeJobId;n++)await new Promise(resolve=>setTimeout(resolve,3));
  const job=runtime.snapshot().jobs[0]!;
  assert.equal(job.status,'completed',JSON.stringify(job.events));
  assert.equal(executions,1);assert.equal(plans,2);
  assert.equal(vm.runInContext('field.value',doc.world),'public weather search');
  assert(!job.events.some(event=>event.text.includes('계획을 폐기')));
  assert.equal(job.approval,null);
  assert(scripts.some(code=>code.includes('"observation":{"kind":"provider-search"')),'DOM act must use the trusted observe mode');
  assert.doesNotMatch(JSON.stringify(job),/private-route-state/);
 }finally{await runtime?.shutdown();t.mock.restoreAll();await env.cleanup();}
});

for(const scenario of ['main-loading','manual','legacy','computer','share','approval','expired','foreign-goal','foreign-area','wrong-job','missing-origin','result-page','ordinary','cancel-all','takeover','profile','scope-change','native-frame','during-observe-frame','screenshot','computer-capture'] as const)test(`focused observation binding fails closed: ${scenario}`,async t=>{
 const env=await setup();try{
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'bound-goal',url:'https://www.naver.com/',host:nativeHost(env.host)});
  const wc=[...env.host.children][0]!.webContents,doc=searchDocument();
  let replaceDuringRead=false;
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async(_world:number,items:{code:string}[])=>{
   wc.isolatedScripts.push(...items.map(item=>item.code));
   if(/window\.__sideworkDOM\.(snapshot|act)\(/.test(items[0]!.code)){
    const result=vm.runInContext(items[0]!.code,doc.world);
    if(replaceDuringRead)wc.mainFrame={};
    return result;
   }
  });
  const job:Job={id:'bound-job',...page.context,prompt:'Search',status:'running',createdAt:'now',updatedAt:'now',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,computerUse:false,shareScreen:false,agentScope:{goalId:'bound-goal',areaId:page.areaId,origin:'https://www.naver.com',allowedOrigins:['https://www.naver.com','https://search.naver.com'],expiresAt:new Date(Date.now()+60000).toISOString()}};
  const bootstrap=await env.controller.observe(page.context);
  assert.equal(bootstrap.observationMode,undefined);assert.equal(bootstrap.readingViewport?.documentId,'native-search-doc','Goal bootstrap keeps full viewport identity');
  switch(scenario){
   case 'main-loading':Object.assign(wc,{isLoadingMainFrame:()=>true});break;
   case 'legacy': delete job.agentScope!.goalId;break;
   case 'computer':job.computerUse=true;break;
   case 'share':job.shareScreen=true;break;
   case 'approval':job.status='awaiting_approval';break;
   case 'expired':job.agentScope!.expiresAt='2000-01-01T00:00:00Z';break;
   case 'foreign-goal':job.agentScope!.goalId='different-goal';break;
   case 'foreign-area':job.agentScope!.areaId='different-area';break;
   case 'missing-origin':job.agentScope!.allowedOrigins=['https://search.naver.com'];break;
   case 'result-page':await wc.loadURL('https://www.naver.com/results');vm.runInContext("location.href='https://www.naver.com/results'",doc.world);break;
   case 'ordinary':await env.controller.returnFromAgent(page.context);break;
  }
  env.controller.updateControlJobs([job]);await new Promise<void>(resolve=>setImmediate(resolve));
  if(['cancel-all','takeover','profile','scope-change','native-frame','during-observe-frame','screenshot','computer-capture'].includes(scenario)){
   const first=await env.controller.observe(page.context,{jobId:job.id});
   assert.equal(first.observationMode,'search-form');
   if(scenario==='cancel-all')await env.controller.cancelControlVisuals();
   if(scenario==='takeover')await env.controller.returnFromAgent(page.context);
   if(scenario==='profile'){const id=await env.controller.createProfile('Other');await env.controller.activateProfile(id);}
   if(scenario==='scope-change'){job.agentScope!.allowedOrigins=['https://www.naver.com'];env.controller.updateControlJobs([job]);}
   if(scenario==='native-frame')wc.mainFrame={};
   if(scenario==='during-observe-frame')replaceDuringRead=true;
   if(scenario==='computer-capture'){
    vm.runInContext("element('INPUT',{type:'password',name:'password'});",doc.world);
    job.computerUse=true;job.shareScreen=true;env.controller.updateControlJobs([job]);
    await assert.rejects(env.controller.observe(page.context,{jobId:job.id,computerUse:true,shareScreen:true}),/capture prohibited/i);
    assert(wc.isolatedScripts.at(-1)!.endsWith('snapshot()'),'Pixel preflight uses the full page view');
   }else{
    await assert.rejects(env.controller.execute(scenario==='screenshot'?{type:'screenshot'}:{type:'fill',ref:first.elements[0]!.ref,value:'must-not-write'},{...page.context,jobId:job.id,expectedRevision:first.revision}),/stale|cancel|profile|changed/i);
    if(scenario==='screenshot')assert(wc.isolatedScripts.at(-1)!.endsWith('snapshot()'),'Screenshot refresh uses full privacy checks, never a focused view');
   }
   assert.notEqual(vm.runInContext('field.value',doc.world),'must-not-write');
  }else{
   const observation=await env.controller.observe(page.context,scenario==='manual'?undefined:{jobId:scenario==='wrong-job'?'spoofed-job':job.id});
   assert.equal(observation.observationMode,undefined,scenario);
   assert(observation.readingViewport,'These observations must remain full, not partial text labelled viewport');
  }
 }finally{t.mock.restoreAll();await env.cleanup();}
});

for(const mode of ['goal','legacy','computer','cancel'] as const)test(`native navigation preserves only live goal DOM work: ${mode}`,async t=>{
 const env=await setup();try{
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'navigate-goal',url:'https://docs.example.com/',host:nativeHost(env.host)});
  const wc=[...env.host.children][0]!.webContents;
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async(_world:number,scripts:{code:string}[])=>{
   wc.isolatedScripts.push(...scripts.map(s=>s.code));
   if(scripts[0]!.code.endsWith('snapshot()'))return {stamp:'new-document',url:wc.url,title:'Results',text:'Real fixture result',elements:[],computer:{captureBlocked:false,focusBlocked:false,viewportWidth:460,viewportHeight:680,links:[]}};
  });
  const job:Job={id:'navigation-job',...page.context,prompt:'Search',status:'running',createdAt:'now',updatedAt:'now',events:[],artifacts:[],answer:null,error:null,approval:null,steps:2,computerUse:mode==='computer',shareScreen:mode==='computer',agentScope:{areaId:page.areaId,origin:'https://docs.example.com',expiresAt:new Date(Date.now()+60000).toISOString(),...(mode==='legacy'?{}:{goalId:'navigate-goal',allowedOrigins:['https://docs.example.com']})}};
  env.controller.updateControlJobs([job]);await new Promise<void>(r=>setImmediate(r));
  assert.equal(env.controller.getControlVisuals().length,1);
  await wc.loadURL('https://docs.example.com/results');
  assert.equal(env.controller.getControlVisuals().length,0,'Old-document feedback must be invalidated');
  env.controller.updateControlJobs([job]);
  if(mode==='cancel')await env.controller.cancelControlVisuals(job.id);
  wc.emit('did-stop-loading');env.controller.updateControlJobs([job]);await new Promise<void>(r=>setImmediate(r));
  const revision=env.controller.getState().tabs.find(t=>t.id===page.context.tabId)!.revision;
  if(mode==='goal'){
   assert.equal(env.controller.getControlVisuals().length,1,'Normal goal navigation must not permanently cancel the job');
   await env.controller.execute({type:'scroll',direction:'down'},{...page.context,jobId:job.id,expectedRevision:revision});
   assert(wc.isolatedScripts.some(code=>code.includes('"type":"scroll"')));
  }else{
   assert.equal(env.controller.getControlVisuals().length,0);
   await assert.rejects(env.controller.execute({type:'scroll',direction:'down'},{...page.context,jobId:job.id,expectedRevision:revision}),/cancelled/i);
  }
 }finally{t.mock.restoreAll();await env.cleanup();}
});

test('goal native defaults reserve the approved left task sidebar without hiding or overlapping peer pages',async()=>{
 const env=await setup();try{
  await env.controller.createGoalPage({profileId:'default',goalId:'left-ui-goal',url:'https://docs.example.com/a',host:nativeHost(env.host)});
  await env.controller.createGoalPage({profileId:'default',goalId:'left-ui-goal',url:'https://docs.example.com/b',host:nativeHost(env.host)});
  const views=[...env.host.children];assert.equal(views.length,2);
  assert.deepEqual(views[0]!.bounds,{x:280,y:88+32,width:Math.floor((1200-280)/2),height:800-88-32});
  assert.deepEqual(views[1]!.bounds,{x:280+Math.floor((1200-280)/2),y:88+32,width:Math.floor((1200-280)/2),height:800-88-32});
  assert(views.every(view=>view.visible));
 }finally{await env.cleanup();}
});

test('DOM-only goal settlement needs no pixels and rejects replaced native frames or user pages',async t=>{
 const env=await setup();try{
  const user=env.controller.getContext();
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'dom-goal',url:'https://docs.example.com/',host:nativeHost(env.host)});
  t.mock.method(env.controller,'captureUserPreview',async()=>{assert.fail('DOM settlement must never request pixels');});
  await env.controller.settleGoalPage(page.context);
  const wc=[...env.host.children][0]!.webContents;
  assert(wc.isolatedScripts.some(code=>code.includes('requestAnimationFrame')&&code.includes('1000')));
  await assert.rejects(env.controller.settleGoalPage(user));
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async()=>{wc.mainFrame={};});
  await assert.rejects(env.controller.settleGoalPage(page.context),/changed|stale/i);
 }finally{t.mock.restoreAll();await env.cleanup();}
});

test('goal native attachment failure releases its own host binding and leaves unrelated host listeners and pages intact', async () => {
  const env = await setup();
  try {
    const before = env.controller.getState(), unrelated = () => {};
    env.host.on('resize', unrelated);
    env.host.contentView.addChildView = () => { throw new Error('native attach failed'); };
    await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId: 'attach-goal', url: 'https://attach.test/', host: nativeHost(env.host) }), /native attach failed/);
    assert.deepEqual(env.controller.getState(), before);
    assert.deepEqual(env.host.listeners('resize'), [unrelated]);
    const replacement = new FakeWindow();
    await env.controller.createGoalPage({ profileId: 'default', goalId: 'attach-goal', url: 'https://attach.test/', host: nativeHost(replacement) });
    assert.equal(replacement.children.size, 1);
  } finally { await env.cleanup(); }
});

test('goal-owned native navigation blocks unsafe redirects and frame navigation without changing ordinary policy', async () => {
  const env = await setup();
  try {
    await env.controller.createGoalPage({ profileId: 'default', goalId: 'redirect-goal', url: 'https://redirect.test/', host: nativeHost(env.host) });
    const wc = [...env.host.children][0]!.webContents;
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      for (const url of ['http://localhost/', 'http://192.168.0.1/', 'https://example.test/?session=x', 'https://example.test/#token=x', 'file:///private/test']) {
        let denied = false;
        wc.emit(event, { url, preventDefault: () => { denied = true; } }, url);
        assert.equal(denied, true, `${event}: ${url}`);
      }
      let denied = false;
      wc.emit(event, { url: 'https://public.test/article', preventDefault: () => { denied = true; } }, 'https://public.test/article');
      assert.equal(denied, false);
    }
    let denied = false;
    [...env.window.children][0]!.webContents.emit('will-navigate', { preventDefault: () => { denied = true; } }, 'http://localhost/');
    assert.equal(denied, false);
  } finally { await env.cleanup(); }
});

test('task-created pages never enter ordinary closed history or persisted session even after takeover', async () => {
  const env = await setup();
  try {
    const ordinary = env.controller.getContext();
    const create = (path: string) => env.controller.createGoalPage({ profileId: 'default', goalId: 'no-history', url: `https://ephemeral.test/${path}`, host: nativeHost(env.host) });
    const a = await create('closed'), b = await create('returned');
    await env.controller.returnFromAgent(b.context);
    await env.controller.closeTab(a.context.tabId);
    await env.controller.closeTab(b.context.tabId);
    await create('retained');
    assert.equal(env.controller.getState().closedTabCount, 0);
    assert.deepEqual(env.controller.getContext(), ordinary);
    await env.controller.dispose();
    const saved = await readFile(join(env.dataRoot, 'browser-session.json'), 'utf8');
    assert.doesNotMatch(saved, /ephemeral\.test|sidework-goal|no-history/);
    const parsed: { tabs: { url: string }[]; closedTabs: unknown[] } = JSON.parse(saved);
    assert.deepEqual(parsed.tabs.map(tab => tab.url), ['https://ordinary.test/article']);
    assert.deepEqual(parsed.closedTabs, []);
  } finally { await env.cleanup(); }
});

test('goal allocation rejects ninth pages and mismatched host/profile without mutating existing pages', async () => {
  const env = await setup();
  try {
    const create = (host = env.host, profileId = 'default') => env.controller.createGoalPage({ profileId, goalId: 'capacity-goal', url: 'https://capacity.test/article', host: nativeHost(host) });
    await create();
    await assert.rejects(create(new FakeWindow()), /host/i);
    const inactive = await env.controller.createProfile('Inactive');
    await assert.rejects(create(env.host, inactive), /profile/i);
    await env.controller.activateProfile(inactive);
    await assert.rejects(create(env.host, inactive), /profile/i);
    await env.controller.activateProfile('default');
    for (let index = 1; index < 8; index++) {
      await create();
      assert.equal(env.controller.getAgentState().splitCount, index < 2 ? 2 : index < 4 ? 4 : 8);
    }
    const before = env.controller.getState(), count = FakeView.all.length;
    await assert.rejects(create(), /capacity|eight/i);
    assert.deepEqual(env.controller.getState(), before); assert.equal(FakeView.all.length, count);
    assert.equal(new Set(env.controller.getAgentState().tabs.map(tab => tab.agentAreaId)).size, 8);
    assert.equal(env.host.children.size, 8);
  } finally { await env.cleanup(); }
});

test('failed task loading removes only its own page and preserves ordinary and unrelated native resources', async () => {
  const env = await setup();
  try {
    const foreign = new FakeView({ webPreferences: {} }); env.host.contentView.addChildView(foreign);
    const before = env.controller.getState(), ordinary = [...env.window.children];
    const count = FakeView.all.length;
    FakeContents.load = async () => { throw new Error('fixture load failed'); };
    await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId: 'failure-goal', url: 'https://failure.test/', host: nativeHost(env.host) }), /fixture load failed/);
    assert.deepEqual(env.controller.getState(), before); assert.deepEqual([...env.window.children], ordinary);
    assert.deepEqual([...env.host.children], [foreign]); assert.equal(foreign.webContents.destroyed, false);
    assert.equal(FakeView.all[count]!.webContents.destroyed, true);
    FakeContents.load = undefined;
    const result = await env.controller.createGoalPage({ profileId: 'default', goalId: 'retry-goal', url: 'https://retry.test/', host: nativeHost(env.host) });
    assert.equal(env.controller.getAgentState().paneTabIds![0], result.context.tabId);
  } finally { await env.cleanup(); }
});

test('a load rejection after explicit takeover cannot delete the now ordinary native page', async () => {
  const env = await setup(); let rejectLoad: ((error: Error) => void) | undefined;
  try {
    FakeContents.load = async () => await new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    const pending = env.controller.createGoalPage({ profileId: 'default', goalId: 'race-goal', url: 'https://race.test/', host: nativeHost(env.host) });
    const rejected = assert.rejects(pending, /load rejected/);
    const tab = env.controller.getAgentState().tabs[0]!, view = [...env.host.children][0]!;
    await env.controller.returnFromAgent({ profileId: 'default', tabId: tab.id });
    assert(rejectLoad); rejectLoad(new Error('load rejected')); await rejected;
    assert(env.window.children.has(view)); assert.equal(view.webContents.destroyed, false);
    assert.equal(env.controller.getContext().tabId, tab.id);
    assert.equal(env.controller.getState().tabs.find(item => item.id === tab.id)!.agentAreaId, undefined);
  } finally { rejectLoad?.(new Error('cleanup')); await env.cleanup(); }
});

test('goal bootstrap rejects unsafe URLs, invalid identities, foreign profiles and invalid hosts before allocating', async () => {
  const env = await setup();
  try {
    const before = env.controller.getState(), count = FakeView.all.length;
    for (const url of ['about:blank', 'javascript:alert(1)', 'file:///private/a', 'https://user:pass@example.com/', 'https://example.com/?token=x', 'https://example.com/#code=x', 'https://example.com/?api_key=x', 'http://localhost/', 'http://app.localhost/', 'http://service.local/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.2/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/', 'http://intranet/']) {
      await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId: 'safe-goal', url, host: nativeHost(env.host) }), /.+/, url);
    }
    for (const goalId of ['', '../other', 'x'.repeat(201)]) {
      await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId, url: 'https://public.test/', host: nativeHost(env.host) }));
    }
    await assert.rejects(env.controller.createGoalPage({ profileId: 'foreign', goalId: 'safe-goal', url: 'https://public.test/', host: nativeHost(env.host) }), /profile/i);
    await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId: 'safe-goal', url: 'https://public.test/', host: nativeHost(env.window) }), /host/i);
    env.host.destroyed = true;
    await assert.rejects(env.controller.createGoalPage({ profileId: 'default', goalId: 'safe-goal', url: 'https://public.test/', host: nativeHost(env.host) }), /host/i);
    env.host.destroyed = false;
    assert.deepEqual(env.controller.getState(), before); assert.equal(FakeView.all.length, count);
    // The task-only boundary must not tighten ordinary manual browser navigation.
    await env.controller.navigate('http://localhost/');
    assert.equal(env.controller.getState().tabs[0]!.url, 'http://localhost/');
  } finally { await env.cleanup(); }
});

test('goal pages share only their task ephemeral session and takeover preserves native identity without cookie migration', async () => {
  const env = await setup();
  try {
    const create = (goalId: string) => env.controller.createGoalPage({ profileId: 'default', goalId, url: 'https://research.test/article', host: nativeHost(env.host) });
    const a = await create('same-goal'), first = [...env.host.children][0]!;
    const bounds = structuredClone(first.bounds), revision = env.controller.getAgentState().tabs[0]!.revision;
    const b = await create('same-goal'), second = [...env.host.children][1]!;
    assert.notEqual(a.areaId, b.areaId); assert.notEqual(a.context.tabId, b.context.tabId);
    assert.deepEqual(first.bounds, bounds); assert.equal(env.controller.getAgentState().tabs[0]!.revision, revision);
    const normalSession = [...env.window.children][0]!.options.webPreferences.session;
    const taskSession = first.options.webPreferences.session;
    assert.notEqual(taskSession, normalSession);
    assert.equal(second.options.webPreferences.session, taskSession);
    const partition = [...sessions].find(([, value]) => value === taskSession)![0];
    assert(!partition.startsWith('persist:')); assert(!partition.includes('same-goal'));
    assert.equal(JSON.stringify(env.controller.getState()).includes(partition), false);
    await create('different-goal');
    assert.notEqual([...env.host.children][2]!.options.webPreferences.session, taskSession);
    const wc = first.webContents, loads = [...wc.loads];
    await env.controller.returnFromAgent(a.context);
    assert(env.window.children.has(first)); assert(!env.host.children.has(first));
    assert.equal(first.webContents, wc); assert.deepEqual(wc.loads, loads);
    assert.equal(first.options.webPreferences.session, taskSession);
    assert.equal(wc.backgroundThrottling, true);
    assert.equal(env.controller.getContext().tabId, a.context.tabId);
    assert.equal(env.controller.getState().tabs.find(tab => tab.id === a.context.tabId)!.ownership, 'agent');
    const secondBounds = structuredClone(second.bounds);
    assert.equal(env.controller.getAgentState().paneTabIds![0], '');
    await create('same-goal');
    assert.deepEqual(second.bounds, secondBounds);
    assert.equal(env.controller.getAgentState().paneTabIds![1], b.context.tabId);
    await env.controller.dispose();
    assert.equal((taskSession as FakeSession).cleared, 1);
  } finally { await env.cleanup(); }
});

test('goal page materializes directly in agent host without touching ordinary tabs or selection', async () => {
  const env = await setup();
  try {
    await env.controller.setSplitCount(2);
    const before = env.controller.getState(), additions = env.window.additions.length;
    const ordinaryViews = [...env.window.children];
    const result = await env.controller.createGoalPage({ profileId: 'default', goalId: 'goal-one', url: 'https://research.test/article', host: nativeHost(env.host) });
    const after = env.controller.getState(), agent = env.controller.getAgentState();
    assert.equal(after.activeTabId, before.activeTabId);
    assert.deepEqual(after.paneTabIds, before.paneTabIds);
    assert.equal(after.closedTabCount, before.closedTabCount);
    assert.deepEqual(after.tabs.filter(tab => before.tabs.some(prior => prior.id === tab.id)), before.tabs);
    assert.equal(env.window.additions.length, additions, 'No transient ordinary native attachment');
    assert.deepEqual([...env.window.children], ordinaryViews);
    assert.deepEqual(result.context, { profileId: 'default', tabId: agent.tabs[0]!.id });
    assert.equal(agent.tabs[0]!.ownership, 'agent');
    assert.equal(agent.tabs[0]!.agentAreaId, result.areaId);
    assert.equal(agent.tabs[0]!.lifecycle, 'live');
    assert.equal(env.host.children.size, 1);
    const view = [...env.host.children][0]!;
    assert.deepEqual(view.webContents.loads, ['https://research.test/article']);
    assert.equal(view.webContents.backgroundThrottling, false);
    assert.equal(view.options.webPreferences.nodeIntegration, false);
    assert.equal(view.options.webPreferences.sandbox, true);
    assert.equal(view.options.webPreferences.preload, undefined);
    assert.equal(view.visible, true);
  } finally { await env.cleanup(); }
});

test('native subframe loading between planning and authorize must not switch a focused goal to full-page evidence',async t=>{
 const env=await setup();let runtime:AgentRuntime|undefined;
 try{
  const page=await env.controller.createGoalPage({profileId:'default',goalId:'focused-goal',url:'https://www.naver.com/',host:nativeHost(env.host)});
  const wc=[...env.host.children][0]!.webContents,doc=searchDocument();
  const scripts:string[]=[];
  t.mock.method(wc,'executeJavaScriptInIsolatedWorld',async(_world:number,items:{code:string}[])=>{
   scripts.push(...items.map(item=>item.code));
   if(/window\.__sideworkDOM\.(snapshot|act)\(/.test(items[0]!.code))return vm.runInContext(items[0]!.code,doc.world);
  });
  let plans=0,executions=0;
  t.mock.method(wc,'isLoading',()=>true);
  Object.assign(wc,{isLoadingMainFrame:()=>false});
  runtime=new AgentRuntime({store:new RuntimeStore(join(env.dataRoot,'runtime')),
   browser:{observe:(context,options)=>env.controller.observe(context,options),execute:async(action,context)=>{const result=await env.controller.execute(action,context);executions++;return result;}},
   planner:{next:async input=>{
    plans++;
    if(input.history.some(event=>event.kind==='action'))return {thought:'Verified native fill',action:{type:'finish',text:'Filled'}};
    wc.emit('did-start-loading');
    for(let n=0;n<5;n++){doc.news();doc.animate();await new Promise<void>(resolve=>setImmediate(resolve));}
    return {thought:'Fill only the observed native query',action:{type:'fill',ref:input.observation.elements.find(el=>el.interaction?.kind==='input')!.ref,value:'public weather search'}};
   }},onChange:snapshot=>env.controller.updateControlJobs(snapshot.jobs)});
  await runtime.initialize();
  await runtime.start({prompt:'Search Naver',...page.context,computerUse:false,initialDocument:{url:'https://www.naver.com/',revision:env.controller.getAgentState().tabs[0]!.revision,documentId:'native-search-doc'},agentScope:{areaId:page.areaId,goalId:'focused-goal',origin:'https://www.naver.com',allowedOrigins:['https://www.naver.com','https://search.naver.com'],expiresAt:new Date(Date.now()+60000).toISOString()}});
  for(let n=0;n<500&&runtime.snapshot().activeJobId;n++)await new Promise(resolve=>setTimeout(resolve,3));
  const job=runtime.snapshot().jobs[0]!;
  assert.equal(job.status,'completed',JSON.stringify(job.events));
  assert.equal(executions,1);assert.equal(plans,2);
  assert.equal(vm.runInContext('field.value',doc.world),'public weather search');
  assert(!job.events.some(event=>event.text.includes('계획을 폐기')));
  assert.equal(job.approval,null);
  assert(scripts.some(code=>code.includes('"observation":{"kind":"provider-search"')),'DOM act must use the trusted observe mode');
  assert.doesNotMatch(JSON.stringify(job),/private-route-state/);
 }finally{await runtime?.shutdown();t.mock.restoreAll();await env.cleanup();}
});
