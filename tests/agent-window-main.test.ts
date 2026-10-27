import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import type {AppState,BrowserState,BrowserContext,MainToWorker,Observation,Job} from '../src/contract';

const mainUrl=new URL('../src/desktop/main.ts',import.meta.url);
const localRequire=createRequire(mainUrl);
function harness(){
 const handlers=new Map<string,(event:unknown,input?:unknown)=>Promise<AppState>|AppState>();
 const windows:Host[]=[];
 let failLoad=false;
 class Host extends EventEmitter{
  dead=false;shows=0;focuses=0;hides=0;loads:string[]=[];sent:AppState[]=[];
  webContents=Object.assign(new EventEmitter(),{mainFrame:{url:'file:///trusted'},send:(_channel:string,state:AppState)=>this.sent.push(state),setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}}});
  constructor(public options:unknown){super();windows.push(this);}
  isDestroyed(){return this.dead;}isMinimized(){return false;}restore(){}show(){this.shows++;}showInactive(){this.shows++;}focus(){this.focuses++;}hide(){this.hides++;}
  destroy(){this.dead=true;this.emit('closed');}
  async loadURL(url:string){this.loads.push(url);if(failLoad)throw new Error('load failed');this.webContents.mainFrame.url=url;this.emit('ready-to-show');}
 }
 const user=new Host({}),state:BrowserState={profiles:[{id:'p',name:'Default',incognito:false}],activeProfileId:'p',activeTabId:'a',paneTabIds:['a'],agentPaneTabIds:['b'],tabs:[{id:'a',profileId:'p',title:'user',url:'https://example.com/a',revision:1,ownership:'user',lifecycle:'live',isLoading:false,canGoBack:false,canGoForward:false},{id:'b',profileId:'p',title:'agent',url:'https://example.com/b',revision:2,ownership:'user',agentAreaId:'area-b',lifecycle:'live',isLoading:false,canGoBack:false,canGoForward:false}]};
 const layouts:string[]=[],returned:string[]=[];let holdObservation:Promise<void>|undefined,profileBarrier:Promise<void>|undefined;
 const controller={getState:()=>state,getAgentState:()=>({...state,tabs:state.tabs.filter(t=>t.agentAreaId),paneTabIds:state.tabs.filter(t=>t.agentAreaId).map(t=>t.id),activeTabId:'b',splitCount:2}),getControlVisuals:()=>[],setLayout:()=>layouts.push('browser'),setAgentLayout:()=>layouts.push('agent'),
  observe:async(context:BrowserContext)=>{await holdObservation;const tab=state.tabs.find(t=>t.id===context.tabId)!;return{...context,url:tab.url,revision:tab.revision,title:'',text:'',elements:[],capturedAt:'',readingViewport:{documentId:'doc-'+tab.id,scrollY:0,height:100,scrollHeight:100,text:''}} satisfies Observation;},
  captureUserPreview:async()=>({imageDataUrl:'data:image/png;base64,local-only'}),
  handoffToAgent:async(context:BrowserContext)=>{const tab=state.tabs.find(t=>t.id===context.tabId)!;tab.agentAreaId='area-'+tab.id;tab.revision++;state.paneTabIds=state.paneTabIds!.filter(id=>id!==tab.id);return{areaId:tab.agentAreaId,context};},
  returnFromAgent:async(context:BrowserContext)=>{returned.push(context.tabId);delete state.tabs.find(t=>t.id===context.tabId)!.agentAreaId;},
  createProfile:async()=>{await profileBarrier;},
  invalidatePageContext:(context:BrowserContext)=>{state.tabs.find(t=>t.id===context.tabId)!.revision++;},cancelScroll:async()=>{},cancelControlVisuals:async()=>{}
 };
 const app=Object.assign(new EventEmitter(),{getPath:()=>'/unused',setPath:()=>{},setName:()=>{},requestSingleInstanceLock:()=>true,isPackaged:true,getVersion:()=> 'test',whenReady:()=>({then:()=>({catch:()=>{}})}),quit:()=>{},getAppMetrics:()=>[]});
 const electron={app,BrowserWindow:Host,dialog:{},ipcMain:{handle:(name:string,handler:(event:unknown,input?:unknown)=>Promise<AppState>|AppState)=>handlers.set(name,handler)},nativeTheme:{},shell:{},utilityProcess:{}};
 const src=readFileSync(mainUrl,'utf8')+'\nexports.__setTest=(host,controller)=>{window=host;browser=controller;browserReady=true;host.webContents.mainFrame.url=trustedUrl;};exports.__runtime=(child,jobs)=>{worker=child;bridgeReady=true;providerStatus.authenticated=true;if(jobs)core.jobs=jobs;};exports.__ack=id=>{const request=pending.get(id);if(request){clearTimeout(request.timer);pending.delete(id);request.resolve({});}};';
 const output=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:{__setTest?:(host:Host,controller:unknown)=>void;__runtime?:(child:{postMessage:(raw:MainToWorker)=>void},jobs?:Job[])=>void;__ack?:(id:string)=>void}={};
 vm.runInNewContext(output,{exports,require:(name:string)=>name==='electron'?electron:localRequire(name),process,console,__dirname:new URL('../src/desktop',import.meta.url).pathname,setTimeout,clearTimeout,structuredClone,URL});
 exports.__setTest!(user,controller);
 const event=(host:Host)=>({sender:host.webContents,senderFrame:host.webContents.mainFrame});
 return{handlers,windows,user,state,layouts,event,returned,wire:exports.__runtime!,ack:exports.__ack!,hold:(barrier:Promise<void>)=>{holdObservation=barrier;},holdProfile:(barrier:Promise<void>)=>{profileBarrier=barrier;},failLoad:(value:boolean)=>{failLoad=value;}};
}

