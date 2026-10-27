import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { constants } from 'node:fs';
import { access, mkdir, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, delimiter, isAbsolute, join, sep } from 'node:path';
import { homedir, freemem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AppState, BridgeCommand, CoreSnapshot, MainToWorker, ProviderStatus, ResourceSample, WorkerToMain, ProviderActivity, CodexDesktopStatus, CodexDesktopHandoff, BrowserState, BrowserContext, PagePreview } from '../contract';
import { DEFAULT_SETTINGS } from '../contract';
import { BrowserController } from './browser';
import { DownloadManager } from './downloads';
import { PageAuthority } from './page-authority';
import {routeTaskPage,takeTaskPageControl} from './task-page-router';
import { browserCloseImpact } from './browser-close-impact';
import { assertTrustedSource, assertSurfaceCommand, parseCommand } from './security';
import { AgentWorkspaces, projectWorkspace } from './agent-workspaces';
import { GoalWorkspaces } from './goal-workspaces';
import { assertAgentPage } from './agent-scope';
import { OperationQueue } from './operation-queue';
import { cliPath } from './environment';
import { createResourceSample } from './resources';
import { invalidateProviderVerification } from './provider-state';
import { plannerCapacity, capacityFromVmStat } from './capacity';
import { taskContext, assertExecutingJob, visibleBatchInputs, cancelOwnedExecution, startSectionJobs } from './tasks';
import { assertDesktopConsent, buildDesktopDeepLink, inspectCodexDesktop, launchDesktopDraft, SIDEWORK_DESKTOP_BUNDLE } from './codex-desktop';
const execute = promisify(execFile);
const customData=process.env.SIDEWORK_DATA_DIR;
if(customData&&!isAbsolute(customData))throw new Error('SIDEWORK_DATA_DIR must be absolute');
const dataRoot=customData??join(app.getPath('appData'),'Sidework Codex');
app.setPath('userData',dataRoot);app.setName('Sidework Codex');
const qaMode=process.env.SIDEWORK_QA==='1'&&process.argv.includes('--sidework-qa');
const ownsAppLock=qaMode||app.requestSingleInstanceLock();
const devUrl=!app.isPackaged&&process.env.SIDEWORK_DEV_URL==='http://127.0.0.1:5187/'?process.env.SIDEWORK_DEV_URL:null;
const trustedUrl=devUrl??pathToFileURL(join(__dirname,'../dist-renderer/index.html')).href;
process.env.PATH=cliPath(homedir(),process.env.PATH);
let window:BrowserWindow|null=null;
let agentWindow:BrowserWindow|null=null;
let agentWindowOpening:Promise<BrowserWindow>|null=null;
let profileChanging=false;
let browser:BrowserController|null=null;
let downloads:DownloadManager|null=null;
let worker:UtilityProcess|null=null;
let quitting=false;
let browserReady=false;
let bridgeReady=false;
let agentConnecting=false;
let agentStopping=false;
let errorMessage:string|null=null;
let providerStatus:ProviderStatus={installed:false,authenticated:false,liveVerified:false,detail:'AI 패널을 열면 연결을 확인합니다. 일반 탐색에는 AI 연결이 필요하지 않습니다.'};
let codexPath:string|null=null;
let publishTimer:ReturnType<typeof setTimeout>|null=null;
let agentConnection:Promise<void>|null=null;
let exitTask:Promise<void>|null=null;
let diagnostics:ResourceSample|undefined;
let codexDesktop:CodexDesktopStatus={installed:false,targetReady:false,detail:'공식 앱 설치 확인 중입니다.'};
let codexDesktopHandoff:CodexDesktopHandoff|undefined;
let desktopHandoffBusy=false;
const targetAppPath=dirname(dirname(dirname(process.execPath)));
const checkpoints:{browser:number|null;agent:number|null}={browser:null,agent:null};
let core:CoreSnapshot={settings:{...DEFAULT_SETTINGS},jobs:[],activeJobId:null,memory:[]};
// Local UI thumbnails only: never persisted, attached to jobs, or sent to a worker.
let pagePreviews:PagePreview[]=[];
const previewRequests=new Set<string>();
function currentPagePreviews(state:BrowserState):PagePreview[]{
 const visible=state.paneTabIds??(state.activeTabId?[state.activeTabId]:[]);
 pagePreviews=pagePreviews.filter(preview=>preview.profileId===state.activeProfileId&&visible.includes(preview.tabId)&&state.tabs.some(tab=>tab.id===preview.tabId&&tab.profileId===preview.profileId&&tab.lifecycle==='live'&&tab.revision===preview.revision)).slice(-8);
 return pagePreviews.map(preview=>({...preview}));
}
async function requestPagePreview(controller:BrowserController,context:BrowserContext):Promise<void>{
 const before=controller.getState(),visible=before.paneTabIds??(before.activeTabId?[before.activeTabId]:[]);
 currentPagePreviews(before);
 const tab=before.tabs.find(tab=>tab.id===context.tabId&&tab.profileId===context.profileId&&tab.lifecycle==='live');
 const key=`${context.profileId}:${context.tabId}`;
 if(quitting||!tab||before.activeProfileId!==context.profileId||!visible.includes(context.tabId)||previewRequests.has(key)||previewRequests.size>=8)return;
 previewRequests.add(key);
 try{
  const result=await controller.captureUserPreview({profileId:context.profileId,tabId:context.tabId});
  const after=controller.getState();currentPagePreviews(after);
  if(quitting||after.activeProfileId!==before.activeProfileId||result.profileId!==context.profileId||result.tabId!==context.tabId||result.revision!==tab.revision||!(after.paneTabIds??[after.activeTabId]).includes(context.tabId)||!after.tabs.some(current=>current.id===tab.id&&current.profileId===tab.profileId&&current.revision===tab.revision&&current.lifecycle==='live'))return;
  pagePreviews=pagePreviews.filter(preview=>preview.profileId!==context.profileId||preview.tabId!==context.tabId);
  pagePreviews.push({profileId:context.profileId,tabId:context.tabId,revision:tab.revision,imageDataUrl:result.imageDataUrl,...result.error?{error:'미리보기를 사용할 수 없습니다.'}:{}});
  pagePreviews=pagePreviews.slice(-8);publish();
 }catch{/* Capture errors must never leak URLs, paths or native exception messages. */}
 finally{previewRequests.delete(key);}
}
const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const startingPages=new Set<string>();
const pageAuthority=new PageAuthority();
const browserQueue=new OperationQueue();
const tabQueues=new Map<string,OperationQueue>();
let capacity=plannerCapacity(freemem());
let providerActivity:ProviderActivity={running:0,waiting:0,limit:capacity.limit,reason:capacity.reason};
function activeJobs():string[]{return core.activeJobIds??(core.activeJobId?[core.activeJobId]:[]);}
async function findCodex():Promise<string|null>{
 const explicit=process.env.SIDEWORK_CODEX_PATH;
 const candidates=explicit?[explicit]:[join(homedir(),'.local','bin','codex'),...cliPath(homedir(),process.env.PATH).split(delimiter).map(path=>join(path,'codex'))];
 for(const candidate of candidates){if(!isAbsolute(candidate))continue;try{await access(candidate,constants.X_OK);return candidate;}catch{continue;}}
 return null;
}
async function checkProvider():Promise<void>{
 codexPath=await findCodex();
 if(!codexPath){providerStatus={installed:false,authenticated:false,liveVerified:false,detail:'Codex CLI가 없습니다. 설치 후 다시 확인할 수 있습니다.'};return;}
 try{
  process.env.PATH=[dirname(codexPath),cliPath(homedir(),process.env.PATH)].join(delimiter);
  const {stdout,stderr}=await execute(codexPath,['login','status'],{timeout:10000,maxBuffer:64000,env:{...process.env}});
  const authenticated=/logged in/i.test(`${stdout}\n${stderr}`);
  providerStatus={installed:true,authenticated,liveVerified:false,detail:authenticated?'로그인 확인됨. 이 연결의 실제 모델 실행은 아직 확인하지 않았습니다.':'Codex CLI 로그인이 필요합니다.'};
 }catch{providerStatus={installed:true,authenticated:false,liveVerified:false,detail:'CLI 로그인 상태를 확인하지 못했습니다. 일반 브라우징은 계속 사용할 수 있습니다.'};}
}
async function refreshCodexDesktop():Promise<void>{
 let targetReady=false;
 if(app.isPackaged&&targetAppPath.endsWith('/Sidework Codex.app'))try{
  const {stdout}=await execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(targetAppPath,'Contents/Info.plist')],{timeout:5000,maxBuffer:8192});targetReady=stdout.trim()===SIDEWORK_DESKTOP_BUNDLE;
 }catch{targetReady=false;}
 codexDesktop=await inspectCodexDesktop(targetReady);
}
function snapshot(surface:'browser'|'agent'='browser'):AppState{
 const all=browser?.getState()??{profiles:[],activeProfileId:'',tabs:[],activeTabId:null,closedTabCount:0};
 const state=surface==='agent'&&browser?browser.getAgentState():projectWorkspace(all,'browser');
 const visible=new Set(state.tabs.map(tab=>tab.id));
 return {...state,surface,goalTasks:goalWorkspaces.getState(state.activeProfileId),agentTabs:all.tabs.filter(tab=>!!tab.agentAreaId),...structuredClone(core),pagePreviews:currentPagePreviews(projectWorkspace(all,'browser')),...surface==='agent'?{pagePreviews:[]}:{},controlVisuals:(browser?.getControlVisuals()??[]).filter(item=>visible.has(item.tabId)),pageControls:(browser?pageAuthority.getState(all):[]).filter(item=>visible.has(item.tabId)),downloads:downloads?.getState(state.activeProfileId)??[],providerStatus:{...providerStatus},providerActivity:{...providerActivity},codexDesktop:{...codexDesktop},...(codexDesktopHandoff?{codexDesktopHandoff:{...codexDesktopHandoff}}:{}),browserReady,bridgeReady,agentConnecting,...diagnostics?{diagnostics}: {},error:errorMessage,appVersion:app.getVersion()};
}
function publish():void{
 if(publishTimer||quitting)return;
 publishTimer=setTimeout(()=>{publishTimer=null;if(window&&!window.isDestroyed())window.webContents.send('sidework:state',snapshot('browser'));if(agentWindow&&!agentWindow.isDestroyed())agentWindow.webContents.send('sidework:state',snapshot('agent'));},20);
}
function failPending(message:string):void{
 for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error(message));}pending.clear();
}
async function stopWorker():Promise<void>{
 const child=worker;if(!child)return;
 agentStopping=true;
 try{
  await new Promise<void>(resolve=>{
   const timer=setTimeout(()=>{if(worker===child)child.kill();resolve();},10000);
   child.once('exit',()=>{clearTimeout(timer);resolve();});
   child.postMessage({kind:'shutdown'} satisfies MainToWorker);
  });
 }finally{if(worker===child)worker=null;bridgeReady=false;agentStopping=false;}
}
async function startWorker():Promise<void>{
 capacity=plannerCapacity(freemem());providerActivity={running:0,waiting:0,limit:capacity.limit,reason:capacity.reason};
 if(process.platform==='darwin'){try{const {stdout}=await execute('/usr/bin/vm_stat',[],{timeout:1000,maxBuffer:8192});capacity=capacityFromVmStat(stdout)??capacity;}catch{/* Keep conservative OS-free fallback. */}}
 providerActivity={running:0,waiting:0,limit:capacity.limit,reason:capacity.reason};
 return new Promise((resolve,reject)=>{
  const child=utilityProcess.fork(join(__dirname,'worker.cjs'),[],{serviceName:'Sidework Agent',stdio:'pipe',env:{...process.env}});
  child.stdout?.resume();child.stderr?.resume();
  worker=child;let readySettled=false;
  const timer=setTimeout(()=>{if(!readySettled){readySettled=true;reject(new Error('AI worker 준비 시간이 초과되었습니다. 일반 탐색은 계속 사용할 수 있습니다.'));}},10000);
  child.on('spawn',()=>{if(worker===child)child.postMessage({kind:'init',dataRoot,codexPath,maxPlannerProcesses:capacity.limit} satisfies MainToWorker);});
  child.on('message',(raw:WorkerToMain)=>{
   if(worker!==child)return;
   switch(raw.kind){
    case 'ready':bridgeReady=true;checkpoints.agent=Math.round(process.uptime()*1000);if(!readySettled){readySettled=true;clearTimeout(timer);resolve();}publish();break;
    case 'snapshot':providerStatus=invalidateProviderVerification(providerStatus,core,raw.snapshot);core=raw.snapshot;goalWorkspaces.reconcile(core.jobs);browser?.updateControlJobs(core.jobs);publish();break;
    case 'provider.verified':providerStatus={...providerStatus,liveVerified:true,detail:'현재 연결에서 실제 모델 응답을 검증했습니다. 페이지 내용은 모델 공급자에 전달됩니다.'};publish();break;
    case 'provider.activity':providerActivity={...raw.activity,reason:capacity.reason};publish();break;
    case 'response':{
     if(raw.id==='init'&&!raw.ok&&!readySettled){readySettled=true;clearTimeout(timer);reject(new Error(raw.error??'AI 저장소 초기화 실패'));return;}
     const request=pending.get(raw.id);if(!request)return;
     clearTimeout(request.timer);pending.delete(raw.id);
     if(raw.ok)request.resolve(raw.value);else request.reject(new Error(raw.error??'작업 실패'));break;
    }
    case 'browser.request':{
     const request=raw;
     const key=`${request.context.profileId}:${request.context.tabId}`;let queue=tabQueues.get(key);if(!queue){queue=new OperationQueue();tabQueues.set(key,queue);}
     void queue.run(async()=>{
      if(worker!==child||quitting)throw new Error('종료되거나 교체된 작업 요청입니다.');
      const controller=browser;if(!controller)throw new Error('브라우저가 준비되지 않았습니다.');
      const routed=routeTaskPage({authority:pageAuthority,browser:controller,readJobs:()=>core.jobs,readState:()=>controller.getState(),readPermissionMode:()=>core.settings.permissionMode,assertGoal:job=>goalWorkspaces.assertJob(job)},request);publish();return routed;
     }).then(value=>{if(worker===child)child.postMessage({kind:'browser.response',id:request.id,ok:true,value} satisfies MainToWorker);},error=>{if(worker===child)child.postMessage({kind:'browser.response',id:request.id,ok:false,error:message(error)} satisfies MainToWorker);});break;
    }
   }
  });
  child.on('exit',()=>{
   clearTimeout(timer);
   if(!readySettled){readySettled=true;reject(new Error('AI worker가 준비 전에 종료되었습니다.'));}
   if(worker!==child)return;
   worker=null;bridgeReady=false;goalWorkspaces.interrupt();void browser?.cancelControlVisuals().catch(()=>{});providerActivity={...providerActivity,running:0,waiting:0};providerStatus={...providerStatus,liveVerified:false,detail:'AI 프로세스 연결이 종료되었습니다. 과거 성공은 현재 연결 정상의 증거가 아닙니다.'};failPending('AI 프로세스가 종료되었습니다. 실행 결과를 다시 확인하세요.');
   if(!quitting&&!agentStopping&&!agentConnecting){errorMessage='AI 프로세스 연결이 끊겼습니다. 일반 브라우징은 계속 사용할 수 있습니다.';publish();}
  });
 });
}
async function connectAgent(force=false):Promise<void>{
 if(agentConnection)return agentConnection;
 if(bridgeReady&&!force)return;
 if(force&&(activeJobs().length||goalWorkspaces.pendingCount||goalWorkspaces.activeCount))throw new Error('목표 계획·페이지 준비와 진행 중인 AI 작업을 종료한 뒤 연결을 다시 확인하세요.');
 agentConnecting=true;providerStatus={installed:false,authenticated:false,liveVerified:false,detail:'AI 연결을 확인하고 있습니다.'};errorMessage=null;publish();
 agentConnection=(async()=>{
  try{if(worker)await stopWorker();await checkProvider();if(quitting)return;await startWorker();}
  catch(error){await stopWorker();throw error;}
  finally{agentConnecting=false;agentConnection=null;publish();}
 })();
 return agentConnection;
}
function command(command:BridgeCommand):Promise<unknown>{
 const stamped:BridgeCommand=command.type==='start'?{...command,input:pageAuthority.bindInput(command.input)}:command.type==='startTogether'||command.type==='startBatch'?{...command,inputs:command.inputs.map(input=>pageAuthority.bindInput(input))}:command;
 const child=worker;if(!child||!bridgeReady)return Promise.reject(new Error('AI 패널에서 먼저 연결을 준비하세요. 일반 브라우징은 별도로 사용할 수 있습니다.'));
 const inputs=stamped.type==='start'?[stamped.input]:stamped.type==='startBatch'||stamped.type==='startTogether'?stamped.inputs:[];
 const keys=inputs.map(input=>`${input.profileId}:${input.tabId}`);
 if(keys.some(key=>startingPages.has(key)))return Promise.reject(new Error('이 페이지의 작업 시작 응답을 기다리고 있습니다.'));
 keys.forEach(key=>startingPages.add(key));
 const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('작업 응답 시간이 초과되었습니다.'));},stamped.type==='goal.plan'?210000:15000);pending.set(id,{resolve,reject,timer});child.postMessage({kind:'command',id,command:stamped} satisfies MainToWorker);}).finally(()=>{keys.forEach(key=>startingPages.delete(key));});
}
function allDownloads(){return browser?.getState().profiles.flatMap(profile=>downloads?.getState(profile.id)??[])??[];}
async function confirmWorkClose(impact:ReturnType<typeof browserCloseImpact>,reason:'tab'|'quit'):Promise<boolean>{
 if(!impact.jobIds.length&&!impact.downloadIds.length)return true;
 const host=window;if(!host||host.isDestroyed())return false;
 const answer=await dialog.showMessageBox(host,{type:'warning',title:reason==='tab'?'AI 작업 중인 탭 닫기':'진행 중인 작업 중지',message:reason==='tab'?'AI 작업을 중지하고 이 탭을 닫을까요?':'진행 중인 작업을 중지하고 브라우저를 종료할까요?',detail:`AI 작업 ${impact.jobIds.length}개 · 다운로드 ${impact.downloadIds.length}개. 중지한 작업은 자동 재실행하지 않습니다.`,buttons:['계속 사용',reason==='tab'?'작업 중지 후 닫기':'작업 중지 후 종료'],defaultId:0,cancelId:0,noLink:true});
 return answer.response===1&&window===host&&!host.isDestroyed();
}
async function cancelTabJobs(jobIds:string[]):Promise<void>{
 for(const id of jobIds)await cancelOwnedExecution(()=>worker&&bridgeReady?command({type:'cancel',jobId:id}):Promise.resolve(),()=>browser?.cancelScroll(id)??Promise.resolve(),()=>browser?.cancelControlVisuals(id)??Promise.resolve());
}
function message(error:unknown):string{return error instanceof Error?error.message:'알 수 없는 오류';}
function trusted(event:IpcMainInvokeEvent):'browser'|'agent'{
 const host=window&&!window.isDestroyed()&&event.sender===window.webContents?window:agentWindow&&!agentWindow.isDestroyed()&&event.sender===agentWindow.webContents?agentWindow:null;
 if(!host)throw new Error('허용되지 않은 송신자');
 assertTrustedSource(event.senderFrame?.url??'',trustedUrl,event.senderFrame===host.webContents.mainFrame);
 return host===agentWindow?'agent':'browser';
}
ipcMain.handle('sidework:get-state',(event)=>snapshot(trusted(event)));
ipcMain.handle('sidework:dispatch',async(event,raw:unknown)=>{
 const surface=trusted(event);
 try{
  const input=parseCommand(raw);assertSurfaceCommand(surface,input);const controller=browser;if(!controller||!browserReady)throw new Error('브라우저가 준비되지 않았습니다.');
  if(exitTask&&!['job.cancel','jobs.cancelAll','downloads.cancel','tab.takeControl'].includes(input.type))throw new Error('종료 확인 중에는 새 작업을 시작할 수 없습니다.');
  switch(input.type){
   case 'agents.show':{const host=await ensureAgentWindow();if(host.isMinimized())host.restore();host.show();host.focus();break;}
   case 'goals.start':await goalWorkspaces.start(input.prompt);break;
   case 'goals.cancel':await goalWorkspaces.cancel(input.goalId);break;
   case 'agents.start':await agentWorkspaces.start(input);break;
   case 'agents.startSections':await agentWorkspaces.startSections(input);break;
   case 'tab.preview':await requestPagePreview(controller,input);break;
   case 'codexDesktop.check':await refreshCodexDesktop();break;
   case 'codexDesktop.handoff':{
    if(desktopHandoffBusy)throw new Error('이미 Codex 요청 화면을 여는 중입니다.');
    desktopHandoffBusy=true;
    try{
     const before=controller.getState(),target=assertDesktopConsent(before,input),scope=JSON.stringify(before.paneTabIds??[before.activeTabId]);
     await refreshCodexDesktop();
     if(!codexDesktop.installed||!codexDesktop.targetReady)throw new Error(codexDesktop.detail);
     const workspacePath=join(dataRoot,'codex-desktop-workspace');await mkdir(workspacePath,{recursive:true,mode:0o700});
     const info=await lstat(workspacePath);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('공식 Codex 작업 폴더를 확인하지 못했습니다.');
     const current=controller.getState();assertDesktopConsent(current,input);
     if(quitting||JSON.stringify(current.paneTabIds??[current.activeTabId])!==scope)throw new Error('대상 화면 구성이 변경되었습니다. 다시 동의하세요.');
     const requestId=randomUUID(),link=buildDesktopDeepLink({...target,prompt:input.prompt,targetAppPath,workspacePath,requestId});
     await launchDesktopDraft(link);
     codexDesktopHandoff={requestId,status:'requested',requestedAt:new Date().toISOString(),paneIndex:target.paneIndex};
    }finally{desktopHandoffBusy=false;}
    break;
   }
   case 'tab.takeControl':{
    await takeTaskPageControl({authority:pageAuthority,readJobs:()=>core.jobs,readState:()=>controller.getState(),invalidate:context=>controller.invalidatePageContext(context),cancelJob:id=>cancelOwnedExecution(()=>worker&&bridgeReady?command({type:'cancel',jobId:id}):Promise.resolve(),()=>controller.cancelScroll(id),()=>controller.cancelControlVisuals(id)),publish},input);
    if(controller.getState().tabs.some(tab=>tab.id===input.tabId&&tab.profileId===input.profileId&&tab.agentAreaId))await controller.returnFromAgent(input);
    break;
   }
   case 'tab.new':await browserQueue.run(()=>controller.newTab(input.url));break;
   case 'tab.activate':await browserQueue.run(async()=>{await controller.activateTab(input.tabId);});break;
   case 'tab.close':await browserQueue.run(async()=>{
    const tab=controller.getState().tabs.find(tab=>tab.id===input.tabId);if(!tab)throw new Error('닫을 탭을 찾지 못했습니다.');
    const impact=browserCloseImpact(core.jobs,allDownloads(),{profileId:tab.profileId,tabId:tab.id});
    if(!await confirmWorkClose(impact,'tab'))return;
    await cancelTabJobs(impact.jobIds);await controller.closeTab(input.tabId);
   });break;
   case 'tab.restore':await browserQueue.run(()=>controller.restoreClosedTab());break;
   case 'tab.navigate':await browserQueue.run(()=>controller.navigate(input.url,input.tabId));break;
   case 'workspace.split':if(activeJobs().length)throw new Error('실행 중인 작업을 중지한 뒤 화면 분할을 변경하세요.');await browserQueue.run(()=>controller.setSplitCount(input.count));break;
   case 'tab.back':await browserQueue.run(()=>controller.back());break;
   case 'tab.forward':await browserQueue.run(()=>controller.forward());break;
   case 'tab.reload':await browserQueue.run(()=>controller.reload());break;
   case 'profile.create':await changeUserProfile(()=>controller.createProfile(input.name,!!input.incognito));break;
   case 'profile.activate':await changeUserProfile(async()=>{if(activeJobs().length)throw new Error('실행 중인 작업을 중지한 뒤 프로필을 전환하세요.');await controller.activateProfile(input.profileId);});break;
   case 'layout.set':if(surface==='agent')controller.setAgentLayout(input);else controller.setLayout(input);break;
   case 'agent.connect':await connectAgent();break;
   case 'provider.check':await connectAgent(true);break;
   case 'diagnostics.refresh':diagnostics=createResourceSample(app.getAppMetrics(),controller.getState().tabs,checkpoints);break;
   case 'job.start':{
    if(!providerStatus.authenticated)throw new Error('AI 패널에서 Codex CLI 연결을 먼저 확인하세요.');
    const context=taskContext(controller.getState(),input.tabId,!!input.computerUse,!!input.shareScreen);
    if(agentWorkspaces.isPending(context))throw new Error('이 페이지는 에이전트 영역으로 전달 중입니다. 중복 작업을 시작하지 않습니다.');
    await command({type:'start',input:{prompt:input.prompt,...context,...input.computerUse===undefined?{}:{computerUse:input.computerUse},...input.shareScreen===undefined?{}:{shareScreen:input.shareScreen}}});break;
   }
   case 'jobs.startSections':{
    if(!providerStatus.authenticated||!bridgeReady)throw new Error('화면별 AI에서 Codex 연결을 먼저 확인하세요.');
    if(input.tasks.some(task=>agentWorkspaces.isPending({profileId:controller.getState().activeProfileId,tabId:task.tabId})))throw new Error('선택한 페이지는 에이전트 영역으로 전달 중입니다.');
    await startSectionJobs(controller.getState(),core.jobs,input,command);break;
   }
   case 'jobs.startVisible':{
    if(!providerStatus.authenticated)throw new Error('AI 패널에서 Codex CLI 연결을 먼저 확인하세요.');
    const inputs=visibleBatchInputs(controller.getState(),core.jobs,input);
    if(inputs.some(task=>agentWorkspaces.isPending(task)))throw new Error('선택한 페이지는 에이전트 영역으로 전달 중입니다.');
    if(input.synchronizedScroll)await command({type:'startTogether',inputs});
    else await Promise.all(inputs.map(task=>command({type:'start',input:task})));
    break;
   }
   case 'jobs.cancelAll':await cancelOwnedExecution(()=>command({type:'cancelAll'}),()=>controller.cancelScroll(),()=>controller.cancelControlVisuals());break;
   case 'job.cancel':await cancelOwnedExecution(()=>command({type:'cancel',jobId:input.jobId}),()=>controller.cancelScroll(input.jobId),()=>controller.cancelControlVisuals(input.jobId));break;
   case 'job.approve':await command({type:'approve',jobId:input.jobId,approvalId:input.approvalId,allow:input.allow});break;
   case 'settings.update':await command({type:'settings',patch:input.patch});break;
   case 'memory.add':await command(input);break;
   case 'memory.remove':await command(input);break;
   case 'downloads.cancel':if(!downloads)throw new Error('다운로드가 준비되지 않았습니다.');downloads.cancel(input.downloadId,controller.getState().activeProfileId);break;
   case 'downloads.reveal':if(!downloads)throw new Error('다운로드가 준비되지 않았습니다.');await downloads.reveal(input.downloadId,controller.getState().activeProfileId);break;
   case 'artifact.open':{
    const artifact=core.jobs.find(job=>job.id===input.jobId)?.artifacts.find(item=>item.id===input.artifactId);if(!artifact)throw new Error('결과 파일을 찾지 못했습니다.');
    const expected=await realpath(join(dataRoot,'jobs',input.jobId,'artifacts'));const actual=await realpath(artifact.path);if(!actual.startsWith(expected+sep))throw new Error('허용된 결과 경로가 아닙니다.');if(await shell.openPath(actual))throw new Error('결과 파일을 열지 못했습니다.');break;
   }
   default:{const unsupported:never=input;throw new Error(`지원하지 않는 요청: ${String(unsupported)}`);}
  }
  errorMessage=null;publish();return snapshot(surface);
 }catch(error){errorMessage=message(error);publish();return snapshot(surface);}
});
const agentWorkspaces=new AgentWorkspaces({
 readState:()=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.getState();},
 readJobs:()=>core.jobs,ready:()=>!quitting&&!exitTask&&!profileChanging&&providerStatus.authenticated&&bridgeReady&&worker!==null,
 starting:context=>startingPages.has(`${context.profileId}:${context.tabId}`),
 agentSlots:()=>browser?.getAgentState().splitCount??2,
 ensureHost:ensureAgentWindow,
 observe:context=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.observe(context);},
 settle:async context=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');const capture=await browser.captureUserPreview(context);if(capture.error||!capture.imageDataUrl)throw new Error('전달한 페이지의 화면이 안정되지 않았습니다. 페이지를 직접 제어로 돌려받아 다시 시작하세요.');},
 handoff:(context,host)=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.handoffToAgent(context,host);},
 returnPage:context=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.returnFromAgent(context);},
 send:input=>command({type:'start',input})
});
// Root history is intentionally volatile in this slice; no persistence port is installed.
const goalWorkspaces=new GoalWorkspaces({
 readState:()=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.getState();},
 readJobs:()=>core.jobs,ready:()=>!quitting&&!exitTask&&!profileChanging&&!agentConnecting&&!agentStopping&&providerStatus.authenticated&&bridgeReady&&worker!==null,
 agentSlots:()=>browser?.getAgentState().splitCount??2,
 ensureHost:ensureAgentWindow,
 plan:(goalId,prompt)=>command({type:'goal.plan',goalId,prompt}),
 cancelPlan:async goalId=>{await command({type:'goal.cancelPlan',goalId});},
 createPage:input=>{if(!browser||input.host!==agentWindow||input.host.isDestroyed())throw new Error('에이전트 창이 준비되지 않았습니다.');return browser.createGoalPage(input);},
 settle:async context=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');await browser.settleGoalPage(context);},
 observe:context=>{if(!browser)throw new Error('브라우저가 준비되지 않았습니다.');return browser.observe(context);},
 send:input=>command({type:'start',input}),
 cancelJob:id=>cancelOwnedExecution(()=>command({type:'cancel',jobId:id}),()=>browser?.cancelScroll(id)??Promise.resolve(),()=>browser?.cancelControlVisuals(id)??Promise.resolve()),
 onChange:publish
});
async function changeUserProfile(operation:()=>Promise<unknown>):Promise<void>{
 await browserQueue.run(async()=>{
  if(goalWorkspaces.pendingCount||goalWorkspaces.activeCount||agentWorkspaces.pendingCount||browser?.getState().tabs.some(tab=>tab.agentAreaId))throw new Error('목표 계획·페이지 준비를 중지하고 에이전트 페이지를 모두 직접 제어로 돌려받은 뒤 프로필을 변경하세요.');
  profileChanging=true;try{await operation();}finally{profileChanging=false;}
 });
}
async function ensureAgentWindow():Promise<BrowserWindow>{
 if(agentWindowOpening)return agentWindowOpening;
 if(agentWindow&&!agentWindow.isDestroyed()){agentWindow.showInactive();return agentWindow;}
 const host=new BrowserWindow({width:1380,height:900,minWidth:1000,minHeight:680,title:'Sidework · 에이전트 작업',backgroundColor:'#f6f7f9',show:false,titleBarStyle:'hiddenInset',trafficLightPosition:{x:17,y:15},webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 agentWindow=host;
 host.webContents.on('will-navigate',(event,url)=>{if(url!==trustedUrl)event.preventDefault();});
 host.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 host.on('resize',publish);
 // Retain the visible host (including completed pages) rather than destroy forms
 // or hide a running task. Direct takeover returns each same native page.
 host.on('close',event=>{if(quitting)return;event.preventDefault();if(agentWorkspaces.pendingCount||browser?.getState().tabs.some(tab=>tab.agentAreaId)){host.show();errorMessage='에이전트 페이지를 직접 제어로 돌려받은 뒤 창을 닫으세요. 작성 중인 페이지와 작업을 보존했습니다.';publish();}else host.hide();});
 host.on('closed',()=>{if(agentWindow===host)agentWindow=null;});
 agentWindowOpening=host.loadURL(trustedUrl).then(()=>{if(host.isDestroyed())throw new Error('에이전트 창이 닫혔습니다.');host.showInactive();publish();return host;}).catch(error=>{if(!host.isDestroyed())host.destroy();if(agentWindow===host)agentWindow=null;errorMessage=message(error);publish();throw error;}).finally(()=>{agentWindowOpening=null;});
 return agentWindowOpening;
}
async function createWindow():Promise<void>{
 await mkdir(dataRoot,{recursive:true,mode:0o700});nativeTheme.themeSource='light';
 window=new BrowserWindow({width:1440,height:930,minWidth:1000,minHeight:680,title:'Sidework Codex',backgroundColor:'#f6f7f9',show:false,titleBarStyle:'hiddenInset',trafficLightPosition:{x:17,y:15},webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 window.once('ready-to-show',()=>window?.show());
 window.webContents.on('will-navigate',(event,url)=>{if(url!==trustedUrl)event.preventDefault();});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 window.webContents.session.setPermissionCheckHandler(()=>false);
 window.on('resize',publish);
 window.on('close',event=>{if(!quitting){event.preventDefault();app.quit();}});
 window.on('closed',()=>{window=null;});
 let qaSavePath:((filename:string)=>string)|undefined;
 if(qaMode&&customData&&process.env.SIDEWORK_QA_DOWNLOADS==='1'){
  const directory=join(dataRoot,'qa-downloads');await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory),rootPath=await realpath(dataRoot),directoryPath=await realpath(directory);
  if(info.isSymbolicLink()||!info.isDirectory()||!directoryPath.startsWith(rootPath+sep))throw new Error('검증 다운로드 경로를 확인하지 못했습니다.');
  qaSavePath=name=>{if(!name||name!==basename(name)||name.includes('\\'))throw new Error('잘못된 검증 파일 이름입니다.');return join(directory,name);};
 }
 downloads=new DownloadManager({downloadsDirectory:app.getPath('downloads'),onChange:publish,revealFile:path=>shell.showItemInFolder(path),...(qaSavePath?{qaSavePath}: {})});
 browser=new BrowserController({window,dataRoot,onChange:publish,qaMode,handleDownload:(event,item,tab)=>{
  const controlled=!!tab.agentAreaId||core.jobs.some(job=>job.tabId===tab.id&&job.profileId===tab.profileId&&['queued','running','awaiting_approval'].includes(job.status));
  if(!downloads){event.preventDefault();item.cancel();return;}
  downloads.handle(event,item,{profileId:tab.profileId,tabId:tab.id,url:tab.url,allowed:!controlled,blockedReason:'AI 작업 중이거나 에이전트 영역에 남은 페이지는 파일을 저장하지 않습니다. 직접 제어로 돌려받은 뒤 다운로드하세요.'});
 },allowExecution:context=>{try{if(quitting)return false;assertExecutingJob(core.jobs,context,bridgeReady&&worker!==null);const job=core.jobs.find(job=>job.id===context.jobId);if(!job)return false;goalWorkspaces.assertJob(job);if(browser)assertAgentPage(core.jobs,browser.getState(),context,context.jobId);pageAuthority.assertRequest(core.jobs,context,context.jobId,'execute');return true;}catch{return false;}},confirmClose:(_tab,reason)=>{
  const host=window;if(!host||host.isDestroyed())return false;
  const result=dialog.showMessageBoxSync(host,{type:'warning',title:reason==='quit'?'Sidework 종료':'탭 닫기',message:reason==='quit'?'열린 웹페이지를 종료할까요?':'작성 중인 페이지를 닫을까요?',detail:'저장하지 않은 입력 내용은 사라질 수 있습니다. 탭 복구는 주소만 복원하며 입력 내용은 복원하지 않습니다.',buttons:['계속 사용',reason==='quit'?'종료':'닫기'],defaultId:0,cancelId:0,noLink:true});
  return result===1;
 }});
 await browser.initialize();browserReady=true;checkpoints.browser=Math.round(process.uptime()*1000);
 await window.loadURL(trustedUrl);publish();
 void refreshCodexDesktop().then(publish);
}
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.on('window-all-closed',()=>{if(!quitting)app.quit();});
app.on('before-quit',event=>{
 if(quitting)return;event.preventDefault();if(exitTask)return;
 if(goalWorkspaces.pendingCount||goalWorkspaces.getState().some(goal=>goal.status==='planning')){errorMessage='목표 계획·페이지 준비를 중지하고 응답을 확인한 뒤 종료하세요.';publish();return;}
 exitTask=(async()=>{
  const impact=browserCloseImpact(core.jobs,allDownloads());
  if(!await confirmWorkClose(impact,'quit'))return;
  if(impact.jobIds.length)await cancelOwnedExecution(()=>worker&&bridgeReady?command({type:'cancelAll'}):Promise.resolve(),()=>browser?.cancelScroll()??Promise.resolve(),()=>browser?.cancelControlVisuals()??Promise.resolve());
  const closingBrowser=browser;if(closingBrowser&&!await browserQueue.run(()=>closingBrowser.prepareToQuit()))return;
  quitting=true;browserReady=false;
  await cancelOwnedExecution(()=>activeJobs().length&&bridgeReady?command({type:'cancelAll'}):Promise.resolve(),()=>browser?.cancelScroll()??Promise.resolve(),()=>browser?.cancelControlVisuals()??Promise.resolve()).catch(()=>undefined);
  downloads?.dispose();downloads=null;
  await stopWorker();await browser?.dispose();browser=null;
  if(publishTimer){clearTimeout(publishTimer);publishTimer=null;}
  app.quit();
 })().catch(async error=>{
  quitting=false;browserReady=browser!==null&&browser.getState().tabs.length>0;errorMessage=message(error);publish();
  if(window&&!window.isDestroyed())await dialog.showMessageBox(window,{type:'error',title:'종료를 완료하지 못했습니다',message:'탭 세션 저장 또는 정리 중 문제가 발생했습니다.',detail:'앱 상태와 저장 공간·권한을 확인한 뒤 다시 시도하세요.',buttons:['확인'],defaultId:0,cancelId:0});
  if(!browserReady){quitting=true;app.quit();}
 }).finally(()=>{exitTask=null;});
});
if(ownsAppLock){app.whenReady().then(createWindow).catch(error=>{dialog.showErrorBox('Sidework 시작 실패',message(error));app.exit(1);});}else app.exit(0);
