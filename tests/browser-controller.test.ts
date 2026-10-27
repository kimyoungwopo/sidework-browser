import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserWindow } from 'electron';

class FakeSession extends EventEmitter {
  request: ((...args: unknown[]) => void) | null = null;
  check: (() => boolean) | null = null;
  setPermissionRequestHandler(handler: typeof this.request) { this.request = handler; }
  setPermissionCheckHandler(handler: typeof this.check) { this.check = handler; }
  setDevicePermissionHandler() {}
  async clearStorageData() {}
  async clearCache() {}
  flushStorageData() {}
}
const sessions = new Map<string, FakeSession>();
class FakeDebugger extends EventEmitter {
  attached=false; attaches=0; detaches=0; commands:{method:string;params:unknown}[]=[];
  isAttached(){return this.attached;}
  attach(version:string){assert.equal(version,'1.3');this.attached=true;this.attaches++;}
  detach(){this.attached=false;this.detaches++;this.emit('detach');}
  async sendCommand(method:string,params:unknown){this.commands.push({method,params});}
}
class FakeContents extends EventEmitter {
  url = 'about:blank'; destroyed = false; stamp = 'doc:0'; calls: string[] = []; loads:string[]=[];
  captureCount=0; pixels='owned-frame'; inputEvents:unknown[]=[]; typed:string[]=[];
  caretVisible=false;insertedStyles=new Set<string>();
  async insertCSS(css:string,options:{cssOrigin:string}) {assert.match(css,/caret-color:\s*transparent/);assert.equal(options.cssOrigin,'user');this.insertedStyles.add('caret');return 'caret';}
  async removeInsertedCSS(key:string) {this.insertedStyles.delete(key);}
  debugger=new FakeDebugger();
  computer={captureBlocked:false,focusBlocked:false,viewportWidth:1200,viewportHeight:712,links:[] as {x:number;y:number;width:number;height:number;url:string}[]};
  sendInputEvent(event:unknown) {this.inputEvents.push(event);}
  async insertText(value:string) {this.typed.push(value);}
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} };
  popup: (() => { action: string }) | undefined;
  setWindowOpenHandler(handler: typeof this.popup) { this.popup = handler; }
  getURL() { return this.url; }
  getTitle() { return 'Fixture'; }
  isLoading() { return false; }
  isDestroyed() { return this.destroyed; }
  backgroundThrottling=true;
  setBackgroundThrottling(allowed:boolean) {this.backgroundThrottling=allowed;}
  async loadURL(url: string) { this.loads.push(url);this.url = url; this.emit('did-start-navigation', {}, url, false, true); this.emit('did-navigate', {}, url); this.emit('did-stop-loading'); }
  reload() { this.emit('did-start-loading'); }
  stop() {}
  vetoClose = false; hangClose = false; closeAttempts = 0; overrides = 0;
  close(options?: { waitForBeforeUnload: boolean }) {
    this.closeAttempts++;
    if (this.hangClose) return;
    if (options?.waitForBeforeUnload && this.vetoClose) {
      let allowed = false;
      this.emit('will-prevent-unload', { preventDefault: () => { allowed = true; this.overrides++; } });
      if (!allowed) return;
    }
    this.destroyed = true; this.emit('destroyed');
  }
  async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]):Promise<boolean|import('../src/desktop/browser-dom.ts').DOMSnapshot|undefined> {
    assert.equal(world, 1001);
    this.calls.push(scripts[0]!.code);
    if(scripts[0]!.code.includes('__sideworkVisuals.hit(')) return true;
    if (scripts[0]!.code.endsWith('.snapshot()')) return { computer:structuredClone(this.computer), stamp: this.stamp, url: this.url, title: 'Fixture', text: 'Hello', elements: [{ ref: 'r1', tag: 'button', role: '', name: 'Go', inputType: '', sensitive: false }] };
    return undefined;
  }
  async capturePage() { this.captureCount++; const pixels=this.pixels+(this.caretVisible&&!this.insertedStyles.size?'-caret':''); return { isEmpty: () => false, getSize:()=>({width:1200,height:712}), toPNG: () => Buffer.from(pixels==='owned-frame'?'test-only-image':pixels) }; }
}
class FakeView {
  webContents = new FakeContents(); visible = false; bounds: unknown;
  static all: FakeView[] = [];
  options: { webPreferences: Record<string, unknown> };
  constructor(options: { webPreferences: Record<string, unknown> }) { this.options = options; FakeView.all.push(this); }
  setVisible(v: boolean) { this.visible = v; }
  setBounds(bounds: unknown) { this.bounds = bounds;const size=bounds as {width:number;height:number};this.webContents.computer.viewportWidth=size.width;this.webContents.computer.viewportHeight=size.height; }
}
class FakeWindow extends EventEmitter {
  destroyed=false;
  focuses=0;inputEvents:unknown[]=[];
  webContents={focus:()=>{this.focuses++;},sendInputEvent:(event:unknown)=>{this.inputEvents.push(event);}};
  children = new Set<FakeView>();
  contentView = { addChildView: (view: FakeView) => this.children.add(view), removeChildView: (view: FakeView) => this.children.delete(view) };
  getContentBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
  isDestroyed() { return this.destroyed; }
}
Object.assign(globalThis, { __browserElectronMock: { WebContentsView: FakeView, session: { fromPartition: (id: string) => { if (!sessions.has(id)) sessions.set(id, new FakeSession()); return sessions.get(id); } } } });
registerHooks({
  resolve(specifier, context, next) { return specifier === 'electron' ? { url: 'sidework:electron', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'sidework:electron' ? { format: 'module', source: 'export const {WebContentsView, session} = globalThis.__browserElectronMock', shortCircuit: true } : next(url, context); },
});
let BrowserController: typeof import('../src/desktop/browser.ts').BrowserController;

test('adding and reclaiming a second agent page does not resize the first task viewport',async()=>{
 const env=await setup();try{
  const host=new FakeWindow();
  await env.controller.navigate('https://stable-a.test/');const a=env.controller.getContext(),va=[...env.window.children][0]!;
  await env.controller.handoffToAgent(a,host as unknown as BrowserWindow);
  const boundsA=structuredClone(va.bounds),revisionA=env.controller.getState().tabs.find(tab=>tab.id===a.tabId)!.revision;
  await env.controller.navigate('https://stable-b.test/');const b=env.controller.getContext(),vb=[...env.window.children].find(view=>view.webContents.url==='https://stable-b.test/')!;
  await env.controller.handoffToAgent(b,host as unknown as BrowserWindow);
  assert.deepEqual(va.bounds,boundsA);assert.equal(env.controller.getState().tabs.find(tab=>tab.id===a.tabId)!.revision,revisionA);
  const boundsB=structuredClone(vb.bounds),revisionB=env.controller.getState().tabs.find(tab=>tab.id===b.tabId)!.revision;
  await env.controller.returnFromAgent(a);
  assert.deepEqual(vb.bounds,boundsB);assert.equal(env.controller.getState().tabs.find(tab=>tab.id===b.tabId)!.revision,revisionB);
 }finally{await env.cleanup();}
});

test('agent handoff preserves native contents and replaces the user slot with a separate blank page',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://handoff.test/form');
  const context=env.controller.getContext(),view=[...env.window.children][0]!,wc=view.webContents,host=new FakeWindow();
  wc.stamp='filled-form:7';const url=wc.url,loads=[...wc.loads];
  const result=await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  assert.deepEqual(result.context,context);assert.match(result.areaId,/^[a-f0-9-]{36}$/);
  assert.equal(view.webContents,wc);assert.equal(wc.stamp,'filled-form:7');assert.equal(wc.url,url);assert.equal(wc.destroyed,false);
  assert.deepEqual(wc.loads,loads,'Handoff must not reload the existing document');
  assert(host.children.has(view));assert(!env.window.children.has(view));
  const state=env.controller.getState();assert.deepEqual(state.agentPaneTabIds,[context.tabId]);
  assert.equal(state.tabs.find(tab=>tab.id===context.tabId)!.agentAreaId,result.areaId);
  assert(!state.paneTabIds!.includes(context.tabId));assert.notEqual(state.activeTabId,context.tabId);
  assert.equal(state.tabs.find(tab=>tab.id===state.activeTabId)!.url,'about:blank');
 }finally{await env.cleanup();}
});

test('agent panes retain their own host grid and revisions while ordinary browsing changes layout and split',async()=>{
 const env=await setup();try{
  const host=new FakeWindow();
  await env.controller.navigate('https://agent-a.test/');const a=env.controller.getContext(),va=[...env.window.children][0]!;
  const first=await env.controller.handoffToAgent(a,host as unknown as BrowserWindow);
  await env.controller.navigate('https://agent-b.test/');const b=env.controller.getContext(),vb=[...env.window.children].find(view=>view.webContents.url==='https://agent-b.test/')!;
  const second=await env.controller.handoffToAgent(b,host as unknown as BrowserWindow);
  assert.notEqual(first.areaId,second.areaId);
  env.controller.setAgentLayout({top:88,left:0,bottom:0,sidebarWidth:360,hideBrowser:false});
  const agent=env.controller.getAgentState();assert.equal(agent.splitCount,2);assert.deepEqual(agent.paneTabIds,[a.tabId,b.tabId]);assert.equal(agent.tabs.length,2);
  assert.equal(va.visible,true);assert.equal(vb.visible,true);const bounds=structuredClone(va.bounds);
  await env.controller.newTab('https://user-next.test/');await env.controller.setSplitCount(8);
  env.controller.setLayout({top:400,left:50,bottom:20,sidebarWidth:600,hideBrowser:true});env.window.emit('resize');
  assert.deepEqual(va.bounds,bounds);assert.equal(va.visible,true);assert.equal(vb.visible,true);
  assert.deepEqual(env.controller.getAgentState(),agent);
  assert(!env.controller.getState().paneTabIds!.includes(a.tabId));assert(!env.controller.getState().paneTabIds!.includes(b.tabId));
  assert.throws(()=>env.controller.activateTab(a.tabId),/agent|unknown/i);
  assert(host.children.has(va));assert(host.children.has(vb));assert(!env.window.children.has(va));
  await assert.doesNotReject(env.controller.observe(a));
 }finally{await env.cleanup();}
});

test('explicit agent return restores the same native page with throttling and revokes old frames both ways',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://return.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!,wc=view.webContents,host=new FakeWindow();
  const before=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  const loads=[...wc.loads];
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  assert.equal(wc.backgroundThrottling,false);
  await assert.rejects(env.controller.execute({type:'computer_key',key:'Tab',frameId:before.screen!.frameId},{...context,jobId:'before-handoff',expectedRevision:before.revision}),/stale|frame|revision/i);
  const agent=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  await env.controller.returnFromAgent(context);
  assert.equal(wc.backgroundThrottling,true);assert.equal(env.controller.getContext().tabId,context.tabId);
  assert(env.window.children.has(view));assert(!host.children.has(view));assert.equal(wc.destroyed,false);
  assert.deepEqual(wc.loads,loads,'Return must not reload the existing document');
  assert.equal(env.controller.getState().tabs.find(tab=>tab.id===context.tabId)!.agentAreaId,undefined);
  assert.deepEqual(env.controller.getAgentState().tabs,[]);assert.deepEqual(env.controller.getState().agentPaneTabIds,[]);
  await assert.rejects(env.controller.execute({type:'computer_key',key:'Tab',frameId:agent.screen!.frameId},{...context,jobId:'before-return',expectedRevision:agent.revision}),/stale|frame|revision/i);
  await assert.rejects(env.controller.returnFromAgent(context),/agent/i);
  assert.equal(wc.debugger.commands.length,0);
 }finally{await env.cleanup();}
});

test('agent native close and disposal detach from the exact host and retain unrelated listeners',async()=>{
 const env=await setup(undefined,()=>false);const host=new FakeWindow(),unrelated=()=>{};host.on('resize',unrelated);
 try{
  await env.controller.navigate('https://close-agent.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!,wc=view.webContents;
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  wc.vetoClose=true;await env.controller.closeTab(context.tabId);
  assert(host.children.has(view));assert.equal(wc.destroyed,false);assert.equal(env.controller.getAgentState().tabs.length,1);
  wc.vetoClose=false;await env.controller.closeTab(context.tabId);
  assert(!host.children.has(view));assert.equal(wc.destroyed,true);assert.deepEqual(env.controller.getAgentState().tabs,[]);
  await env.controller.navigate('https://dispose-agent.test/');const second=env.controller.getContext(),next=[...env.window.children].find(v=>v.webContents.url==='https://dispose-agent.test/')!;
  await env.controller.handoffToAgent(second,host as unknown as BrowserWindow);
  await env.controller.dispose();assert.equal(next.webContents.destroyed,true);assert.equal(host.children.size,0);
  assert.deepEqual(host.listeners('resize'),[unrelated]);
 }finally{await env.cleanup();}
});

test('native browser shortcuts follow the current owned page host before and after return',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://shortcut-agent.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!,host=new FakeWindow();
  let prevented=0;const event={preventDefault:()=>{prevented++;}},input={key:'l',meta:true,control:false,alt:false,shift:false,type:'keyDown'};
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  view.webContents.emit('before-input-event',event,input);
  assert.equal(prevented,1);assert.equal(host.focuses,1);assert.equal(env.window.focuses,0);assert.equal(host.inputEvents.length,2);
  await env.controller.returnFromAgent(context);view.webContents.emit('before-input-event',event,input);
  assert.equal(env.window.focuses,1);assert.equal(host.focuses,1);
 }finally{await env.cleanup();}
});

