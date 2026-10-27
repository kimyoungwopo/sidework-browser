import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import ts from 'typescript';
import type {AppState,BrowserState,BrowserContext,MainToWorker,Observation,Job,WorkerToMain} from '../src/contract';

const mainUrl=new URL('../src/desktop/main.ts',import.meta.url);
const localRequire=createRequire(mainUrl);
function harness(){
 const handlers=new Map<string,(event:unknown,input?:unknown)=>Promise<AppState>|AppState>();
 const windows:Host[]=[];
 let quitPreparations=0;
 const sent:MainToWorker[]=[],timers:number[]=[];
 const child=Object.assign(new EventEmitter(),{stdout:{resume(){}},stderr:{resume(){}},kill(){},postMessage(raw:MainToWorker){sent.push(raw);}});
 class Host extends EventEmitter{
  dead=false;shows=0;focuses=0;hides=0;loads:string[]=[];sent:AppState[]=[];
  webContents=Object.assign(new EventEmitter(),{mainFrame:{url:'file:///trusted'},send:(_channel:string,state:AppState)=>this.sent.push(state),setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},setPermissionCheckHandler:()=>{}}});
  constructor(public options:unknown){super();windows.push(this);}
  isDestroyed(){return this.dead;}isMinimized(){return false;}restore(){}show(){this.shows++;}showInactive(){this.shows++;}focus(){this.focuses++;}hide(){this.hides++;}
  destroy(){this.dead=true;this.emit('closed');}
  async loadURL(url:string){this.loads.push(url);this.webContents.mainFrame.url=url;this.emit('ready-to-show');}
 }
 const user=new Host({}),state:BrowserState={profiles:[{id:'p',name:'Default',incognito:false}],activeProfileId:'p',activeTabId:'a',paneTabIds:['a'],agentPaneTabIds:[],tabs:[{id:'a',profileId:'p',title:'user',url:'about:blank',revision:1,ownership:'user',lifecycle:'live',isLoading:false,canGoBack:false,canGoForward:false},{id:'b',profileId:'p',title:'agent',url:'https://example.com/b',revision:2,ownership:'user',agentAreaId:'area-b',lifecycle:'live',isLoading:false,canGoBack:false,canGoForward:false}]};
 state.tabs=state.tabs.slice(0,1);
 const created:{profileId:string;goalId:string;url:string;host:Host}[]=[],captured:string[]=[],observed:string[]=[],settled:string[]=[];
 const layouts:string[]=[],returned:string[]=[];let holdObservation:Promise<void>|undefined;
 let nativeOptions:ConstructorParameters<typeof import('../src/desktop/browser').BrowserController>[0]|undefined;
 const controller={initialize:async()=>{},prepareToQuit:async()=>{quitPreparations++;return false;},getState:()=>state,getAgentState:()=>({...state,tabs:state.tabs.filter(t=>t.agentAreaId),paneTabIds:state.tabs.filter(t=>t.agentAreaId).map(t=>t.id),activeTabId:'b',splitCount:2}),getControlVisuals:()=>[],setLayout:()=>layouts.push('browser'),setAgentLayout:()=>layouts.push('agent'),
  observe:async(context:BrowserContext)=>{observed.push(context.tabId);await holdObservation;const tab=state.tabs.find(t=>t.id===context.tabId)!;return{...context,url:tab.url,revision:tab.revision,title:'',text:'',elements:[],capturedAt:'',readingViewport:{documentId:'doc-'+tab.id,scrollY:0,height:100,scrollHeight:100,text:''}} satisfies Observation;},
  captureUserPreview:async(context:BrowserContext)=>{captured.push(context.tabId);return{imageDataUrl:null,error:'Cross-origin frames block pixel capture'};},
  settleGoalPage:async(context:BrowserContext)=>{settled.push(context.tabId);},
  createGoalPage:async(input:{profileId:string;goalId:string;url:string;host:Host})=>{created.push(input);const id='goal-page-'+created.length,areaId='area-'+id;state.tabs.push({id,profileId:input.profileId,title:'owned',url:input.url,revision:7,ownership:'agent',agentAreaId:areaId,lifecycle:'live',isLoading:false,canGoBack:false,canGoForward:false});state.agentPaneTabIds!.push(id);return{areaId,context:{profileId:input.profileId,tabId:id}};},
  updateControlJobs:()=>{},execute:async()=>{throw new Error('unexpected execute');},
  handoffToAgent:async(context:BrowserContext)=>{const tab=state.tabs.find(t=>t.id===context.tabId)!;tab.agentAreaId='area-'+tab.id;tab.revision++;state.paneTabIds=state.paneTabIds!.filter(id=>id!==tab.id);return{areaId:tab.agentAreaId,context};},
  returnFromAgent:async(context:BrowserContext)=>{returned.push(context.tabId);delete state.tabs.find(t=>t.id===context.tabId)!.agentAreaId;},
  createProfile:async()=>{},
  invalidatePageContext:(context:BrowserContext)=>{state.tabs.find(t=>t.id===context.tabId)!.revision++;},cancelScroll:async()=>{},cancelControlVisuals:async()=>{}
 };
 const app=Object.assign(new EventEmitter(),{getPath:()=>'/unused',setPath:()=>{},setName:()=>{},requestSingleInstanceLock:()=>true,isPackaged:true,getVersion:()=> 'test',whenReady:()=>({then:()=>({catch:()=>{}})}),quit:()=>{},getAppMetrics:()=>[]});
 const electron={app,BrowserWindow:Host,dialog:{showMessageBox:async()=>({response:0})},ipcMain:{handle:(name:string,handler:(event:unknown,input?:unknown)=>Promise<AppState>|AppState)=>handlers.set(name,handler)},nativeTheme:{},shell:{},utilityProcess:{fork:()=>{queueMicrotask(()=>child.emit('message',{kind:'ready'}));return child;}}};
 const src=readFileSync(mainUrl,'utf8')+'\nexports.__setTest=(host,controller)=>{window=host;browser=controller;browserReady=true;host.webContents.mainFrame.url=trustedUrl;providerStatus.authenticated=true;};exports.__start=()=>startWorker();exports.__create=()=>createWindow();exports.__deny=()=>{providerStatus.authenticated=false;};';
 const output=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports:{__setTest?:(host:Host,controller:unknown)=>void;__start?:()=>Promise<void>;__create?:()=>Promise<void>;__deny?:()=>void}={};
 vm.runInNewContext(output,{exports,require:(name:string)=>{if(name==='electron')return electron;if(name==='./browser')return{BrowserController:function(this:object,options:NonNullable<typeof nativeOptions>){nativeOptions=options;Object.assign(this,controller);}};if(name==='node:fs/promises')return{...localRequire(name),mkdir:async()=>{}};if(name==='./codex-desktop')return{...localRequire(name),inspectCodexDesktop:async()=>({installed:false,targetReady:false,detail:'test'})};return localRequire(name);},process,console,__dirname:new URL('../src/desktop',import.meta.url).pathname,setTimeout:(callback:()=>void,ms:number)=>{timers.push(ms);return setTimeout(callback,ms);},clearTimeout,structuredClone,URL});
 exports.__setTest!(user,controller);
 const event=(host:Host)=>({sender:host.webContents,senderFrame:host.webContents.mainFrame});
 const reply=(id:string,value:unknown,ok=true)=>child.emit('message',{kind:'response',id,ok,value,error:ok?undefined:'계획을 확인하지 못했습니다.'} satisfies WorkerToMain);
 const dispatch=(raw:unknown)=>Promise.resolve(handlers.get('sidework:dispatch')!(event(user),raw));
 const get=()=>handlers.get('sidework:get-state')!(event(user)) as AppState;
 const bootNative=async()=>{await exports.__create!();exports.__setTest!(user,controller);assert.ok(nativeOptions);return nativeOptions;};
 return{holdObservation:(barrier:Promise<void>)=>{holdObservation=barrier;},quitPreparations:()=>quitPreparations,bootNative,dispatch,get,state,sent,timers,created,captured,observed,settled,windows,start:exports.__start!,deny:exports.__deny!,reply,child,app};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function request(h:ReturnType<typeof harness>,type:string){const raw=h.sent.find(raw=>raw.kind==='command'&&raw.command.type===type);assert.ok(raw?.kind==='command');return raw;}