test('main owns one lazy trusted agent window and projects replies per exact sender',async()=>{
 const h=harness();const dispatch=h.handlers.get('sidework:dispatch')!,get=h.handlers.get('sidework:get-state')!;
 assert.equal(h.windows.length,1);
 const userState=await dispatch(h.event(h.user),{type:'agents.show'});
 assert.equal(h.windows.length,2);const agent=h.windows[1];
 await dispatch(h.event(h.user),{type:'agents.show'});assert.equal(h.windows.length,2);
 assert.equal(agent.loads.length,1);assert.equal(userState.surface,'browser');assert.deepEqual(userState.tabs.map(t=>t.id),['a']);assert.deepEqual(userState.agentTabs?.map(t=>t.id),['b']);
 const agentState=await get(h.event(agent));assert.equal(agentState.surface,'agent');assert.deepEqual(agentState.tabs.map(t=>t.id),['b']);
 await dispatch(h.event(agent),{type:'layout.set',sidebarWidth:0,top:100,left:0,bottom:0,hideBrowser:false});assert.deepEqual(h.layouts,['agent']);
 const denied=await dispatch(h.event(agent),{type:'tab.new'});assert.ok(denied.error);
 assert.throws(()=>get({sender:agent.webContents,senderFrame:{url:agent.webContents.mainFrame.url}}));
 await new Promise(resolve=>setTimeout(resolve,40));assert.ok(agent.sent.length);assert.ok(h.user.sent.length);
});

test('agent host close retains visible pages rather than destroying unsaved native contents',async()=>{
 const h=harness();await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});
 const host=h.windows[1];assert.ok(host);let prevented=false;
 host.emit('close',{preventDefault:()=>{prevented=true;}});
 assert.equal(prevented,true);assert.equal(host.dead,false);
});

test('main start uses native handoff then the existing epoch-stamped worker command without focus theft',async()=>{
 const h=harness(),sent:MainToWorker[]=[];
 h.wire({postMessage:raw=>{sent.push(raw);if(raw.kind==='command')h.ack(raw.id);}});
 const result=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.start',tabId:'a',prompt:'Read'});
 assert.equal(result.error,null);const request=sent.find(raw=>raw.kind==='command');assert.ok(request?.kind==='command'&&request.command.type==='start');
 assert.equal(request.command.input.executionEpoch,0);assert.equal(request.command.input.agentScope?.areaId,'area-a');assert.equal(request.command.input.initialDocument?.revision,2);
 assert.equal(h.windows[1].focuses,0);assert.equal(result.tabs.some(t=>t.id==='a'),false);
});