test('ordinary close and profile activation never select or revise a retained agent page',async()=>{
 const env=await setup();try{
  const host=new FakeWindow();await env.controller.navigate('https://profile-agent.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!;
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  const revision=env.controller.getAgentState().tabs[0]!.revision;
  await env.controller.closeTab(env.controller.getContext().tabId);
  assert.notEqual(env.controller.getContext().tabId,context.tabId);assert.equal(env.controller.getAgentState().tabs[0]!.revision,revision);
  const profile=await env.controller.createProfile('Other');await env.controller.activateProfile(profile);
  assert.equal(view.visible,true);assert(host.children.has(view));
  await assert.rejects(env.controller.observe(context),/target|hidden/i);
  await assert.rejects(env.controller.returnFromAgent(context),/target|hidden/i);
  await env.controller.activateProfile(context.profileId);
  assert.notEqual(env.controller.getContext().tabId,context.tabId);assert.equal(env.controller.getAgentState().tabs[0]!.revision,revision);
  await env.controller.returnFromAgent(context);assert.equal(env.controller.getContext().tabId,context.tabId);
 }finally{await env.cleanup();}
});

test('hidden agent pages reject observation but explicit return can reclaim the exact live page',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://hidden-agent.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!,host=new FakeWindow();
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  env.controller.setAgentLayout({top:88,left:0,bottom:0,sidebarWidth:360,hideBrowser:true});
  await assert.rejects(env.controller.observe(context),/target|hidden/i);
  await assert.rejects(env.controller.returnFromAgent({...context,profileId:'foreign'}),/target|agent/i);
  await env.controller.returnFromAgent(context);assert(env.window.children.has(view));assert.equal(view.visible,true);
 }finally{await env.cleanup();}
});

test('agent host grids cover up to eight distinct areas and reject a ninth without moving its user page',async()=>{
 const env=await setup();try{
  const host=new FakeWindow(),areas=new Set<string>();
  for(let index=0;index<8;index++) {
   await env.controller.navigate(`https://capacity-agent.test/${index}`);const context=env.controller.getContext();
   areas.add((await env.controller.handoffToAgent(context,host as unknown as BrowserWindow)).areaId);
   const state=env.controller.getAgentState();assert.equal(state.splitCount,index<2?2:index<4?4:8);assert.equal(state.tabs.length,index+1);
  }
  assert.equal(areas.size,8);assert.equal(host.children.size,8);
  await env.controller.navigate('https://capacity-agent.test/ninth');const ninth=env.controller.getContext(),view=[...env.window.children].find(v=>v.webContents.url.endsWith('/ninth'))!;
  await assert.rejects(env.controller.handoffToAgent(ninth,host as unknown as BrowserWindow),/limit|capacity|eight|8/i);
  assert(env.window.children.has(view));assert(!host.children.has(view));assert.equal(env.controller.getContext().tabId,ninth.tabId);
 }finally{await env.cleanup();}
});

test('agent handoff and target validation reject blank hidden foreign duplicate and destroyed-host targets',async()=>{
 const env=await setup();try{
  const host=new FakeWindow(),context=env.controller.getContext();
  await assert.rejects(env.controller.handoffToAgent(context,host as unknown as BrowserWindow),/visible|HTTP/i);
  await env.controller.navigate('https://eligibility-agent.test/');
  await assert.rejects(env.controller.handoffToAgent({...context,profileId:'foreign'},host as unknown as BrowserWindow),/target/i);
  env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});
  await assert.rejects(env.controller.handoffToAgent(context,host as unknown as BrowserWindow),/visible/i);
  env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:false});
  await assert.rejects(env.controller.handoffToAgent(context,env.window as unknown as BrowserWindow),/host/i);
  host.destroyed=true;await assert.rejects(env.controller.handoffToAgent(context,host as unknown as BrowserWindow),/host/i);host.destroyed=false;
  await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  await assert.rejects(env.controller.handoffToAgent(context,host as unknown as BrowserWindow),/visible|HTTP/i);
  await env.controller.navigate('https://eligibility-agent.test/user');const user=env.controller.getContext();
  await assert.rejects(env.controller.handoffToAgent(user,new FakeWindow() as unknown as BrowserWindow),/host/i);
  const obs=await env.controller.observe(context);
  await assert.rejects(env.controller.execute({type:'open_tab',url:'https://escape-agent.test/'},{...context,jobId:'escape',expectedRevision:obs.revision}),/agent|retarget/i);
  host.destroyed=true;await assert.rejects(env.controller.observe(context),/target|hidden/i);
 }finally{await env.cleanup();}
});

test('a failed native host transfer leaves the page attached to its original user host',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://transfer-error.test/');const context=env.controller.getContext(),view=[...env.window.children][0]!,host=new FakeWindow();
  const add=host.contentView.addChildView;
  host.contentView.addChildView=()=>{throw new Error('native attach failed');};
  await assert.rejects(env.controller.handoffToAgent(context,host as unknown as BrowserWindow),/native attach failed/);
  assert(env.window.children.has(view));assert.equal(env.controller.getContext().tabId,context.tabId);assert.equal(view.webContents.backgroundThrottling,true);
  assert.deepEqual(env.controller.getAgentState().tabs,[]);assert.equal(host.listenerCount('resize'),0);
  host.contentView.addChildView=add;await env.controller.handoffToAgent(context,host as unknown as BrowserWindow);
  const userAdd=env.window.contentView.addChildView;env.window.contentView.addChildView=()=>{throw new Error('native return failed');};
  await assert.rejects(env.controller.returnFromAgent(context),/native return failed/);
  assert(host.children.has(view));assert.equal(view.webContents.backgroundThrottling,false);assert.equal(env.controller.getAgentState().tabs.length,1);
  env.window.contentView.addChildView=userAdd;
 }finally{await env.cleanup();}
});

test('quit veto retains the live agent page while already-closed native pages are detached without resurrecting an area',async()=>{
 const env=await setup(undefined,()=>false);try{
  const host=new FakeWindow();await env.controller.navigate('https://quit-clean.test/');const clean=env.controller.getContext(),cleanView=[...env.window.children][0]!;
  await env.controller.handoffToAgent(clean,host as unknown as BrowserWindow);
  await env.controller.navigate('https://quit-veto.test/');const veto=env.controller.getContext(),vetoView=[...env.window.children].find(v=>v.webContents.url==='https://quit-veto.test/')!;
  await env.controller.handoffToAgent(veto,host as unknown as BrowserWindow);vetoView.webContents.vetoClose=true;
  assert.equal(await env.controller.prepareToQuit(),false);
  assert.equal(cleanView.webContents.destroyed,true);assert(!host.children.has(cleanView));
  assert.deepEqual(env.controller.getAgentState().paneTabIds,['',veto.tabId]);assert.deepEqual(env.controller.getAgentState().agentPaneTabIds,[veto.tabId]);assert.equal(vetoView.webContents.destroyed,false);assert(host.children.has(vetoView));assert.equal(vetoView.visible,true);
  const closed=env.controller.getState().tabs.find(tab=>tab.id===clean.tabId)!;assert.equal(closed.agentAreaId,undefined);assert.equal(closed.lifecycle,'dormant');
  await assert.rejects(env.controller.observe(clean),/target|hidden/i);
  vetoView.webContents.vetoClose=false;assert.equal(await env.controller.prepareToQuit(),true);assert.equal(host.children.size,0);assert.deepEqual(env.controller.getAgentState().tabs,[]);
 }finally{await env.cleanup();}
});

test('a pending agent page read never queues a peer and cannot survive an explicit return',async()=>{
 const env=await setup();let release:(()=>void)|undefined;try{
  const host=new FakeWindow();await env.controller.navigate('https://pending-a.test/');const a=env.controller.getContext(),va=[...env.window.children][0]!;
  await env.controller.handoffToAgent(a,host as unknown as BrowserWindow);
  await env.controller.navigate('https://pending-b.test/');const b=env.controller.getContext();await env.controller.handoffToAgent(b,host as unknown as BrowserWindow);
  const original=va.webContents.executeJavaScriptInIsolatedWorld.bind(va.webContents);
  va.webContents.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.endsWith('.snapshot()')) await new Promise<void>(resolve=>{release=resolve;});return original(world,scripts);};
  const pending=env.controller.observe(a);const rejected=assert.rejects(pending,/revision|target|stale/i);
  await new Promise<void>(resolve=>setImmediate(resolve));assert(release);
  const peer=await env.controller.observe(b);assert.equal(peer.url,'https://pending-b.test/');
  await env.controller.returnFromAgent(a);release();await rejected;
  const current=await env.controller.observe(b);
  await env.controller.execute({type:'scroll',direction:'down'},{...b,jobId:'peer-unblocked',expectedRevision:current.revision});
 }finally{release?.();await env.cleanup();}
});

test('handoff of a nonactive user split pane replaces only that slot and preserves the selected ordinary peer',async()=>{
 const env=await setup();try{
  await env.controller.setSplitCount(2);const [a,b]=env.controller.getState().paneTabIds!;
  await env.controller.navigate('https://split-handoff-a.test/',a);await env.controller.navigate('https://split-handoff-b.test/',b);
  env.controller.activateTab(b!);const before=env.controller.getState(),host=new FakeWindow(),peerRevision=before.tabs.find(tab=>tab.id===b)!.revision;
  await env.controller.handoffToAgent({profileId:'default',tabId:a!},host as unknown as BrowserWindow);
  const state=env.controller.getState();assert.equal(state.activeTabId,b);assert.equal(state.splitCount,2);assert.equal(state.paneTabIds![1],b);
  const blank=state.tabs.find(tab=>tab.id===state.paneTabIds![0])!;assert.equal(blank.url,'about:blank');assert.equal(blank.ownership,'user');assert.notEqual(blank.id,a);
  assert.equal(state.tabs.find(tab=>tab.id===b)!.revision,peerRevision);
 }finally{await env.cleanup();}
});

test('the first slice does not mix different profile sessions in a retained agent host',async()=>{
 const env=await setup();try{
  const host=new FakeWindow();await env.controller.navigate('https://original-profile.test/');const original=env.controller.getContext();
  await env.controller.handoffToAgent(original,host as unknown as BrowserWindow);
  await env.controller.activateProfile(await env.controller.createProfile('Another profile'));await env.controller.navigate('https://other-profile.test/');
  const other=env.controller.getContext();await assert.rejects(env.controller.handoffToAgent(other,host as unknown as BrowserWindow),/profile/i);
  assert.equal(env.controller.getContext().tabId,other.tabId);assert.deepEqual(env.controller.getAgentState().paneTabIds,[original.tabId,'']);assert.deepEqual(env.controller.getAgentState().agentPaneTabIds,[original.tabId]);
 }finally{await env.cleanup();}
});

test('controller maps only verified bounded reading viewport metadata without capturing pixels',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://reading.test/');
  const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  let reading:unknown={documentId:'isolated-doc',scrollY:100,height:712,scrollHeight:2000,text:'Visible article'};
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
   const result=await original(world,scripts);
   return result && typeof result==='object'?Object.assign(result,{readingViewport:reading}):result;
  };
  const observed=await env.controller.observe(context);
  assert.deepEqual(observed.readingViewport,reading);
  assert.notEqual(observed.readingViewport,reading,'The controller must construct its own bounded DTO');
  assert.equal(wc.captureCount,0);
  const valid=reading as Record<string,unknown>;
  for(const invalid of [null,{},'untrusted',{...valid,documentId:''},{...valid,documentId:'x'.repeat(201)},{...valid,scrollY:NaN},{...valid,scrollY:-1},{...valid,scrollY:2000},{...valid,height:Infinity},{...valid,height:0},{...valid,height:30001},{...valid,scrollHeight:100000001},{...valid,scrollHeight:10},{...valid,text:42},{...valid,text:'x'.repeat(12001)}]) {
   reading=invalid;
   assert.equal((await env.controller.observe(context)).readingViewport,undefined,JSON.stringify(invalid));
  }
 }finally{await env.cleanup();}
});

test('local space preview captures only an existing visible page and returns a bounded thumbnail DTO',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://preview.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const resized:{width:number;height:number}[]=[];
  wc.capturePage=async()=>({isEmpty:()=>false,getSize:()=>({width:1200,height:712}),toPNG:()=>Buffer.from('full'),resize:(size:{width:number;height:number})=>{resized.push(size);return {toPNG:()=>Buffer.from('thumbnail')};}});
  const revision=env.controller.getState().tabs.find(tab=>tab.id===context.tabId)!.revision;
  assert.deepEqual(await env.controller.captureUserPreview(context),{...context,revision,imageDataUrl:'data:image/png;base64,'+Buffer.from('thumbnail').toString('base64')});
  assert.deepEqual(resized,[{width:400,height:237,quality:'good'}]);
  assert.equal(wc.debugger.commands.length,0);assert.equal(wc.insertedStyles.size,0);
  assert(!wc.calls.some(code=>code.includes('__sideworkVisuals.capture(')));
 }finally{await env.cleanup();}
});