const plan={title:'Research',tasks:[{title:'Read public source',prompt:'Read evidence',url:'https://example.com/read',allowedOrigins:['https://example.com'],blocker:null}]};

test('blank-tab main IPC accepts a root before background planning completes',async()=>{
 const h=harness();await h.start();
 const result=await h.dispatch({type:'goals.start',prompt:'Research public evidence'});
 assert.equal(result.error,null);assert.equal(result.goalTasks?.length,1);
 assert.equal(result.goalTasks[0].status,'planning');
 const planning=request(h,'goal.plan');assert.ok(planning.command.type==='goal.plan');
 assert.equal(planning.command.goalId,result.goalTasks[0].id);assert.equal(h.created.length,0);
 assert.equal(h.state.activeTabId,'a');assert.deepEqual(result.tabs.map(t=>t.id),['a']);
 h.reply(planning.id,{title:'Unsupported',tasks:[{title:'Blocked',prompt:'Cannot run',url:null,allowedOrigins:[],blocker:'Unsupported'}]});await tick();
});

async function running(h:ReturnType<typeof harness>){
 await h.start();const accepted=await h.dispatch({type:'goals.start',prompt:'Research'});
 const planning=request(h,'goal.plan');h.reply(planning.id,plan);await tick();
 const start=request(h,'start');assert.ok(start.command.type==='start');
 const job:Job={...start.command.input,id:'job-owned',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0};
 const snapshot={jobs:[job],activeJobId:job.id,settings:accepted.settings,memory:[]};
 h.child.emit('message',{kind:'snapshot',snapshot} satisfies WorkerToMain);
 h.reply(start.id,job.id);await tick();return{job,goalId:accepted.goalTasks![0].id,snapshot};
}
test('assigned goal child uses main-owned host and epoch binding without changing user tabs',async()=>{
 const h=harness(),before=structuredClone(h.state);const {job,goalId,snapshot}=await running(h);
 assert.equal(job.executionEpoch,0);assert.equal(job.agentScope?.goalId,goalId);
 assert.equal(job.agentScope?.areaId,'area-goal-page-1');assert.deepEqual(job.initialDocument,{url:plan.tasks[0].url,revision:7,documentId:'doc-goal-page-1'});
 assert.equal(job.computerUse,false);assert.equal(job.shareScreen,false);
 assert.deepEqual(h.settled,['goal-page-1']);assert.deepEqual(h.captured,[],'DOM mode must not depend on pixel capture');assert.deepEqual(h.observed,['goal-page-1']);
 assert.equal(h.created[0].host,h.windows[1]);assert.equal(h.windows[1].focuses,0);
 assert.deepEqual(h.state.tabs[0],before.tabs[0]);assert.equal(h.state.activeTabId,before.activeTabId);assert.deepEqual(h.state.paneTabIds,before.paneTabIds);
 h.child.emit('message',{kind:'snapshot',snapshot:{...snapshot,jobs:[{...job,status:'completed',answer:'Evidence with source'}],activeJobId:null}} satisfies WorkerToMain);
 const root=h.get().goalTasks![0];assert.equal(root.status,'completed');assert.equal(root.children[0].answer,'Evidence with source');
 h.state.activeProfileId='other';assert.deepEqual(h.get().goalTasks,[]);
});
test('CLI planning has a bounded deadline longer than the ordinary command timeout',async()=>{
 const h=harness();await h.start();await h.dispatch({type:'goals.start',prompt:'Research'});
 const planning=request(h,'goal.plan');assert.ok(h.timers.some(ms=>ms>=180000));
 h.reply(planning.id,null,false);await tick();
});
test('pending root planning blocks profile switching, reconnect and exit without touching browser',async()=>{
 const h=harness();await h.start();await h.dispatch({type:'goals.start',prompt:'Research'});
 assert.ok((await h.dispatch({type:'profile.activate',profileId:'other'})).error);
 assert.ok((await h.dispatch({type:'provider.check'})).error);
 let prevented=false;h.app.emit('before-quit',{preventDefault(){prevented=true;}});await tick();
 assert.equal(prevented,true);assert.equal(h.state.activeProfileId,'p');assert.equal(h.get().bridgeReady,true);
 assert.match(h.get().error??'',/계획|준비|목표/);
 h.reply(request(h,'goal.plan').id,null,false);await tick();
});
test('main rejects unknown fields, disconnected provider and incognito before creating a goal',async()=>{
 const h=harness();await h.start();
 assert.ok((await h.dispatch({type:'goals.start',prompt:'Read',tabId:'a'})).error);
 h.state.profiles[0].incognito=true;assert.ok((await h.dispatch({type:'goals.start',prompt:'Read'})).error);
 h.state.profiles[0].incognito=false;h.deny();assert.ok((await h.dispatch({type:'goals.start',prompt:'Read'})).error);
 assert.equal(h.get().goalTasks!.length,0);assert.equal(h.sent.length,0);
});
test('exact root cancel ACK revokes worker routing immediately while peer root stays active',async()=>{
 const h=harness(),{job,goalId}=await running(h);
 await h.dispatch({type:'goals.start',prompt:'Peer'});const peer=h.get().goalTasks![0];
 const cancelling=h.dispatch({type:'goals.cancel',goalId});
 assert.equal(h.get().goalTasks!.find(root=>root.id===goalId)!.status,'cancelling');
 const cancel=request(h,'cancel'),cancelPlan=request(h,'goal.cancelPlan');
 assert.ok(cancel.command.type==='cancel');assert.equal(cancel.command.jobId,job.id);
 assert.ok(cancelPlan.command.type==='goal.cancelPlan');assert.equal(cancelPlan.command.goalId,goalId);
 const observed=h.observed.length;
 h.child.emit('message',{kind:'browser.request',id:'late',operation:'observe',context:{profileId:job.profileId,tabId:job.tabId},jobId:job.id,computerUse:false,shareScreen:false} satisfies WorkerToMain);await tick();
 const response=h.sent.find(raw=>raw.kind==='browser.response'&&raw.id==='late');assert.ok(response?.kind==='browser.response');assert.equal(response.ok,false);assert.equal(h.observed.length,observed);
 h.reply(cancel.id,undefined);h.reply(cancelPlan.id,undefined);await cancelling;
 assert.equal(h.get().goalTasks!.find(root=>root.id===goalId)!.status,'cancelled');assert.equal(h.get().goalTasks!.find(root=>root.id===peer.id)!.status,'planning');
 for(const raw of h.sent)if(raw.kind==='command'&&raw.command.type==='goal.plan'&&raw.command.goalId===peer.id)h.reply(raw.id,null,false);
 await tick();
});
test('worker exit interrupts roots but leaves ordinary browsing state intact',async()=>{
 const h=harness();await h.start();const before=structuredClone(h.state);
 await h.dispatch({type:'goals.start',prompt:'Research'});h.child.emit('exit');await tick();
 assert.equal(h.get().goalTasks![0].status,'interrupted');assert.equal(h.get().browserReady,true);assert.equal(h.get().bridgeReady,false);assert.deepEqual(h.state,before);
});