test('legacy job.start cannot race a pending delegation on the same visible page',async()=>{
 const h=harness(),sent:MainToWorker[]=[];let release!:()=>void;
 h.wire({postMessage:raw=>{sent.push(raw);if(raw.kind==='command')h.ack(raw.id);}});
 h.hold(new Promise<void>(resolve=>{release=resolve;}));
 const starting=h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.start',tabId:'a',prompt:'Read'});
 await new Promise<void>(resolve=>setImmediate(resolve));
 const duplicate=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'job.start',tabId:'a',prompt:'Read'});
 release();await starting;assert.ok(duplicate.error);assert.equal(sent.filter(raw=>raw.kind==='command').length,1);
});

test('delegation cannot race an unacknowledged legacy start on the same page',async()=>{
 const h=harness();let requestId:string|undefined;
 h.wire({postMessage:raw=>{if(raw.kind==='command'){if(raw.command.type==='start'&&raw.command.input.prompt==='Read')h.ack(raw.id);else requestId=raw.id;}}});
 const legacy=h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'job.start',tabId:'a',prompt:'Legacy'});
 const delegated=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.start',tabId:'a',prompt:'Read'});
 assert.ok(requestId);h.ack(requestId);await legacy;
 assert.ok(delegated.error);assert.equal(h.state.tabs[0].agentAreaId,undefined);
});

test('takeover revokes immediately but rehomes the same page only after cancel ACK',async()=>{
 const h=harness();let cancelId:string|undefined;
 const job={id:'job-b',profileId:'p',tabId:'b',status:'running',executionEpoch:0,agentScope:{areaId:'area-b',origin:'https://example.com',expiresAt:new Date(Date.now()+60000).toISOString()}} as Job;
 h.wire({postMessage:raw=>{if(raw.kind==='command')cancelId=raw.id;}},[job]);
 await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});
 const taking=h.handlers.get('sidework:dispatch')!(h.event(h.windows[1]),{type:'tab.takeControl',profileId:'p',tabId:'b'});
 assert.equal(h.state.tabs[1].revision,3);assert.deepEqual(h.returned,[]);
 assert.ok(cancelId);h.ack(cancelId);const result=await taking;assert.equal(result.error,null);assert.deepEqual(h.returned,['b']);
});

test('a pending profile transition blocks delegation until its native session is stable',async()=>{
 const h=harness();delete h.state.tabs[1].agentAreaId;h.state.agentPaneTabIds=[];
 let release!:()=>void;h.holdProfile(new Promise<void>(resolve=>{release=resolve;}));
 h.wire({postMessage:raw=>{if(raw.kind==='command')h.ack(raw.id);}});
 const changing=h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'profile.create',name:'Other'});
 await new Promise<void>(resolve=>setImmediate(resolve));
 const result=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.start',tabId:'a',prompt:'Read'});
 release();await changing;assert.ok(result.error);assert.equal(h.state.tabs[0].agentAreaId,undefined);
});

test('failed trusted renderer loading is never reused as a host for a later model job',async()=>{
 const h=harness();h.failLoad(true);const failed=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});assert.ok(failed.error);
 h.failLoad(false);const retried=await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});
 assert.equal(retried.error,null);assert.equal(h.windows.length,3);assert.equal(h.windows[1].dead,true);assert.equal(h.windows[2].loads.length,1);
});

test('closing an empty agent area hides and reuses its controller-owned native host',async()=>{
 const h=harness();await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});
 delete h.state.tabs[1].agentAreaId;h.state.agentPaneTabIds=[];let prevented=false;
 h.windows[1].emit('close',{preventDefault:()=>{prevented=true;}});
 assert.equal(prevented,true);assert.equal(h.windows[1].hides,1);
 await h.handlers.get('sidework:dispatch')!(h.event(h.user),{type:'agents.show'});assert.equal(h.windows.length,2);
});