test('local space preview discards document, revision, view visibility and profile races and sanitizes failures',async()=>{
 for(const race of ['document','revision','hidden','destroyed','profile','failure','oversized','sensitive'] as const){
  const env=await setup();try{
   await env.controller.navigate('https://preview.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
   const count=FakeView.all.length;
   wc.capturePage=async()=>{
    if(race==='document')wc.stamp='changed-document';
    if(race==='revision')env.controller.invalidatePageContext(context);
    if(race==='hidden')env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});
    if(race==='destroyed')wc.destroyed=true;
    if(race==='profile')await env.controller.activateProfile(await env.controller.createProfile('Other'));
    if(race==='failure')throw new Error('secret /private/token https://credentials.test');
    return {isEmpty:()=>false,getSize:()=>({width:300,height:200}),toPNG:()=>Buffer.alloc(race==='oversized'?800000:4)};
   };
   if(race==='sensitive')wc.computer.captureBlocked=true;
   const result=await env.controller.captureUserPreview(context);
   assert.equal(result.imageDataUrl,null,race);assert.equal(result.error,'미리보기를 사용할 수 없습니다.',race);
   assert.equal(JSON.stringify(result).includes('secret'),false);
   if(race!=='profile')assert.equal(FakeView.all.length,count);
  }finally{await env.cleanup();}
 }
});

test('local space preview never materializes blank, dormant, hidden or foreign targets',async()=>{
 const env=await setup();try{
  const context=env.controller.getContext(),count=FakeView.all.length;
  assert.equal((await env.controller.captureUserPreview(context)).imageDataUrl,null);
  assert.equal((await env.controller.captureUserPreview({...context,profileId:'foreign'})).imageDataUrl,null);
  assert.equal((await env.controller.captureUserPreview({...context,tabId:'absent'})).imageDataUrl,null);
  assert.equal(FakeView.all.length,count);
  await env.controller.navigate('https://preview.test/');const wc=FakeView.all.at(-1)!.webContents;
  env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});
  assert.equal((await env.controller.captureUserPreview(context)).imageDataUrl,null);assert.equal(wc.captureCount,0);
 }finally{await env.cleanup();}
});

test('control jobs expose only visible live panes and cancelled UUIDs cannot be resurrected',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://control.test/');
  const context=env.controller.getContext();
  const job={...context,id:'visual-job',status:'running'} as import('../src/contract.ts').Job;
  env.controller.updateControlJobs([job]);
  assert.deepEqual(env.controller.getControlVisuals(),[{...context,jobId:job.id,phase:'working'}]);
  env.controller.updateControlJobs([{...job,status:'awaiting_approval'}]);
  assert.equal(env.controller.getControlVisuals()[0]!.phase,'awaiting_approval');
  await env.controller.cancelControlVisuals(job.id);
  env.controller.updateControlJobs([job]);
  assert.deepEqual(env.controller.getControlVisuals(),[]);
  env.controller.updateControlJobs([{...job,id:'next-job'}]);
  env.controller.updateControlJobs([{...job,id:'next-job',status:'unknown'}]);
  assert.deepEqual(env.controller.getControlVisuals(),[]);
 }finally{await env.cleanup();}
});

test('control feedback installs in the private world and clears on hiding, navigation and disposal',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://visual-lifecycle.test/');
  const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const job={...context,id:'lifecycle-job',status:'running'} as import('../src/contract.ts').Job;
  env.controller.updateControlJobs([job]);await new Promise<void>(r=>setImmediate(r));
  assert(wc.calls.some(code=>code.includes('__sideworkVisuals.set(')));
  env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});
  assert.deepEqual(env.controller.getControlVisuals(),[]);
  assert(wc.calls.some(code=>code.includes('__sideworkVisuals?.clear()')));
  env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:false});
  env.controller.updateControlJobs([job]);assert.deepEqual(env.controller.getControlVisuals(),[]);
  env.controller.updateControlJobs([{...job,id:'navigation-job'}]);
  wc.emit('did-start-navigation',{isMainFrame:true});assert.deepEqual(env.controller.getControlVisuals(),[]);
  env.controller.updateControlJobs([{...job,id:'dispose-job'}]);
  await env.controller.dispose();assert.deepEqual(env.controller.getControlVisuals(),[]);
 }finally{await env.cleanup();}
});

test('native captures hide feedback before pixels and restore it plus caret even on capture failure',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://capture-feedback.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);let depth=0;
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{const code=scripts[0]!.code;if(code.includes('__sideworkVisuals.capture(true)')) depth++;if(code.endsWith('capture(false)')) depth--;return original(world,scripts);};
  const capture=wc.capturePage.bind(wc);
  wc.capturePage=async()=>{assert.equal(depth,1,'Feedback pixels must be absent');return capture();};
  await env.controller.observe(context,{computerUse:true,shareScreen:true});assert.equal(depth,0);
  wc.capturePage=async()=>{assert.equal(depth,1);throw new Error('native capture failed');};
  await assert.rejects(env.controller.observe(context,{computerUse:true,shareScreen:true}),/native capture failed/);
  assert.equal(depth,0);assert.equal(wc.insertedStyles.size,0);
 }finally{await env.cleanup();}
});

test('approved computer click glides through bounded real owned mouse moves and feedback follows the dispatched coordinates',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://glide.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  env.controller.updateControlJobs([{...context,id:'glide',status:'running'} as import('../src/contract.ts').Job]);
  const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  assert.equal(wc.debugger.commands.length,0,'Working/observation never moves the cursor');
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);const positions:{x:number;y:number}[]=[];
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
   const code=scripts[0]!.code;if(code.includes('__sideworkVisuals.set("moving"')) {
    const visual=env.controller.getControlVisuals()[0]!;const last=wc.debugger.commands.at(-1)!.params as {type:string;x:number;y:number};
    assert.equal(last.type,'mouseMoved');assert.equal(visual.x,last.x);assert.equal(visual.y,last.y);positions.push({x:last.x,y:last.y});
   }return original(world,scripts);
  };
  await env.controller.execute({type:'computer_click',x:100,y:120,frameId:obs.screen!.frameId},{...context,jobId:'glide',expectedRevision:obs.revision});
  const moves=wc.debugger.commands.filter(c=>(c.params as {type:string}).type==='mouseMoved');
  assert(moves.length>=2 && moves.length<=12);assert.equal(positions.length,moves.length);
  assert.deepEqual(positions.at(-1),{x:100,y:120});
  assert.deepEqual(wc.debugger.commands.slice(-2).map(c=>(c.params as {type:string}).type),['mousePressed','mouseReleased']);
  assert.equal(env.controller.getControlVisuals()[0]!.phase,'working');
 }finally{await env.cleanup();}
});

test('cancelling feedback during an actual glide prevents every later move and press even with a stale running lease',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://cancel-pointer.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const job={...context,id:'stop-pointer',status:'running'} as import('../src/contract.ts').Job;env.controller.updateControlJobs([job]);
  const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  const send=wc.debugger.sendCommand.bind(wc.debugger);let moves=0;
  wc.debugger.sendCommand=async(method,params)=>{await send(method,params);if((params as {type:string}).type==='mouseMoved' && ++moves===2) await env.controller.cancelControlVisuals(job.id);};
  await assert.rejects(env.controller.execute({type:'computer_click',x:10,y:20,frameId:obs.screen!.frameId},{...context,jobId:job.id,expectedRevision:obs.revision}),/cancel/i);
  assert.equal(wc.debugger.commands.length,2);env.controller.updateControlJobs([job]);assert.deepEqual(env.controller.getControlVisuals(),[]);
 }finally{await env.cleanup();}
});

test('a CSS-only hover hit-target change aborts the glide before mousePressed',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://hover-target.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});let moved=false;
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.includes('__sideworkVisuals.hit(')) return !moved;return original(world,scripts);};
  const send=wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand=async(method,params)=>{await send(method,params);if((params as {type:string}).type==='mouseMoved') moved=true;};
  await assert.rejects(env.controller.execute({type:'computer_click',x:20,y:30,frameId:obs.screen!.frameId},{...context,jobId:'hover',expectedRevision:obs.revision}),/hit|target/i);
  assert(!wc.debugger.commands.some(c=>(c.params as {type:string}).type==='mousePressed'));
 }finally{await env.cleanup();}
});

test('pointer motion policy uses a visible bounded glide or one direct real move for reduced motion',async()=>{
 for(const reduced of [false,true]) {
  const env=await setup();try{
   await env.controller.navigate('https://motion-policy.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
   const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
   wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>scripts[0]!.code.includes("matchMedia('(prefers-reduced-motion: reduce)').matches")?reduced:original(world,scripts);
   const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});const times:number[]=[];let press=0;
   const send=wc.debugger.sendCommand.bind(wc.debugger);
   wc.debugger.sendCommand=async(method,params)=>{await send(method,params);const type=(params as {type:string}).type;if(type==='mouseMoved') times.push(performance.now());if(type==='mousePressed') press=performance.now();};
   await env.controller.execute({type:'computer_click',x:30,y:50,frameId:obs.screen!.frameId},{...context,jobId:'motion-policy',expectedRevision:obs.revision});
   if(reduced) {assert.equal(times.length,1);assert(press-times[0]!<200);}
   else {assert(times.length>=2 && times.length<=12);assert(press-times[0]!>=340,'Visible real glide must span ~350–450ms');assert(press-times[0]!<1500);}
  }finally{await env.cleanup();}
 }
});

test('control status reports actual typing key and scrolling dispatch without fake pointer motion',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://execution-phases.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  env.controller.updateControlJobs([{...context,id:'phase-job',status:'running'} as import('../src/contract.ts').Job]);
  const phase=()=>env.controller.getControlVisuals()[0]!.phase;
  const send=wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand=async(method,params)=>{assert.equal(phase(),'typing');return send(method,params);};
  for(const action of [{type:'computer_type',value:'not-in-overlay'},{type:'computer_key',key:'Enter'}] as const) {
   const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
   await env.controller.execute({...action,frameId:obs.screen!.frameId},{...context,jobId:'phase-job',expectedRevision:obs.revision});assert.equal(phase(),'working');
  }
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{const code=scripts[0]!.code;if(code.includes('.act(')) assert.equal(phase(),'scrolling');if(code.includes('__sideworkVisuals.set(')) assert(!code.includes('not-in-overlay'));return original(world,scripts);};
  const obs=await env.controller.observe(context);
  await env.controller.execute({type:'scroll',direction:'down'},{...context,jobId:'phase-job',expectedRevision:obs.revision});assert.equal(phase(),'working');
  assert(!wc.debugger.commands.some(c=>(c.params as {type:string}).type==='mouseMoved'));
 }finally{await env.cleanup();}
});

test('global visual cancellation also tombstones queued jobs and stops a glide before its first running snapshot',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://global-stop.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const job={...context,id:'queued-stop',status:'queued'} as import('../src/contract.ts').Job;env.controller.updateControlJobs([job]);
  const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  const send=wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand=async(method,params)=>{await send(method,params);if((params as {type:string}).type==='mouseMoved') await env.controller.cancelControlVisuals();};
  await assert.rejects(env.controller.execute({type:'computer_click',x:11,y:22,frameId:obs.screen!.frameId},{...context,jobId:'unpublished-input',expectedRevision:obs.revision}),/cancel/i);
  assert.equal(wc.debugger.commands.length,1);
  env.controller.updateControlJobs([{...job,status:'running'}]);assert.deepEqual(env.controller.getControlVisuals(),[]);
 }finally{await env.cleanup();}
});

test('every real pointer step remains within its pane after viewport shrink',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://bounded-pointer.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  env.controller.updateControlJobs([{...context,id:'resize-pointer',status:'running'} as import('../src/contract.ts').Job]);
  let obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  await env.controller.execute({type:'computer_click',x:1100,y:600,frameId:obs.screen!.frameId},{...context,jobId:'resize-pointer',expectedRevision:obs.revision});
  env.window.getContentBounds=()=>({x:0,y:0,width:600,height:500});env.window.emit('resize');
  obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  const send=wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand=async(method,params)=>{const point=params as {x:number;y:number};assert(point.x>=0 && point.x<wc.computer.viewportWidth);assert(point.y>=0 && point.y<wc.computer.viewportHeight);return send(method,params);};
  await env.controller.execute({type:'computer_click',x:10,y:20,frameId:obs.screen!.frameId},{...context,jobId:'resize-pointer',expectedRevision:obs.revision});
 }finally{await env.cleanup();}
});

test('glide validity is rechecked during movement and again after clicking feedback before press',async()=>{
 for(const reason of ['lease','document','viewport','navigation','hidden','before-press']) {
  let allowed=true;const env=await setup(()=>{},undefined,()=>allowed);try{
   await env.controller.navigate('https://glide-validation.test/');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
   const jobId=`validity-${reason}`;env.controller.updateControlJobs([{...context,id:jobId,status:'running'} as import('../src/contract.ts').Job]);
   const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});let invalidated=false;
   const invalidate=()=>{if(invalidated)return;invalidated=true;if(reason==='lease')allowed=false;if(reason==='document'||reason==='before-press')wc.stamp='changed';if(reason==='viewport')wc.computer.viewportWidth--;if(reason==='navigation')wc.emit('did-start-navigation',{isMainFrame:true});if(reason==='hidden')env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});};
   const send=wc.debugger.sendCommand.bind(wc.debugger);
   wc.debugger.sendCommand=async(method,params)=>{await send(method,params);if(reason!=='before-press'&&(params as {type:string}).type==='mouseMoved')invalidate();};
   const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
   wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{const value=await original(world,scripts);if(reason==='before-press'&&scripts[0]!.code.includes('__sideworkVisuals.set("clicking"'))invalidate();return value;};
   await assert.rejects(env.controller.execute({type:'computer_click',x:10,y:20,frameId:obs.screen!.frameId},{...context,jobId,expectedRevision:obs.revision}),/lease|cancel|document|viewport|target|hidden|revision/i);
   assert(invalidated,reason);assert(!wc.debugger.commands.some(c=>(c.params as {type:string}).type==='mousePressed'),reason);assert.deepEqual(env.controller.getControlVisuals(),[]);
  }finally{await env.cleanup();}
 }
});