test('worker requests accept exact main grants and deny worker-issued goal capabilities',async()=>{
 const h=harness(),{job,snapshot}=await running(h);
 const observe=(id:string,jobId:string)=>h.child.emit('message',{kind:'browser.request',id,operation:'observe',context:{profileId:job.profileId,tabId:job.tabId},jobId,computerUse:false,shareScreen:false} satisfies WorkerToMain);
 observe('valid',job.id);await tick();
 const valid=h.sent.find(raw=>raw.kind==='browser.response'&&raw.id==='valid');assert.ok(valid?.kind==='browser.response');assert.equal(valid.ok,true);
 const count=h.observed.length;
 h.child.emit('message',{kind:'snapshot',snapshot:{...snapshot,jobs:[{...job,id:'worker-forged',prompt:'Broader worker request'}]}} satisfies WorkerToMain);
 observe('forged','worker-forged');await tick();
 const forged=h.sent.find(raw=>raw.kind==='browser.response'&&raw.id==='forged');assert.ok(forged?.kind==='browser.response');assert.equal(forged.ok,false);assert.equal(h.observed.length,count);
});

test('native execution guard checks the same main ledger before and during cancellation',async()=>{
 const h=harness(),options=await h.bootNative(),{job,goalId,snapshot}=await running(h);
 const context={profileId:job.profileId,tabId:job.tabId,jobId:job.id,executionEpoch:job.executionEpoch,expectedRevision:7};
 assert.equal(options.allowExecution?.(context),true);
 h.child.emit('message',{kind:'snapshot',snapshot:{...snapshot,jobs:[{...job,prompt:'Worker minted broader request'}]}} satisfies WorkerToMain);
 assert.equal(options.allowExecution?.(context),false);
 h.child.emit('message',{kind:'snapshot',snapshot} satisfies WorkerToMain);
 const cancelled=h.dispatch({type:'goals.cancel',goalId});assert.equal(options.allowExecution?.(context),false);
 h.reply(request(h,'cancel').id,undefined);h.reply(request(h,'goal.cancelPlan').id,undefined);await cancelled;
});