async function setup(onChange: () => void = () => {}, confirmClose?: (tab: import('../src/contract.ts').BrowserTab, reason: 'tab' | 'quit') => boolean, allowExecution?:(context:import('../src/contract.ts').ExecutionContext)=>boolean,handleDownload?:(event:Electron.Event,item:Electron.DownloadItem,tab:import('../src/contract.ts').BrowserTab)=>void) {
  ({ BrowserController } = await import('../src/desktop/browser.ts'));
  const dataRoot = await mkdtemp(join(homedir(), '.hermes/cache/scratch/sidework-browser-test-'));
  const window = new FakeWindow();
  const controller = new BrowserController({ window: window as unknown as BrowserWindow, dataRoot, onChange, confirmClose, allowExecution,handleDownload });
  await controller.initialize();
  return { dataRoot, window, controller, cleanup: async () => { await controller.dispose(); await rm(dataRoot, { recursive: true, force: true }); } };
}

test('explicit page invalidation expires its approval without changing a peer page',async()=>{
 const env=await setup();try{
  await env.controller.setSplitCount(2);const [a,b]=env.controller.getState().paneTabIds!;
  await env.controller.navigate('https://takeover-a.test/',a);await env.controller.navigate('https://takeover-b.test/',b);
  const ca={profileId:'default',tabId:a!},cb={profileId:'default',tabId:b!};const oa=await env.controller.observe(ca),ob=await env.controller.observe(cb);
  env.controller.invalidatePageContext(ca);const state=env.controller.getState();assert(state.tabs.find(tab=>tab.id===a)!.revision>oa.revision);assert.equal(state.tabs.find(tab=>tab.id===b)!.revision,ob.revision);
  await assert.rejects(env.controller.execute({type:'scroll',direction:'down'},{...ca,expectedRevision:oa.revision,jobId:'old-a'}),/revision|stale/i);
  await assert.doesNotReject(env.controller.execute({type:'scroll',direction:'down'},{...cb,expectedRevision:ob.revision,jobId:'peer-b'}));
  assert.throws(()=>env.controller.invalidatePageContext({...ca,profileId:'other'}));assert.throws(()=>env.controller.invalidatePageContext({...ca,tabId:'missing'}));
 }finally{await env.cleanup();}
});

test('downloads delegate only an exact live owned source and do not expose mutable tab state',async()=>{
 const seen:import('../src/contract.ts').BrowserTab[]=[];
 const env=await setup(undefined,undefined,undefined,(_event,_item,tab)=>{seen.push({...tab});tab.url='https://impostor.test/';});
 try{
  await env.controller.navigate('https://download.test/');const wc=FakeView.all.at(-1)!.webContents,session=sessions.get('persist:sidework-default')!;
  let prevented=0,cancelled=0;const event={preventDefault:()=>{prevented++;}},item={cancel:()=>{cancelled++;}};
  session.emit('will-download',event,item,wc);assert.equal(seen.length,1);assert.equal(seen[0]!.url,'https://download.test/');assert.equal(env.controller.getState().tabs[0]!.url,'https://download.test/');assert.equal(prevented,0);
  session.emit('will-download',event,item,new FakeContents());assert.equal(seen.length,1);assert.equal(prevented,1);assert.equal(cancelled,1);
  await env.controller.setSplitCount(2);assert.doesNotThrow(()=>session.emit('will-download',event,item));assert.equal(seen.length,1);assert.equal(prevented,2);assert.equal(cancelled,2);
 }finally{await env.cleanup();}
});

test('a committed navigation already advances the revision and its first observation does not double-count the old document stamp',async()=>{
 const env=await setup();
 try{
  await env.controller.navigate('https://navigation.example/first');
  const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  await env.controller.observe(context);
  wc.stamp='new-document:0';await env.controller.navigate('https://navigation.example/second');
  const revision=env.controller.getState().tabs.find(t=>t.id===context.tabId)!.revision;
  const observed=await env.controller.observe(context);
  assert.equal(observed.revision,revision,'The previous document stamp must not invalidate fresh navigation consent');
  wc.stamp='new-document:mutation';const changed=await env.controller.observe(context);
  assert(changed.revision>revision,'Actual mutations within the new document still invalidate old plans');
 }finally{await env.cleanup();}
});

test('input caret blinking does not invalidate an unchanged frame, but actual pixel changes still do',async()=>{
 const env=await setup();
 try{
  await env.controller.navigate('https://caret.example/');
  const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  wc.caretVisible=true;const first=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  wc.caretVisible=false;const second=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  assert.equal(first.screen!.frameId,second.screen!.frameId);
  assert.equal(wc.insertedStyles.size,0,'Capture must restore the normal visible caret');
  wc.pixels='actual-content-changed';const third=await env.controller.observe(context,{computerUse:true,shareScreen:true});
  assert.notEqual(second.screen!.frameId,third.screen!.frameId);
 }finally{await env.cleanup();}
});

test('smooth controller never dispatches motion if cancellation wins before the deferred renderer call',async()=>{
  let checks=0;let cancel:(()=>void)|undefined;
  const env=await setup(()=>{},undefined,()=>{if(++checks===3) queueMicrotask(()=>cancel?.());return true;});
  try {
    await env.controller.navigate('https://early-cancel.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context);
    cancel=()=>{void env.controller.cancelScroll('early-owned');};
    await assert.rejects(env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'early-owned',smoothScroll:true}),/cancel/i);
    assert.equal(wc.calls.filter(code=>code.includes('.act(')).length,0);
  } finally {await env.cleanup();}
});

test('smooth controller handles synchronous renderer dispatch failure without leaking rejection or motion ownership',async()=>{
  const env=await setup();
  try {
    await env.controller.navigate('https://dispatch-failure.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
    let cancellations=0;
    wc.executeJavaScriptInIsolatedWorld=(world,scripts)=>{
      if(scripts[0]!.code.includes('.act(')) throw new Error('renderer dispatch failed synchronously');
      if(scripts[0]!.code.includes('?.cancelScroll(')) {cancellations++;return Promise.resolve(undefined);}
      return original(world,scripts);
    };
    await assert.rejects(env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'dispatch-owned',smoothScroll:true}),/renderer dispatch/i);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(cancellations,1);await env.controller.cancelScroll();assert.equal(cancellations,1);
  } finally {await env.cleanup();}
});

test('smooth controller disposal drains every owned cancellation even when one renderer rejects',async()=>{
  const env=await setup();let finishSecond:(()=>void)|undefined;
  try {
    await env.controller.setSplitCount(2);
    const ids=env.controller.getState().paneTabIds!;
    for(const id of ids) await env.controller.navigate('https://dispose-cohort.test/',id);
    const views=[...env.window.children];const executions:Promise<unknown>[]=[];
    let secondStopped=false, prematureDestroy=false;
    for(const [index,view] of views.entries()) {
      const context={profileId:'default',tabId:ids[index]!},wc=view.webContents;
      const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
      const close=wc.close.bind(wc);wc.close=()=>{if(!secondStopped) prematureDestroy=true;close();};
      wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
        const code=scripts[0]!.code;
        if(code.includes('.act(')) {await new Promise<void>(()=>{});return undefined;}
        if(code.includes('?.cancelScroll(')) {
          if(index===0) throw new Error('renderer cancellation unknown');
          await new Promise<void>(resolve=>{finishSecond=resolve;});secondStopped=true;return undefined;
        }
        return original(world,scripts);
      };
      executions.push(env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:`cohort-${index}`,smoothScroll:true}).catch(error=>error));
    }
    await new Promise<void>(resolve=>setImmediate(resolve));
    const disposed=env.controller.dispose().then(()=> 'success',error=>String(error));
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(finishSecond);finishSecond();
    assert.match(await disposed,/unknown/i);await Promise.all(executions);
    assert.equal(prematureDestroy,false);
  } finally {finishSecond?.();await env.cleanup();}
});

test('smooth controller bounds a renderer action that never completes even while its lease remains valid',async()=>{
  const env=await setup();const release:(()=>void)[]=[];
  try {
    await env.controller.navigate('https://timeout-scroll.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
    let stopped=false;
    wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
      const code=scripts[0]!.code;
      if(code.includes('.act(')) {await new Promise<void>(resolve=>release.push(resolve));return undefined;}
      if(code.includes('?.cancelScroll(')) {stopped=true;for(const finish of release) finish();return undefined;}
      return original(world,scripts);
    };
    const execution=env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'timeout-owned',smoothScroll:true});
    const outcome=execution.then(()=> 'unexpected success',error=>String(error));
    await new Promise(resolve=>setTimeout(resolve,2100));
    assert.equal(stopped,true);assert.match(await outcome,/timeout/i);
  } finally {for(const finish of release) finish();await new Promise<void>(resolve=>setImmediate(resolve));await env.cleanup();}
});

test('smooth controller bounds cancellation when isolated renderer stops answering and reports unknown instead of success',async()=>{
  const env=await setup();const release:(()=>void)[]=[];
  try {
    await env.controller.navigate('https://hung-scroll.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
    wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.endsWith('.snapshot()')) return original(world,scripts);await new Promise<void>(resolve=>release.push(resolve));return undefined;};
    const execution=env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'hung-owned',smoothScroll:true});
    const rejected=assert.rejects(execution,/cancel|timeout|unknown/i);
    await new Promise<void>(resolve=>setImmediate(resolve));
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([env.controller.cancelScroll('hung-owned').then(()=> 'success',()=> 'failed-closed'),new Promise<string>(resolve=>{deadline=setTimeout(()=>resolve('hung'),700);})]);
      assert.equal(result,'failed-closed');await rejected;
    } finally {clearTimeout(deadline);}
  } finally {for(const finish of release) finish();await new Promise<void>(resolve=>setImmediate(resolve));await env.cleanup();}
});

test('smooth controller disposal cancels its owned motion before destroying native contents',async()=>{
  const env=await setup();
  try {
    await env.controller.navigate('https://dispose-scroll.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
    let finish:(()=>void)|undefined;let stopped=false;
    wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
      const code=scripts[0]!.code;
      if(code.includes('.act(')) {await new Promise<void>(resolve=>{finish=resolve;});return undefined;}
      if(code.includes('?.cancelScroll(')) {assert.equal(wc.destroyed,false);stopped=true;finish?.();return undefined;}
      return original(world,scripts);
    };
    const execution=env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'dispose-owned',smoothScroll:true});
    const rejected=assert.rejects(execution,/cancel|disposed/i);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const close=wc.close.bind(wc);wc.close=()=>{assert.equal(stopped,true);close();};
    await env.controller.dispose();await rejected;assert.equal(wc.destroyed,true);
  } finally {await env.cleanup();}
});

test('smooth controller leases stop owned page motion on cancellation, hidden target or stale revision during and after await',async()=>{
  for(const reason of ['lease','revision','hidden','after']) {
    let allowed=true;
    const env=await setup(()=>{},undefined,()=>allowed);
    try {
      await env.controller.navigate('https://lease-scroll.test/');
      const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
      const obs=await env.controller.observe(context),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
      let finish:(()=>void)|undefined;let cancelled=false;
      wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
        const code=scripts[0]!.code;
        if(code.includes('.act(')) {
          if(reason==='after') {allowed=false;return undefined;}
          await new Promise<void>(resolve=>{finish=resolve;});return undefined;
        }
        if(code.includes('?.cancelScroll(')) {cancelled=true;finish?.();return undefined;}
        return original(world,scripts);
      };
      const execution=env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'leased',smoothScroll:true});
      const rejected=assert.rejects(execution,/lease|cancel|revision|target|hidden/i);
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(reason==='lease') allowed=false;
      if(reason==='revision') wc.emit('did-start-navigation',{isMainFrame:true});
      if(reason==='hidden') env.controller.setLayout({top:88,left:0,bottom:0,sidebarWidth:0,hideBrowser:true});
      if(reason!=='after') {
        await new Promise(resolve=>setTimeout(resolve,120));
        assert.equal(cancelled,true,reason);
      }
      await rejected;
    } finally {await env.cleanup();}
  }
});

test('smooth controller execution forwards owned job options and cancellation bypasses its pending action',async()=>{
  const env=await setup();
  try {
    await env.controller.navigate('https://smooth.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context);
    const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
    let stop:(()=>void)|undefined;
    wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
      const code=scripts[0]!.code;
      if(code.includes('.act(')) {wc.calls.push(code);await new Promise<void>(resolve=>{stop=resolve;});return undefined;}
      if(code.includes('?.cancelScroll(')) {wc.calls.push(code);stop?.();return undefined;}
      return original(world,scripts);
    };
    const execution=env.controller.execute({type:'scroll',direction:'down'},{...context,expectedRevision:obs.revision,jobId:'smooth-owned',smoothScroll:true});
    const rejected=assert.rejects(execution,/cancel/i);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.match(wc.calls.at(-1)!,/"smoothScroll":true/);
    await env.controller.cancelScroll('unrelated');
    assert(!wc.calls.at(-1)!.includes('?.cancelScroll('));
    await env.controller.cancelScroll('smooth-owned');
    await rejected;
    assert(wc.calls.at(-1)!.includes('?.cancelScroll("smooth-owned")'));
  } finally {await env.cleanup();}
});

test('embedded-frame navigation does not invalidate an unchanged top-level research document',async()=>{
 const env=await setup();try{
  await env.controller.navigate('https://research.test/article');const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
  const before=await env.controller.observe(context);
  wc.emit('did-start-navigation',{isMainFrame:false},'https://embedded.test/refresh',false,false);
  const after=await env.controller.observe(context);
  assert.equal(after.revision,before.revision);
  wc.emit('did-start-navigation',{isMainFrame:true},'https://research.test/next',false,true);
  assert((await env.controller.observe(context)).revision>after.revision);
 }finally{await env.cleanup();}
});

test('manual navigation invalidates computer frame before any asynchronous navigation event',async()=>{const env=await setup();try{await env.controller.navigate('https://old-frame.test/');const context=env.controller.getContext();const before=await env.controller.observe(context,{computerUse:true,shareScreen:true});const wc=FakeView.all.at(-1)!.webContents;wc.loadURL=async()=>await new Promise<void>(()=>{});await env.controller.navigate('https://pending-frame.test/');assert(env.controller.getState().tabs[0]!.revision>before.revision);await assert.rejects(env.controller.execute({type:'computer_click',x:20,y:20,frameId:before.screen!.frameId},{...context,expectedRevision:before.revision,jobId:'pending-frame-job'}),/frame|revision/i);}finally{await env.cleanup();}});

test('shrinking and expanding panes reuses existing normal web tabs instead of adding blank duplicates',async()=>{const env=await setup();try{await env.controller.setSplitCount(2);const before=env.controller.getState().paneTabIds!;await env.controller.navigate('https://reuse-one.test/',before[0]);await env.controller.navigate('https://reuse-two.test/',before[1]);await env.controller.setSplitCount(1);await env.controller.setSplitCount(2);assert.deepEqual(env.controller.getState().paneTabIds,before);assert.equal(env.controller.getState().tabs.length,2);}finally{await env.cleanup();}});

test('manual navigation of a dormant split pane starts its destination once without blank-load race', async()=>{
 const env=await setup();const original=FakeContents.prototype.loadURL;const loads:string[]=[];
 try{await env.controller.setSplitCount(2);FakeContents.prototype.loadURL=async function(url:string){loads.push(url);await original.call(this,url);};const id=env.controller.getState().paneTabIds![1]!;await env.controller.navigate('https://pane-start.test/',id);assert.deepEqual(loads,['https://pane-start.test/']);}
 finally{FakeContents.prototype.loadURL=original;await env.cleanup();}
});

test('legacy screenshot artifacts do not silently enable computer mode or block later DOM-only open_tab', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext();
    let obs=await env.controller.observe(context);
    await env.controller.execute({type:'screenshot'},{...context,expectedRevision:obs.revision,jobId:'test'});
    obs=await env.controller.observe(context);
    const result=await env.controller.execute({type:'open_tab',url:'https://fixture.test/next'},{...context,expectedRevision:obs.revision,jobId:'test'});
    assert.notEqual(result.context.tabId,context.tabId);
  } finally {await env.cleanup();}
});

test('live execution lease is rechecked after awaited recapture so cancellation dispatches no input', async () => {
  let allowed=true;
  const env=await setup(()=>{},undefined,()=>allowed);
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
    const capture=wc.capturePage.bind(wc);
    wc.capturePage=async()=>{const image=await capture();allowed=false;return image;};
    await assert.rejects(env.controller.execute({type:'computer_click',x:10,y:10,frameId:obs.screen!.frameId},{...context,expectedRevision:obs.revision,jobId:'test'}),/cancel|execution|lease/i);
    assert.equal(wc.debugger.commands.length,0);assert.equal(wc.debugger.attaches,0);assert.deepEqual(wc.inputEvents,[]);
  } finally {await env.cleanup();}
});

test('closing a native-destroyed owned-debugger page never queries its dead debugger', async () => {
  const env=await setup(()=>{},()=>true);
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const obs=await env.controller.observe(context,{computerUse:true,shareScreen:true});
    await env.controller.execute({type:'computer_key',key:'Escape',frameId:obs.screen!.frameId},{...context,expectedRevision:obs.revision,jobId:'test'});
    wc.debugger.isAttached=()=>{if(wc.destroyed) throw new Error('dead debugger');return wc.debugger.attached;};
    await env.controller.closeTab(context.tabId);
    assert.equal(env.controller.getState().tabs.some(tab=>tab.id===context.tabId),false);
  } finally {await env.cleanup();}
});

test('repeated split expansion reuses dormant blank slots instead of accumulating tabs', async () => {
  const env=await setup();
  try {
    await env.controller.setSplitCount(8);
    const ids=env.controller.getState().tabs.map(tab=>tab.id).sort();
    for(const count of [1,4,2,8,1,8] as const) await env.controller.setSplitCount(count);
    assert.deepEqual(env.controller.getState().tabs.map(tab=>tab.id).sort(),ids);
    assert.equal(env.window.children.size,1);
  } finally {await env.cleanup();}
});

test('eight native owned views keep distinct bounds and stale frames reject canvas, viewport and document changes', async () => {
  const env=await setup();
  try {
    await env.controller.setSplitCount(8);
    const ids=env.controller.getState().paneTabIds!;
    for(const [i,id] of ids.entries()) await env.controller.navigate(`https://fixture.test/pane-${i}`,id);
    assert.equal(env.window.children.size,8);
    const views=[...env.window.children];
    assert.equal(views.filter(view=>view.visible).length,8);
    assert.equal(new Set(views.map(view=>JSON.stringify(view.bounds))).size,8);
    const target={profileId:'default',tabId:ids[0]!},wc=views[0]!.webContents;
    const observe=()=>env.controller.observe(target,{computerUse:true,shareScreen:true});
    let obs=await observe();
    const execute=()=>env.controller.execute({type:'computer_click',x:10,y:10,frameId:obs.screen!.frameId},{...target,expectedRevision:obs.revision,jobId:'test'});
    wc.pixels='canvas animation';await assert.rejects(execute(),/frame/i);
    obs=await observe();wc.computer.viewportWidth--;
    await assert.rejects(execute(),/frame|viewport/i);
    obs=await observe();wc.stamp='new-document';
    await assert.rejects(execute(),/revision|frame/i);
    obs=await observe();
    env.controller.setLayout({left:0,top:88,sidebarWidth:300,bottom:0,hideBrowser:false});
    await assert.rejects(execute(),/revision|frame/i);
    assert.deepEqual(wc.debugger.commands,[]);
    assert.equal(wc.debugger.attaches,0);
  } finally {await env.cleanup();}
});

test('sensitive page URLs block image capture before pixels are read', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/login?code=private');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    await assert.rejects(env.controller.observe(context,{computerUse:true,shareScreen:true}),/sensitive/i);
    assert.equal(wc.captureCount,0);
  } finally {await env.cleanup();}
});

test('unknown debugger ownership fails closed without detach; owned attachments are reused then released', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const observe=()=>env.controller.observe(context,{computerUse:true,shareScreen:true});
    let obs=await observe();
    wc.debugger.attached=true;
    await assert.rejects(env.controller.execute({type:'computer_type',value:'blocked',frameId:obs.screen!.frameId},{...context,expectedRevision:obs.revision,jobId:'test'}),/debugger|devtools/i);
    assert.equal(wc.debugger.detaches,0);assert.deepEqual(wc.debugger.commands,[]);assert.deepEqual(wc.typed,[]);
    wc.debugger.attached=false;
    obs=await observe();
    await env.controller.execute({type:'computer_type',value:'owned',frameId:obs.screen!.frameId},{...context,expectedRevision:obs.revision,jobId:'test'});
    obs=await observe();
    await env.controller.execute({type:'computer_key',key:'Escape',frameId:obs.screen!.frameId},{...context,expectedRevision:obs.revision,jobId:'test'});
    assert.equal(wc.debugger.attaches,1);
    await env.controller.dispose();assert.equal(wc.debugger.detaches,1);
  } finally {await env.cleanup();}
});

test('DPR-sized captures resize within image limits and map image pixels into local native bounds', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    const resized:{width:number;height:number}[]=[];
    wc.capturePage=async()=>({isEmpty:()=>false,getSize:()=>({width:2400,height:1424}),toPNG:()=>Buffer.from('DPR owned capture'),resize:(size:{width:number;height:number})=>{resized.push(size);return {toPNG:()=>Buffer.from('resized owned capture')};}});
    const observation=await env.controller.observe(context,{computerUse:true,shareScreen:true});
    const frame=observation.screen!;
    assert.equal(frame.width,1280);assert.equal(frame.height,759);
    assert.equal(frame.viewportWidth,1200);assert.equal(frame.viewportHeight,712);
    await env.controller.execute({type:'computer_click',x:640,y:379,frameId:frame.frameId},{...context,expectedRevision:observation.revision,jobId:'test'});
    assert.deepEqual(wc.debugger.commands.at(-2),{method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:600,y:355,button:'left',clickCount:1}});
    assert.equal(resized.length,2);
  } finally {await env.cleanup();}
});

test('computer frames cannot open tabs and screenshots recheck sensitivity after native capture', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    let observation=await env.controller.observe(context,{computerUse:true,shareScreen:true});
    const before=env.controller.getState().tabs.length;
    await assert.rejects(env.controller.execute({type:'open_tab',url:'https://fixture.test/new'},{...context,expectedRevision:observation.revision,jobId:'test'}),/computer|pane/i);
    assert.equal(env.controller.getState().tabs.length,before);
    observation=await env.controller.observe(context);
    const capture=wc.capturePage.bind(wc);
    wc.capturePage=async()=>{const image=await capture();wc.computer.captureBlocked=true;return image;};
    await assert.rejects(env.controller.execute({type:'screenshot'},{...context,expectedRevision:observation.revision,jobId:'test'}),/stale|sensitive/i);
  } finally {await env.cleanup();}
});

test('hidden native bodies cannot be captured and closing a split pane replaces only its slot lazily', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext();
    env.controller.setLayout({left:0,top:88,bottom:0,sidebarWidth:0,hideBrowser:true});
    await assert.rejects(env.controller.observe(context,{computerUse:true,shareScreen:true}),/hidden|visible|target/i);
    env.controller.setLayout({left:0,top:88,bottom:0,sidebarWidth:0,hideBrowser:false});
    await env.controller.setSplitCount(8);
    const before=env.controller.getState().paneTabIds!;
    const count=env.window.children.size;
    await env.controller.closeTab(before[3]!);
    const after=env.controller.getState().paneTabIds!;
    assert.equal(after.length,8);
    assert.equal(new Set(after).size,8);
    assert.equal(after[0],before[0]);
    assert.equal(after[2],before[2]);
    assert.equal(after[4],before[4]);
    assert.notEqual(after[3],before[3]);
    assert.equal(env.window.children.size,count);
  } finally {await env.cleanup();}
});

test('native computer input stays pinned, consumes frames, follows safe links by GET not handlers', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const target=env.controller.getContext(),view=FakeView.all.at(-1)!,wc=view.webContents;
    await env.controller.setSplitCount(2);
    const other=env.controller.getState().paneTabIds![1]!;
    env.controller.activateTab(other);
    const observe=()=>env.controller.observe(target,{computerUse:true,shareScreen:true});
    let obs=await observe();
    const ctx=()=>({...target,expectedRevision:obs.revision,jobId:'job-test'});
    await env.controller.execute({type:'computer_click',x:600,y:356,frameId:obs.screen!.frameId},ctx());
    assert.deepEqual(wc.debugger.commands.filter(c=>(c.params as {type:string}).type!=='mouseMoved'),[{method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:300,y:340,button:'left',clickCount:1}},{method:'Input.dispatchMouseEvent',params:{type:'mouseReleased',x:300,y:340,button:'left',clickCount:1}}]);
    assert.deepEqual(wc.inputEvents,[]);
    assert.equal(env.controller.getState().activeTabId,other);
    await assert.rejects(env.controller.execute({type:'computer_click',x:600,y:356,frameId:obs.screen!.frameId},ctx()),/stale|revision|frame/i);
    obs=await observe();
    await env.controller.execute({type:'computer_type',value:'local only',frameId:obs.screen!.frameId},ctx());
    assert.deepEqual(wc.debugger.commands.at(-1),{method:'Input.insertText',params:{text:'local only'}});
    assert.deepEqual(wc.typed,[]);
    obs=await observe();
    await env.controller.execute({type:'computer_key',key:'Tab',frameId:obs.screen!.frameId},ctx());
    assert.deepEqual(wc.debugger.commands.slice(-2),[{method:'Input.dispatchKeyEvent',params:{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9}},{method:'Input.dispatchKeyEvent',params:{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9}}]);
    wc.computer.links=[{x:10,y:10,width:50,height:50,url:'https://fixture.test/read'}];
    obs=await observe();
    const events=wc.debugger.commands.length;
    await env.controller.execute({type:'computer_click',x:20,y:20,frameId:obs.screen!.frameId},ctx());
    assert.equal(wc.url,'https://fixture.test/read');
    assert.equal(wc.debugger.commands.length,events);
  } finally {await env.cleanup();}
});