test('pending owned-page preparation blocks transitions and cancellation prevents late startup',async()=>{
 const h=harness();await h.start();let release!:()=>void;
 h.holdObservation(new Promise<void>(resolve=>{release=resolve;}));
 const accepted=await h.dispatch({type:'goals.start',prompt:'Research'}),root=accepted.goalTasks![0];
 h.reply(request(h,'goal.plan').id,plan);await tick();assert.equal(h.created.length,1);assert.equal(h.observed.length,1);
 assert.ok((await h.dispatch({type:'profile.create',name:'Other'})).error);assert.ok((await h.dispatch({type:'provider.check'})).error);
 h.app.emit('before-quit',{preventDefault(){}});assert.equal(h.quitPreparations(),0);
 const cancelling=h.dispatch({type:'goals.cancel',goalId:root.id});h.reply(request(h,'goal.cancelPlan').id,undefined);await cancelling;
 release();await tick();assert.equal(h.sent.some(raw=>raw.kind==='command'&&raw.command.type==='start'),false);
 assert.equal(h.get().goalTasks![0].status,'cancelled');assert.equal(h.state.activeTabId,'a');
});

test('quit cannot slip between root acceptance and background launch registration',async()=>{
 const h=harness();await h.start();const accepted=h.dispatch({type:'goals.start',prompt:'Research'});
 h.app.emit('before-quit',{preventDefault(){}});await accepted;await tick();
 assert.equal(h.quitPreparations(),0);assert.equal(h.get().bridgeReady,true);
 h.reply(request(h,'goal.plan').id,null,false);await tick();
});
test('planning cancellation is acknowledged for only the exact current-profile root',async()=>{
 const h=harness();await h.start();const accepted=await h.dispatch({type:'goals.start',prompt:'Research'}),root=accepted.goalTasks![0];
 h.state.activeProfileId='other';assert.ok((await h.dispatch({type:'goals.cancel',goalId:root.id})).error);assert.deepEqual(h.get().goalTasks,[]);
 h.state.activeProfileId='p';assert.ok((await h.dispatch({type:'goals.cancel',goalId:'unknown-root'})).error);
 const cancelled=h.dispatch({type:'goals.cancel',goalId:root.id});const cancelPlan=request(h,'goal.cancelPlan');
 assert.ok(cancelPlan.command.type==='goal.cancelPlan');assert.equal(cancelPlan.command.goalId,root.id);assert.equal(h.get().goalTasks![0].status,'cancelling');
 h.reply(cancelPlan.id,undefined);await cancelled;assert.equal(h.get().goalTasks![0].status,'cancelled');
 h.reply(request(h,'goal.plan').id,plan);await tick();assert.equal(h.created.length,0);
});