test('computer capture is opt-in, owned, stable for identical pixels and blocked before sensitive capture', async () => {
  const env=await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context=env.controller.getContext(),wc=FakeView.all.at(-1)!.webContents;
    assert.equal((await env.controller.observe(context)).screen,undefined);
    assert.equal(wc.captureCount,0);
    await assert.rejects(env.controller.observe(context,{computerUse:true}),/consent|share/i);
    wc.computer.links=[{x:10,y:20,width:50,height:30,url:'https://fixture.test/read'},{x:70,y:20,width:50,height:30,url:'https://evil.test/'}];
    const first=await env.controller.observe(context,{computerUse:true,shareScreen:true});
    assert.equal(Buffer.from(first.screen!.pngBase64,'base64').toString(),'test-only-image');
    assert.equal(first.screen!.safeLinks.length,1);
    assert.equal((await env.controller.observe(context,{computerUse:true,shareScreen:true})).screen!.frameId,first.screen!.frameId);
    wc.pixels='canvas changed';
    assert.notEqual((await env.controller.observe(context,{computerUse:true,shareScreen:true})).screen!.frameId,first.screen!.frameId);
    const captures=wc.captureCount;
    wc.computer.captureBlocked=true;
    await assert.rejects(env.controller.observe(context,{computerUse:true,shareScreen:true}),/sensitive/i);
    assert.equal(wc.captureCount,captures);
    const fresh=await env.controller.observe(context);
    await assert.rejects(env.controller.execute({type:'screenshot'},{...context,expectedRevision:fresh.revision,jobId:'test'}),/sensitive/i);
    assert.equal(wc.captureCount,captures);
  } finally {await env.cleanup();}
});

test('split slots are lazy, pinned visible targets ignore focus and blank focus hides no siblings', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const first = env.controller.getContext();
    const view = FakeView.all.at(-1)!;
    const count = env.window.children.size;
    await env.controller.setSplitCount(8);
    const state = env.controller.getState();
    assert.equal(state.splitCount, 8);
    assert.equal(new Set(state.paneTabIds).size, 8);
    assert.equal(env.window.children.size, count);
    assert.equal(state.activeTabId, first.tabId);
    const observed = await env.controller.observe(first);
    env.controller.activateTab(state.paneTabIds![1]!);
    env.controller.setLayout({ left:0, top:88, sidebarWidth:0, bottom:0, hideBrowser:true });
    assert.equal(view.visible, true);
    await env.controller.execute({type:'observe'}, {...first,expectedRevision:observed.revision,jobId:'job-test'});
    await env.controller.navigate('https://fixture.test/second', first.tabId);
    assert.equal(env.controller.getState().activeTabId, state.paneTabIds![1]);
    await env.controller.setSplitCount(1);
    await assert.rejects(env.controller.observe(first), /target/i);
    await assert.rejects(env.controller.setSplitCount(3 as never), /split/i);
  } finally { await env.cleanup(); }
});

test('navigation results never silently retarget a job if the user changes tabs while loading', async () => {
  const env = await setup();
  try {
    const original = env.controller.getContext();
    const observed = await env.controller.observe(original);
    const wc = FakeView.all.at(-1)!.webContents;
    let finish: (() => void) | undefined;
    wc.loadURL = async (url: string) => { wc.url = url; await new Promise<void>(resolve => { finish = resolve; }); };
    const execution = env.controller.execute({ type: 'navigate', url: 'https://fixture.test/' }, { ...original, expectedRevision: observed.revision, jobId: 'job-test' });
    await new Promise<void>(resolve => setImmediate(resolve));
    await env.controller.newTab();
    assert.ok(finish); finish();
    const result = await execution;
    assert.deepEqual(result.context, original);
    await assert.rejects(env.controller.observe(result.context), /target/i);
  } finally { await env.cleanup(); }
});

test('a reentrant state callback cannot redirect an approved action to a newly active tab', async () => {
  let switchTab: (() => void) | undefined;
  const env = await setup(() => { const run = switchTab; switchTab = undefined; run?.(); });
  try {
    const original = env.controller.getContext();
    const other = await env.controller.newTab();
    env.controller.activateTab(original.tabId);
    const observed = await env.controller.observe(original);
    switchTab = () => env.controller.activateTab(other);
    await assert.rejects(env.controller.execute({ type: 'navigate', url: 'https://wrong-target.test/' }, { ...original, expectedRevision: observed.revision, jobId: 'job-test' }), /target/i);
    assert.equal(env.controller.getState().tabs.find(t => t.id === other)?.url, 'about:blank');
  } finally { await env.cleanup(); }
});

test('switching profiles restores each profile selected tab rather than another hidden tab', async () => {
  const env = await setup();
  try {
    const selected = await env.controller.newTab();
    const profile = env.controller.getContext().profileId;
    const other = await env.controller.createProfile('Other');
    await env.controller.activateProfile(other);
    await env.controller.activateProfile(profile);
    assert.equal(env.controller.getContext().tabId, selected);
  } finally { await env.cleanup(); }
});

test('quit preflight storage failure preserves views and recovers after storage is repaired', async () => {
  const env = await setup(() => {}, () => true);
  try {
    await env.controller.navigate('https://persist-preflight.test/');
    await env.controller.createProfile('Flush before failure');
    const context = env.controller.getContext();
    const views = env.window.children.size;
    await rm(env.dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
    await assert.rejects(env.controller.prepareToQuit(), /save browser profiles/i);
    assert.equal(env.window.children.size, views);
    assert.deepEqual(env.controller.getContext(), context);
    await mkdir(env.dataRoot, { recursive: true });
    assert.equal(await env.controller.prepareToQuit(), true);
    assert.equal(env.window.children.size, 0);
  } finally { await mkdir(env.dataRoot, { recursive: true }); await env.cleanup(); }
});

test('dispose retains native resources on missing storage and cleans them after repair', async () => {
  const env = await setup();const context=env.controller.getContext(),views=[...env.window.children];
  try{
    await env.controller.createProfile('Flush before removing test directory');
    await rm(env.dataRoot,{recursive:true,force:true,maxRetries:10,retryDelay:10});
    await assert.rejects(env.controller.dispose(),/save browser profiles/i);
    assert(views.every(view=>!view.webContents.destroyed));assert.equal(env.window.children.size,views.length);assert.equal(env.window.listenerCount('resize'),1);assert.deepEqual(env.controller.getContext(),context);
    await mkdir(env.dataRoot,{recursive:true});await env.controller.dispose();
    assert.equal(env.window.children.size,0);assert.equal(env.window.listenerCount('resize'),0);assert.throws(()=>env.controller.getContext(),/disposed/i);
  }finally{await mkdir(env.dataRoot,{recursive:true});await env.cleanup();}
});

test('switching away and back invalidates the original target approval revision', async () => {
  const env = await setup();
  try {
    const original = env.controller.getContext();
    const observed = await env.controller.observe(original);
    const other = await env.controller.createProfile('Other');
    await env.controller.activateProfile(other);
    await env.controller.activateProfile(original.profileId);
    await assert.rejects(env.controller.execute({ type: 'observe' }, { ...original, expectedRevision: observed.revision, jobId: 'job-test' }), /revision/i);
  } finally { await env.cleanup(); }
});

test('history and layout use only active native contents and exact renderer bounds', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const view = FakeView.all.at(-1)!;
    let back = 0; let forward = 0; let reload = 0;
    view.webContents.navigationHistory = { canGoBack: () => true, canGoForward: () => true, goBack: () => { back++; }, goForward: () => { forward++; } };
    view.webContents.reload = () => { reload++; };
    await env.controller.back(); await env.controller.forward(); await env.controller.reload();
    assert.equal(back, 1); assert.equal(forward, 1); assert.equal(reload, 1);
    env.controller.setLayout({ left: 60, top: 100, bottom: 20, sidebarWidth: 300, hideBrowser: false });
    assert.deepEqual(view.bounds, { x: 60, y: 100, width: 840, height: 680 });
    env.controller.setLayout({ left: 60, top: 100, bottom: 20, sidebarWidth: 300, hideBrowser: true });
    assert.equal(view.visible, false);
  } finally { await env.cleanup(); }
});

test('screenshots write capture bytes to safe job artifact files and reject blank homepage', async () => {
  const env = await setup();
  try {
    const context = env.controller.getContext();
    let observed = await env.controller.observe(context);
    await assert.rejects(env.controller.execute({ type: 'screenshot' }, { ...context, expectedRevision: observed.revision, jobId: 'test' }), /blank|homepage/i);
    await env.controller.navigate('https://fixture.test/');
    observed = await env.controller.observe(context);
    const execution = { ...context, expectedRevision: observed.revision, jobId: 'job-test' };
    await assert.rejects(env.controller.execute({ type: 'screenshot' }, { ...execution, jobId: '../escape' }), /job/i);
    const result = await env.controller.execute({ type: 'screenshot' }, execution);
    assert.ok(result.artifact);
    assert.equal(result.artifact.kind, 'screenshot');
    assert.ok(result.artifact.path.startsWith(join(env.dataRoot, 'jobs', 'job-test', 'artifacts')));
    assert.equal((await readFile(result.artifact.path)).toString(), 'test-only-image');
  } finally { await env.cleanup(); }
});

test('observe and typed execute bind exact active IDs and fresh DOM revisions', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://fixture.test/');
    const context = env.controller.getContext();
    const observed = await env.controller.observe(context);
    assert.equal(observed.text, 'Hello');
    const wc = FakeView.all.at(-1)!.webContents;
    const execution = { ...context, expectedRevision: observed.revision, jobId: 'job-test' };
    await env.controller.execute({ type: 'click', ref: 'r1' }, execution);
    assert.match(wc.calls.at(-1)!, /\.act\(/);
    wc.stamp = 'doc:changed';
    await assert.rejects(env.controller.execute({ type: 'click', ref: 'r1' }, execution), /revision/i);
    assert.ok((await env.controller.observe(context)).revision > observed.revision);
    await env.controller.newTab();
    await assert.rejects(env.controller.observe(context), /target/i);
    await assert.rejects(env.controller.execute({ type: 'navigate', url: 'https://other.test' }, execution), /target/i);
  } finally { await env.cleanup(); }
});

test('profiles isolate partitions, survive restart and never persist incognito metadata', async () => {
  const env = await setup();
  try {
    const baseline = env.controller.getContext();
    const work = await env.controller.createProfile('Work');
    await env.controller.activateProfile(work);
    assert.notEqual(env.controller.getContext().tabId, baseline.tabId);
    assert.equal(FakeView.all.at(-1)!.options.webPreferences.session, sessions.get(`persist:sidework-${work}`));
    assert.throws(() => env.controller.activateTab(baseline.tabId), /tab/i);
    const privateId = await env.controller.createProfile('Private secret', true);
    await env.controller.activateProfile(privateId);
    assert.equal(FakeView.all.at(-1)!.options.webPreferences.session, sessions.get(`sidework-${privateId}`));
    await env.controller.activateProfile(work);
    await env.controller.dispose();
    const saved = await readFile(join(env.dataRoot, 'browser-profiles.json'), 'utf8');
    assert.doesNotMatch(saved, /Private secret/);
    const restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
    await restart.initialize();
    assert.equal(restart.getState().activeProfileId, work);
    assert.equal(restart.getState().profiles.find(p => p.id === work)?.name, 'Work');
    assert.equal(restart.getState().tabs[0]!.url, 'about:blank');
    const clone = restart.getState(); clone.profiles[0]!.name = 'changed';
    assert.notEqual(restart.getState().profiles[0]!.name, 'changed');
    await restart.dispose();
  } finally { await env.cleanup(); }
});

test('remote sessions deny permissions, downloads, popups and unsafe frame navigation', async () => {
  const env = await setup();
  try {
    const ses = sessions.get('persist:sidework-default')!;
    assert.equal(ses.check?.(), false);
    let granted = true;
    ses.request?.({}, 'camera', (value: boolean) => { granted = value; });
    assert.equal(granted, false);
    let blocked = false; let cancelled = false;
    ses.emit('will-download', { preventDefault: () => { blocked = true; } }, { cancel: () => { cancelled = true; } });
    assert.equal(blocked, true);
    assert.equal(cancelled, true);
    const wc = FakeView.all.at(-1)!.webContents;
    assert.deepEqual(wc.popup?.(), { action: 'deny' });
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      let denied = false;
      wc.emit(event, { url: 'file:///private/test', preventDefault: () => { denied = true; } }, 'file:///private/test');
      assert.equal(denied, true, event);
    }
    await assert.rejects(env.controller.navigate('javascript:alert(1)'), /navigation/i);
  } finally { await env.cleanup(); }
});

test('native app-owned tabs hide blank homepage and clean up only their views', async () => {
  const env = await setup();
  try {
    const state = env.controller.getState();
    assert.equal(state.profiles[0]!.id, 'default');
    assert.equal(state.tabs.length, 1);
    const first = FakeView.all.at(-1)!;
    assert.equal(first.visible, false);
    assert.equal(first.options.webPreferences.nodeIntegration, false);
    assert.equal(first.options.webPreferences.sandbox, true);
    assert.equal(first.options.webPreferences.contextIsolation, true);
    assert.equal(first.options.webPreferences.preload, undefined);
    await env.controller.navigate('https://fixture.test/');
    assert.equal(first.visible, true);
    const id = await env.controller.newTab('about:blank', 'agent');
    assert.equal(env.controller.getState().tabs.find(t => t.id === id)?.ownership, 'agent');
    assert.equal(first.visible, false);
    await env.controller.closeTab(id);
    assert.equal(env.controller.getContext().tabId, state.tabs[0]!.id);
    assert.throws(() => env.controller.activateTab('unknown'), /tab/i);
  } finally { await env.cleanup(); }
  assert.equal(env.window.children.size, 0);
  assert.equal(env.window.listenerCount('resize'), 0);
});

test('native destruction can clear WebContentsView.webContents before its destroyed callback',async()=>{
 const env=await setup();let view:FakeView|undefined,wc:FakeContents|undefined;
 try{
  await env.controller.navigate('https://native-close.test/');view=FakeView.all.at(-1)!;wc=view.webContents;const id=env.controller.getContext().tabId;
  wc.prependOnceListener('destroyed',()=>Object.defineProperty(view!,'webContents',{configurable:true,get:()=>undefined}));
  await env.controller.closeTab(id);assert.equal(wc.destroyed,true);assert.equal(env.controller.getState().tabs.some(tab=>tab.id===id),false);assert.equal(env.controller.getState().closedTabCount,1);
 }finally{if(view&&wc)Object.defineProperty(view,'webContents',{configurable:true,value:wc,writable:true});await env.cleanup();}
});

test('native discard does not reenter a pending beforeunload transaction',async()=>{
 const env=await setup(undefined,()=>true);
 try{
  await env.controller.navigate('https://native-veto-turn.test/');const wc=FakeView.all.at(-1)!.webContents,id=env.controller.getContext().tabId;wc.vetoClose=true;
  let nativeTurn=false;const close=wc.close.bind(wc);wc.close=options=>{if(nativeTurn)return;nativeTurn=true;close(options);setImmediate(()=>{nativeTurn=false;});};
  await env.controller.closeTab(id);assert.equal(wc.destroyed,true);assert.equal(wc.overrides,1);assert.equal(env.controller.getState().tabs.some(tab=>tab.id===id),false);
 }finally{await env.cleanup();}
});

test('discard confirmation cannot close a document replaced while the question was pending',async()=>{
 const env=await setup(undefined,()=>{void env.controller.navigate('https://replacement.test/');return true;});
 try{
  await env.controller.navigate('https://old-draft.test/');const wc=FakeView.all.at(-1)!.webContents;wc.vetoClose=true;const id=env.controller.getContext().tabId;
  await env.controller.closeTab(id);assert.equal(wc.destroyed,false);assert.equal(wc.overrides,0);assert.equal(wc.closeAttempts,1);assert.equal(env.controller.getState().tabs.find(tab=>tab.id===id)!.url,'https://replacement.test/');
 }finally{await env.cleanup();}
});

test('synchronous native discard confirmation authorizes only the original veto event',async()=>{
 const env=await setup(undefined,()=>true);
 try{await env.controller.navigate('https://native-sync-discard.test/');const wc=FakeView.all.at(-1)!.webContents;wc.vetoClose=true;await env.controller.closeTab(env.controller.getContext().tabId);assert.equal(wc.destroyed,true);assert.equal(wc.overrides,1);assert.equal(wc.closeAttempts,1);}finally{await env.cleanup();}
});

test('real native veto asks before allowing one revalidated close override',async()=>{
 let allow=false;const reasons:string[]=[];const env=await setup(undefined,(_tab,reason)=>{reasons.push(reason);return allow;});
 try{
  await env.controller.navigate('https://draft.test/');const id=env.controller.getContext().tabId,wc=FakeView.all.at(-1)!.webContents;wc.vetoClose=true;wc.stamp='unsaved-draft';
  await env.controller.closeTab(id);assert.equal(wc.destroyed,false);assert.equal(wc.stamp,'unsaved-draft');assert.deepEqual(reasons,['tab']);assert.equal(wc.overrides,0);
  allow=true;await env.controller.closeTab(id);assert.equal(wc.destroyed,true);assert.equal(wc.overrides,1);assert.equal(wc.closeAttempts,2);assert.deepEqual(reasons,['tab','tab']);
 }finally{await env.cleanup();}
});

test('ordinary nonblank native close needs no confirmation, including without a callback', async () => {
  for (const confirm of [undefined, () => { assert.fail('ordinary close must not prompt'); }]) {
    const env = await setup(() => {}, confirm);
    try {
      await env.controller.navigate('https://ordinary.test/');
      const id = env.controller.getContext().tabId, wc = FakeView.all.at(-1)!.webContents;
      await env.controller.closeTab(id);
      assert.equal(wc.destroyed, true);
      assert.equal(env.controller.getState().tabs.some(tab => tab.id === id), false);
      assert.equal(env.controller.getState().closedTabCount, 1);
    } finally { await env.cleanup(); }
  }
});

test('cancelled native close preserves the identical native page and state; absent callback retains veto', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://form.test/');
    const page = FakeView.all.at(-1)!;
    page.webContents.vetoClose = true;
    page.webContents.stamp = 'typed-unsaved-page';
    const before = env.controller.getState();
    await env.controller.closeTab(before.activeTabId!);
    assert.deepEqual(env.controller.getState(), before);
    assert.equal(page.webContents.destroyed, false);
    assert.ok(env.window.children.has(page));
    assert.equal(page.webContents.stamp, 'typed-unsaved-page');
    assert.equal(page.webContents.overrides, 0);
  } finally { await env.cleanup(); }
});

test('native quit preserves normal tab URL metadata while closing the owned views without blanket confirmation',async()=>{
 const env=await setup(undefined,()=>assert.fail('ordinary quit must not prompt'));
 try{
  await env.controller.navigate('https://one.test/');await env.controller.newTab('https://two.test/');
  const before=env.controller.getState().tabs.map(({id,url,profileId})=>({id,url,profileId})),views=[...env.window.children];
  assert.equal(await env.controller.prepareToQuit(),true);
  assert.deepEqual(env.controller.getState().tabs.map(({id,url,profileId})=>({id,url,profileId})),before);assert(views.every(view=>view.webContents.destroyed));assert.equal(env.window.children.size,0);
  await env.controller.dispose();await env.controller.dispose();
  const stored=JSON.parse(await readFile(join(env.dataRoot,'browser-session.json'),'utf8')) as {tabs:{url:string}[]};assert.deepEqual(stored.tabs.map(tab=>tab.url),before.map(tab=>tab.url));
  const restart=new BrowserController({window:new FakeWindow() as unknown as BrowserWindow,dataRoot:env.dataRoot,onChange:()=>{}});await restart.initialize();assert.deepEqual(restart.getState().tabs.map(tab=>tab.url),before.map(tab=>tab.url));await restart.dispose();
 }finally{await env.cleanup();}
});
test('quit veto preserves the vetoed native draft and clean-tab URL metadata',async()=>{
 const reasons:string[]=[];const env=await setup(undefined,(_tab,reason)=>{reasons.push(reason);return false;});
 try{
  await env.controller.navigate('https://clean.test/');const clean=FakeView.all.at(-1)!.webContents;
  await env.controller.newTab('https://draft.test/');const draft=FakeView.all.at(-1)!.webContents;draft.vetoClose=true;draft.stamp='actual-unsaved-draft';
  assert.equal(await env.controller.prepareToQuit(),false);assert.equal(draft.destroyed,false);assert.equal(draft.stamp,'actual-unsaved-draft');assert.equal(draft.overrides,0);assert.equal(clean.destroyed,true);
  assert.deepEqual(reasons,['quit']);assert.deepEqual(env.controller.getState().tabs.map(tab=>tab.url),['https://clean.test/','https://draft.test/']);assert.equal(env.controller.getState().tabs[0]!.lifecycle,'dormant');
 }finally{await env.cleanup();}
});

test('dispose save failure retains usable live pages instead of tearing them down',async()=>{
 const env=await setup();const saved=`${env.dataRoot}-saved`;
 await env.controller.navigate('https://keep-live.test/');const wc=FakeView.all.at(-1)!.webContents;
 // Drain pending writes before replacing only this test-owned directory with a non-directory.
 await env.controller.activateProfile('default');await rename(env.dataRoot,saved);await writeFile(env.dataRoot,'not-a-directory');
 try{
  await assert.rejects(env.controller.dispose(),/save browser profiles/);assert.equal(wc.destroyed,false);
 }finally{await rm(env.dataRoot,{force:true});await rename(saved,env.dataRoot);await env.cleanup();}
});

test('native beforeunload veto keeps the actual view and does not invent a recently closed tab', async () => {
  const env = await setup(() => {}, () => false);
  try {
    await env.controller.navigate('https://form.test/');
    const page = FakeView.all.at(-1)!;
    page.webContents.close = () => { page.webContents.emit('will-prevent-unload', { preventDefault: () => assert.fail('must not override native veto') }); };
    const before = env.controller.getState();
    await env.controller.closeTab(before.activeTabId!);
    assert.deepEqual(env.controller.getState(), before);
    assert.ok(env.window.children.has(page));
    page.webContents.close = () => { page.webContents.destroyed = true; page.webContents.emit('destroyed'); };
  } finally { await env.cleanup(); }
});
test('restore closed is URL-only with fresh identity, excludes incognito, and no-ops when empty', async () => {
  const env = await setup(() => {}, () => true);
  try {
    const blank = env.controller.getContext().tabId;
    await env.controller.restoreClosedTab();
    assert.equal(env.controller.getContext().tabId, blank);
    const id = await env.controller.newTab('https://restore.test/');
    FakeView.all.at(-1)!.webContents.stamp = 'unsaved secret';
    await env.controller.closeTab(id);
    assert.equal(env.controller.getState().closedTabCount, 1);
    await env.controller.restoreClosedTab();
    assert.equal(env.controller.getState().closedTabCount, 0);
    const restored = env.controller.getState().tabs.at(-1)!;
    assert.notEqual(restored.id, id);
    assert.equal(restored.url, 'https://restore.test/');
    assert.notEqual(FakeView.all.at(-1)!.webContents.stamp, 'unsaved secret');
    const privateId = await env.controller.createProfile('private', true);
    await env.controller.activateProfile(privateId);
    const privateTab = await env.controller.newTab('https://private.test/');
    await env.controller.closeTab(privateTab);
    assert.equal(env.controller.getState().closedTabCount, 0);
  } finally { await env.cleanup(); }
});
test('session persistence writes ordered normal URL metadata only, excludes incognito and serializes concurrent changes', async () => {
  const env = await setup(() => {}, () => true);
  try {
    await env.controller.navigate('https://one.test/');
    const second = await env.controller.newTab('https://two.test/');
    await env.controller.closeTab(second);
    const work = await env.controller.createProfile('Work');
    await env.controller.activateProfile(work);
    await env.controller.navigate('https://work.test/');
    const priv = await env.controller.createProfile('hidden-profile', true);
    await env.controller.activateProfile(priv);
    await env.controller.navigate('https://secret.test/');
    await env.controller.dispose();
    const raw = await readFile(join(env.dataRoot, 'browser-session.json'), 'utf8');
    const saved = JSON.parse(raw);
    assert.deepEqual(saved.tabs.map((t: { url: string }) => t.url), ['https://one.test/', 'https://work.test/']);
    assert.deepEqual(saved.closedTabs.map((t: { url: string }) => t.url), ['https://two.test/']);
    assert.doesNotMatch(raw, /secret|hidden-profile|revision|ownership|stamp|title|elements|html|cookies/i);
    assert.deepEqual(Object.keys(saved.tabs[0]).sort(), ['profileId', 'url']);
    assert.equal(saved.activeProfileId, 'default');
    assert.ok(Number.isInteger(saved.activeTabIndex));
  } finally { await env.cleanup(); }
});
test('restart restores URL order with fresh user identities and only one live view, activation materializes dormant tabs', async () => {
  const env = await setup(() => {}, () => true);
  let restart: InstanceType<typeof BrowserController> | undefined;
  try {
    await env.controller.navigate('https://first.test/');
    await env.controller.newTab('https://second.test/', 'agent');
    const removed = await env.controller.newTab('https://closed.test/');
    await env.controller.closeTab(removed);
    const oldIds = env.controller.getState().tabs.map(t => t.id);
    await env.controller.dispose();
    restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
    await restart.initialize();
    let state = restart.getState();
    assert.deepEqual(state.tabs.map(t => t.url), ['https://first.test/', 'https://second.test/']);
    assert.equal(env.window.children.size, 1);
    assert.deepEqual(state.tabs.map(t => t.lifecycle), ['live', 'dormant']);
    assert.ok(state.tabs.every(t => !oldIds.includes(t.id) && t.ownership === 'user'));
    assert.equal(state.closedTabCount, 1);
    const dormant = state.tabs[1]!;
    await assert.rejects(restart.observe({ profileId: dormant.profileId, tabId: dormant.id }), /target/i);
    await restart.activateTab(dormant.id);
    state = restart.getState();
    assert.equal(env.window.children.size, 2);
    assert.equal(state.tabs[1]!.lifecycle, 'live');
    const observation = await restart.observe(restart.getContext());
    assert.equal(observation.url, 'https://second.test/');
    await assert.rejects(restart.execute({ type: 'navigate', url: 'https://stale.test/' }, { ...restart.getContext(), expectedRevision: dormant.revision, jobId: 'job-test' }), /revision/i);
  } finally { await restart?.dispose(); await env.cleanup(); }
});
test('normal navigation and selection persist before dispose through queued snapshots', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://first.test/');
    const first = env.controller.getContext().tabId;
    await env.controller.newTab('https://second.test/');
    env.controller.activateTab(first);
    // Drain asynchronous filesystem writes without tearing down live views.
    let saved: { tabs: { url: string }[]; activeTabIndex: number } | undefined;
    for (let i = 0; i < 100; i++) {
      try { saved = JSON.parse(await readFile(join(env.dataRoot, 'browser-session.json'), 'utf8')); } catch { /* pending first write */ }
      if (saved?.tabs.length === 2 && saved.activeTabIndex === 0) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(saved?.tabs.map(t => t.url), ['https://first.test/', 'https://second.test/']);
    assert.equal(saved?.activeTabIndex, 0);
    assert.equal(env.window.children.size, 2);
  } finally { await env.cleanup(); }
});
test('unsafe or unknown-profile session records fail closed without repairing executable URLs', async () => {
  const env = await setup();
  try {
    await env.controller.dispose();
    for (const record of [
      { profileId: 'default', url: 'javascript:alert(1)' },
      { profileId: 'default', url: 'fixture.test' },
      { profileId: 'default', url: 'https://user:pass@fixture.test/' },
      { profileId: 'unknown', url: 'https://fixture.test/' },
    ]) {
      await writeFile(join(env.dataRoot, 'browser-session.json'), JSON.stringify({ version: 1, tabs: [record] }));
      const restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
      try {
        await assert.rejects(restart.initialize(), /restore browser session/i);
        assert.equal(env.window.children.size, 0);
      } finally { await restart.dispose(); }
    }
  } finally { await env.cleanup(); }
});
test('recently closed counts and restores are confined to the active normal profile', async () => {
  const env = await setup(() => {}, () => true);
  try {
    const tab = await env.controller.newTab('https://normal.test/');
    await env.controller.closeTab(tab);
    assert.equal(env.controller.getState().closedTabCount, 1);
    const work = await env.controller.createProfile('Work');
    await env.controller.activateProfile(work);
    const before = env.controller.getState();
    assert.equal(before.closedTabCount, 0);
    await env.controller.restoreClosedTab();
    assert.deepEqual(env.controller.getState(), before);
    const privateId = await env.controller.createProfile('Private', true);
    await env.controller.activateProfile(privateId);
    assert.equal(env.controller.getState().closedTabCount, 0);
    const privateBefore = env.controller.getState();
    await env.controller.restoreClosedTab();
    assert.deepEqual(env.controller.getState(), privateBefore);
    await env.controller.activateProfile('default');
    await env.controller.restoreClosedTab();
    assert.equal(env.controller.getState().tabs.at(-1)!.url, 'https://normal.test/');
  } finally { await env.cleanup(); }
});
test('restored active navigation never blocks browser initialization or dormant activation, but agent loads are awaited', async () => {
  const env = await setup();
  let restart: InstanceType<typeof BrowserController> | undefined;
  const originalLoad = FakeContents.prototype.loadURL;
  const pending: (() => void)[] = [];
  try {
    await env.controller.newTab('https://slow-one.test/');
    await env.controller.newTab('https://slow-two.test/');
    await env.controller.dispose();
    FakeContents.prototype.loadURL = async function(url: string) {
      if (url === 'about:blank') return originalLoad.call(this, url);
      await new Promise<void>(resolve => { pending.push(resolve); });
      await originalLoad.call(this, url);
    };
    restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
    const initialized = await Promise.race([restart.initialize().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]);
    assert.equal(initialized, true);
    assert.equal(env.window.children.size, 1);
    const dormant = restart.getState().tabs.find(t => t.lifecycle === 'dormant')!;
    await restart.activateTab(dormant.id);
    assert.equal(env.window.children.size, 2);
    for (const finish of pending.splice(0)) finish();
    const context = restart.getContext();
    const observed = await restart.observe(context);
    let done = false;
    const execution = restart.execute({ type: 'navigate', url: 'https://agent.test/' }, { ...context, expectedRevision: observed.revision, jobId: 'job-test' }).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false);
    assert.equal(pending.length, 1);
    pending.shift()!();
    await execution;
    const fresh = await restart.observe(context);
    const open = restart.execute({ type: 'open_tab', url: 'https://agent-tab.test/' }, { ...context, expectedRevision: fresh.revision, jobId: 'job-test' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);
    pending.shift()!();
    await open;
  } finally {
    FakeContents.prototype.loadURL = originalLoad;
    for (const finish of pending) finish();
    await restart?.dispose(); await env.cleanup();
  }
});
test('a superseded restored navigation neither poisons subsequent observation nor surfaces ERR_ABORTED', async () => {
  const env = await setup();
  let restart: InstanceType<typeof BrowserController> | undefined;
  const originalLoad = FakeContents.prototype.loadURL;
  let abort: (() => void) | undefined;
  try {
    await env.controller.navigate('https://slow.test/');
    await env.controller.dispose();
    FakeContents.prototype.loadURL = async function(url: string) {
      if (url === 'https://slow.test/') await new Promise<void>((_resolve, reject) => { abort = () => reject(Object.assign(new Error('superseded'), { code: 'ERR_ABORTED', errno: -3 })); });
      else await originalLoad.call(this, url);
    };
    restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
    await restart.initialize();
    await restart.navigate('https://replacement.test/');
    abort!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restart.getState().tabs[0]!.error, undefined);
    const observation = await restart.observe(restart.getContext());
    assert.equal(observation.url, 'https://replacement.test/');
  } finally { FakeContents.prototype.loadURL = originalLoad; await restart?.dispose(); await env.cleanup(); }
});
test('session reads are size-bounded before parsing and malformed files fail closed', async () => {
  const env = await setup();
  try {
    await env.controller.dispose();
    for (const payload of ['{broken', JSON.stringify({ version: 9, tabs: [] }), ' '.repeat(1024 * 1024) + JSON.stringify({ version: 1, tabs: [] })]) {
      await writeFile(join(env.dataRoot, 'browser-session.json'), payload);
      const restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
      try { await assert.rejects(restart.initialize(), /restore browser session/i); assert.equal(env.window.children.size, 0); }
      finally { await restart.dispose(); }
    }
  } finally { await env.cleanup(); }
});
test('a vetoed native close never retries automatically against a newly navigated page', async () => {
  const env = await setup();
  try {
    await env.controller.navigate('https://old.test/');
    const id = env.controller.getContext().tabId, wc = FakeView.all.at(-1)!.webContents;
    wc.vetoClose = true;
    await env.controller.closeTab(id);
    await env.controller.navigate('https://new.test/');
    assert.equal(wc.closeAttempts, 1);
    assert.equal(env.controller.getState().tabs.find(t => t.id === id)?.url, 'https://new.test/');
    assert.equal(env.controller.getState().closedTabCount, 0);
  } finally { await env.cleanup(); }
});
test('restoration caps tabs and recently closed URLs and closing a dormant tab never creates a view', async () => {
  const env = await setup(() => {}, () => true);
  let restart: InstanceType<typeof BrowserController> | undefined;
  try {
    await env.controller.dispose();
    await writeFile(join(env.dataRoot, 'browser-session.json'), JSON.stringify({ version: 1, activeProfileId: 'default', activeTabIndex: 1, tabs: Array.from({ length: 120 }, (_, i) => ({ profileId: 'default', url: `https://tab.test/${i}` })), closedTabs: Array.from({ length: 30 }, (_, i) => ({ profileId: 'default', url: `https://closed.test/${i}` })) }));
    restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {}, confirmClose: () => true });
    await restart.initialize();
    assert.equal(restart.getState().tabs.length, 100);
    assert.equal(restart.getState().closedTabCount, 20);
    assert.equal(env.window.children.size, 1);
    const dormant = restart.getState().tabs[0]!;
    const viewCount = FakeView.all.length;
    await restart.closeTab(dormant.id);
    assert.equal(FakeView.all.length, viewCount);
    assert.equal(env.window.children.size, 1);
    assert.equal(restart.getState().tabs.length, 99);
    await restart.dispose();
    const saved = JSON.parse(await readFile(join(env.dataRoot, 'browser-session.json'), 'utf8'));
    assert.equal(saved.tabs.length, 99);
    assert.equal(saved.closedTabs.length, 20);
  } finally { await restart?.dispose(); await env.cleanup(); }
});
test('malformed closed-tab or active-profile session metadata fails closed', async () => {
  const env = await setup();
  try {
    await env.controller.dispose();
    for (const metadata of [{ closedTabs: 'invalid' }, { closedTabs: [{ profileId: 'unknown', url: 'https://x.test/' }] }, { activeProfileId: 'unknown' }, { activeTabIndex: -1 }]) {
      await writeFile(join(env.dataRoot, 'browser-session.json'), JSON.stringify({ version: 1, tabs: [], ...metadata }));
      const restart = new BrowserController({ window: env.window as unknown as BrowserWindow, dataRoot: env.dataRoot, onChange: () => {} });
      try { await assert.rejects(restart.initialize(), /restore browser session/i); assert.equal(env.window.children.size, 0); }
      finally { await restart.dispose(); }
    }
  } finally { await env.cleanup(); }
});


test('goal bootstrap waits for native subframe loading to stop before its pinned settlement',async()=>{
 const env=await setup();try{
  const page=await env.controller.createGoalPage({profileId:env.controller.getContext().profileId,goalId:'bootstrap-load',url:'https://www.naver.com/',host:new FakeWindow() as unknown as BrowserWindow});
  const view=FakeView.all.at(-1)!,wc=view.webContents;let loading=true,settlements=0;
  wc.isLoading=()=>loading;wc.emit('did-start-loading');
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.includes('requestAnimationFrame')){settlements++;assert.equal(loading,false,'Naver subframes are not ready yet');}return original(world,scripts);};
  const stop=setTimeout(()=>{loading=false;wc.emit('did-stop-loading');},60);
  try{await env.controller.settleGoalPage(page.context);assert.equal(settlements,1);assert.equal(env.controller.getState().tabs.find(t=>t.id===page.context.tabId)!.isLoading,false);}finally{clearTimeout(stop);}
 }finally{await env.cleanup();}
});

test('pre-action bootstrap reacquires a fresh revision after same-native-page startup navigation, never reuses the stale pin',async()=>{
 const env=await setup();try{
  const page=await env.controller.createGoalPage({profileId:env.controller.getContext().profileId,goalId:'bootstrap-revision',url:'https://www.google.com/',host:new FakeWindow() as unknown as BrowserWindow});
  const wc=FakeView.all.at(-1)!.webContents;let settlements=0;
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.includes('requestAnimationFrame')&&++settlements===1)wc.emit('did-start-navigation',{isMainFrame:true},wc.url,true,true);return original(world,scripts);};
  await env.controller.settleGoalPage(page.context);assert.equal(settlements,2);
 }finally{await env.cleanup();}
});


test('bootstrap never restarts across native geometry, URL, frame or view ownership changes',async()=>{
 for(const change of ['geometry','url','frame','ownership']){
  const env=await setup();try{
   const page=await env.controller.createGoalPage({profileId:env.controller.getContext().profileId,goalId:'bootstrap-pin',url:'https://www.google.com/',host:new FakeWindow() as unknown as BrowserWindow});
   const wc=FakeView.all.at(-1)!.webContents;let settlements=0;
   const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
   wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{
    if(scripts[0]!.code.includes('requestAnimationFrame')){
     settlements++;
     if(change==='geometry')env.controller.setAgentLayout({top:200,left:0,bottom:0,sidebarWidth:360,hideBrowser:false});
     if(change==='url'){wc.url='https://www.google.com/search';wc.emit('did-navigate');}
     if(change==='frame')Object.assign(wc,{mainFrame:{processId:99,routingId:22}});
     if(change==='ownership')await env.controller.returnFromAgent(page.context);
    }
    return original(world,scripts);
   };
   await assert.rejects(env.controller.settleGoalPage(page.context),/changed|goal/i);assert.equal(settlements,1,change);
  }finally{await env.cleanup();}
 }
});

test('bootstrap revision churn is bounded to three fresh pre-action settlements',async()=>{
 const env=await setup();try{
  const page=await env.controller.createGoalPage({profileId:env.controller.getContext().profileId,goalId:'bootstrap-bounded',url:'https://www.google.com/',host:new FakeWindow() as unknown as BrowserWindow});
  const wc=FakeView.all.at(-1)!.webContents;let settlements=0;
  const original=wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{if(scripts[0]!.code.includes('requestAnimationFrame')){settlements++;wc.emit('did-start-navigation',{isMainFrame:true},wc.url,true,true);}return original(world,scripts);};
  await assert.rejects(env.controller.settleGoalPage(page.context),/changed/);assert.equal(settlements,3);
 }finally{await env.cleanup();}
});
