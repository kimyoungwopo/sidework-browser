import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session, Event, DownloadItem, NativeImage, WebContents } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, BrowserState, BrowserTab, Profile, Observation, BrowserAction, ExecutionContext, BrowserActionResult, SplitCount, ScreenFrame, Job, PaneControlVisual, ControlPhase, PagePreview } from '../contract.ts';
import { isSafeNavigation, screenLinkAt } from '../computer-policy.ts';
import { paneLayout } from './pane-layout.ts';
import {AGENT_AREA_LAYOUT} from '../agent-area-layout';
import { isAllowedURL, normalizeNavigation, validateTarget, assertJobId, assertBrowserAction, navigationErrorMessage } from './browser-policy.ts';

import { observationScript, actionScript, cancelScrollScript, scrollSettlementScript } from './browser-dom.ts';
import { browserShortcut } from './keyboard';
import { controlVisualSetScript, controlVisualClearScript, controlVisualCaptureScript, controlVisualHitScript, controlVisualMotionScript } from './control-visuals.ts';
import type { DOMSnapshot, DOMObservationMode } from './browser-dom.ts';

interface TabEntry { state: BrowserTab; goalId?:string; observationFrame?:unknown; sessionPartition?:string; view?: WebContentsView; ready?: Promise<void>; stamp?: string; navigationSerial?: number; computer?:DOMSnapshot['computer']; geometry?:string; visible?:boolean; frameId?:string; debuggerOwned?:boolean;goalNavigating?:boolean;visualEpoch?:number }
interface Layout { sidebarWidth: number; top: number; left: number; bottom: number; hideBrowser: boolean }

// Task bootstrap only: safePageUrl credential rules plus local/private host rejection.
// Kept internal so the native controller does not acquire desktop-launch capabilities.
function safeGoalPageUrl(raw:string):boolean {
  try {
    if(typeof raw!=='string' || !raw || raw.length>4096 || [...raw].some(char=>char.charCodeAt(0)<=32 || char.charCodeAt(0)===127)) return false;
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key=>/token|secret|password|session|credential|^(?:code|state|key|api_key|otp)$/i.test(key)) || /(?:token|secret|password|session|credential|code|api_key)\s*=/i.test(decodeURIComponent(url.hash))) return false;
    const host=url.hostname.toLowerCase().replace(/\.$/,'');
    if(!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|localdomain)$/.test(host)) return false;
    // Reject IPv6 literals conservatively, including mapped/translated local IPv4.
    if(host.includes(':') || host.includes('[')) return false;
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a=0,b=0]=host.split('.').map(Number);
      if(a===0 || a===10 || a===127 || a===169&&b===254 || a===172&&b>=16&&b<=31 || a===192&&(b===168||b===0) || a===100&&b>=64&&b<=127 || a===198&&(b===18||b===19) || a>=224) return false;
    }
    return true;
  } catch {return false;}
}

export class BrowserController {
  private readonly window: BrowserWindow;
  private readonly dataRoot: string;
  private readonly onChange: () => void;
  private readonly allowExecution?:(context:ExecutionContext)=>boolean;
  private readonly confirmClose?: (tab: BrowserTab, reason: 'tab' | 'quit') => boolean;
  private profiles: Profile[] = [{ id: 'default', name: '기본', incognito: false }];
  private activeProfileId = 'default';
  private activeTabId: string | null = null;
  private splitCount: SplitCount = 1;
  private paneTabIds: string[] = [];
  private agentHost?: BrowserWindow;
  private agentPaneTabIds: string[] = [];
  private agentGridCount: SplitCount = 2;
  private readonly agentSlots = new Map<string,number>();
  private agentLayout: Layout = {...AGENT_AREA_LAYOUT};
  private readonly tabs = new Map<string, TabEntry>();
  private readonly closedTabs: { profileId: string; url: string }[] = [];
  private readonly selectedTabs = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly goalSessionScope = randomUUID();
  private readonly handleDownload?:(event:Event,item:DownloadItem,tab:BrowserTab)=>void;
  private readonly receiveDownload = (event:Event,item:DownloadItem,contents?:WebContents) => {
    const entry=contents?[...this.tabs.values()].find(entry=>entry.view?.webContents===contents&&!contents.isDestroyed()):undefined;
    if(!this.disposed&&entry&&this.handleDownload){try{this.handleDownload(event,item,structuredClone(entry.state));return;}catch{/* Fail closed if the host download handler cannot accept the item. */}}
    event.preventDefault();try{item.cancel();}catch{/* Native item may already be cancelled. */}
  };
  private layout: Layout = { sidebarWidth: 0, top: 88, left: 0, bottom: 0, hideBrowser: false };
  private readonly activeScrolls = new Map<string, {jobId:string;cancel:()=>Promise<void>}>();
  private disposed = false;
  private disposing = false;
  private preparingQuit = false;
  private quitPrepared = false;
  private readonly controlVisuals = new Map<string,PaneControlVisual>();
  private readonly cancelledVisualJobs = new Set<string>();
  private readonly knownControlJobs = new Set<string>();
  private readonly goalDomJobs = new Set<string>();
  private readonly goalSearchJobs = new Map<string,{profileId:string;tabId:string;areaId:string;goalId:string;expires:number;origins:string[];scope:string}>();
  private readonly activePointerJobs = new Set<string>();
  private initialized = false;
  private persistTail: Promise<void> = Promise.resolve();
  private persistSnapshot: string | undefined;
  private persistenceError: Error | null = null;
  private readonly resize = () => this.applyLayout();

  constructor(options: { window: BrowserWindow; dataRoot: string; onChange: () => void; qaMode?: boolean; handleDownload?:(event:Event,item:DownloadItem,tab:BrowserTab)=>void; allowExecution?:(context:ExecutionContext)=>boolean; confirmClose?: (tab: BrowserTab, reason: 'tab' | 'quit') => boolean }) {
    this.window = options.window;
    this.dataRoot = options.dataRoot;
    this.onChange = () => {
      if (!this.disposed&&!this.preparingQuit&&!this.disposing) void this.persistProfiles().catch(() => { /* Retained and surfaced by explicit persistence/dispose. */ });
      options.onChange();
    };
    this.handleDownload = options.handleDownload;
    this.confirmClose = options.confirmClose;
    this.allowExecution = options.allowExecution;
  }

  async initialize(): Promise<void> {
    this.assertLive();
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.dataRoot, 'browser-profiles.json'), 'utf8'));
      if (typeof raw === 'object' && raw !== null && 'profiles' in raw && Array.isArray(raw.profiles)) {
        const restored: Profile[] = [];
        for (const p of raw.profiles.slice(0, 40)) {
          if (typeof p !== 'object' || p === null || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(p.id) || typeof p.name !== 'string' || p.incognito !== false || restored.some(item => item.id === p.id)) continue;
          restored.push({ id: p.id, name: p.name.slice(0, 60), incognito: false });
        }
        if (!restored.some(p => p.id === 'default')) restored.unshift(this.profiles[0]!);
        this.profiles = restored;
        if ('activeProfileId' in raw && typeof raw.activeProfileId === 'string' && restored.some(p => p.id === raw.activeProfileId)) this.activeProfileId = raw.activeProfileId;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read browser profiles', { cause: error });
    }
    this.window.on('resize', this.resize);
    try {
      const sessionPath = join(this.dataRoot, 'browser-session.json');
      const info = await lstat(sessionPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe or oversized browser session file');
      const raw: unknown = JSON.parse(await readFile(sessionPath, 'utf8'));
      if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1 || !('tabs' in raw) || !Array.isArray(raw.tabs)) throw new Error('Invalid browser session');
      if ('closedTabs' in raw && !Array.isArray(raw.closedTabs)) throw new Error('Invalid closed-tab session metadata');
      if ('activeProfileId' in raw && (typeof raw.activeProfileId !== 'string' || !this.profiles.some(p => p.id === raw.activeProfileId && !p.incognito))) throw new Error('Unknown active session profile');
      if ('activeTabIndex' in raw && (typeof raw.activeTabIndex !== 'number' || !Number.isSafeInteger(raw.activeTabIndex) || raw.activeTabIndex < 0)) throw new Error('Invalid active session index');
      const record = (value: unknown): { profileId: string; url: string } => {
        if (typeof value !== 'object' || value === null || !('profileId' in value) || !('url' in value) || typeof value.profileId !== 'string' || typeof value.url !== 'string' || value.url.length > 4096 || !isAllowedURL(value.url) || !this.profiles.some(p => p.id === value.profileId && !p.incognito)) throw new Error('Unsafe or unknown-profile browser session record');
        return { profileId: value.profileId, url: value.url };
      };
      const records = raw.tabs.slice(0, 100).map(record);
      const closedRecords = 'closedTabs' in raw && Array.isArray(raw.closedTabs) ? raw.closedTabs.slice(-20).map(record) : [];
      for (const record of records) {
        const id = randomUUID();
        this.tabs.set(id, { state: { id, profileId: record.profileId, url: record.url, title: '복원된 탭 (URL만)', isLoading: false, canGoBack: false, canGoForward: false, ownership: 'user', revision: 0, lifecycle: 'dormant' } });
      }
      this.closedTabs.push(...closedRecords);
      const entries = [...this.tabs.values()];
      if ('activeProfileId' in raw && typeof raw.activeProfileId === 'string' && this.profiles.some(p => p.id === raw.activeProfileId)) this.activeProfileId = raw.activeProfileId;
      const index = 'activeTabIndex' in raw && Number.isInteger(raw.activeTabIndex) ? raw.activeTabIndex as number : -1;
      const selected = entries[index]?.state.profileId === this.activeProfileId ? entries[index] : entries.find(t => t.state.profileId === this.activeProfileId);
      if (selected) this.activateTab(selected.state.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not restore browser session', { cause: error });
    }
    if (!this.activeTabId) await this.newTab();
  }

  getState(): BrowserState {
    return structuredClone({ profiles: this.profiles, activeProfileId: this.activeProfileId, activeTabId: this.activeTabId, splitCount:this.splitCount, paneTabIds:this.paneTabIds, agentPaneTabIds:this.agentPaneTabIds, tabs: [...this.tabs.values()].map(t => t.state), closedTabCount: this.closedTabs.filter(t => t.profileId === this.activeProfileId).length });
  }

  // Main-only task bootstrap; deliberately absent from BrowserPort and worker actions.
  async createGoalPage(input:{profileId:string;goalId:string;url:string;host:BrowserWindow}):Promise<{areaId:string;context:BrowserContext}> {
    this.assertLive();
    const {profileId,goalId,url,host}=input;
    if(typeof goalId!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(goalId)) throw new Error('Invalid goal identity');
    if(!safeGoalPageUrl(url)) throw new Error('Unsafe goal page URL');
    if(profileId!==this.activeProfileId || !this.profiles.some(profile=>profile.id===profileId)) throw new Error('Unknown or inactive goal profile');
    if(host===this.window || host.isDestroyed() || (this.agentHost && this.agentHost!==host)) throw new Error('Invalid agent host');
    if(this.agentPaneTabIds.length>=8) throw new Error('Agent host capacity is eight pages');
    if(this.agentPaneTabIds.some(id=>this.tabs.get(id)?.state.profileId!==profileId)) throw new Error('Agent host pages must share the original profile');
    const id=randomUUID(),areaId=randomUUID();
    const sessionPartition=`sidework-goal-${this.goalSessionScope}-${createHash('sha256').update(JSON.stringify([profileId,goalId])).digest('hex')}`;
    const entry:TabEntry={goalId,sessionPartition,state:{id,profileId,url,title:'작업 페이지',isLoading:false,canGoBack:false,canGoForward:false,ownership:'agent',revision:0,lifecycle:'dormant',agentAreaId:areaId}};
    const boundHost=!this.agentHost;
    if(!this.agentHost) {this.agentHost=host;host.on('resize',this.resize);}
    this.tabs.set(id,entry);
    this.agentPaneTabIds.push(id);
    let slot=0;const occupied=new Set(this.agentSlots.values());while(occupied.has(slot))slot++;
    this.agentSlots.set(id,slot);
    if(slot>=this.agentGridCount)this.agentGridCount=slot>=4?8:4;
    try {
      this.materialize(entry);
      this.applyLayout();this.onChange();
      await entry.ready;
      this.assertLive();
      if(this.tabs.get(id)!==entry || entry.state.agentAreaId!==areaId || profileId!==this.activeProfileId || host.isDestroyed() || entry.view?.webContents.isDestroyed()) throw new Error('Goal page changed while loading');
      return {areaId,context:{profileId,tabId:id}};
    } catch(error) {
      // Only roll back the entry still owned by this bootstrap, never a returned user page.
      if(this.tabs.get(id)===entry && entry.state.agentAreaId===areaId) {
        this.destroyTab(entry);
        if(boundHost && this.agentHost===host && !this.agentPaneTabIds.length) {host.removeListener('resize',this.resize);this.agentHost=undefined;}
        this.applyLayout();this.onChange();
      }
      throw error;
    }
  }

  async handoffToAgent(context:BrowserContext,host:BrowserWindow):Promise<{areaId:string;context:BrowserContext}> {
    const entry=this.target(context),view=entry.view;
    if(!view || entry.visible!==true || entry.state.lifecycle!=='live' || entry.state.agentAreaId || !/^https?:\/\//i.test(entry.state.url)) throw new Error('Only visible live HTTP(S) user pages can be handed off');
    if(host===this.window || host.isDestroyed() || (this.agentHost && this.agentHost!==host)) throw new Error('Invalid agent host');
    if(this.agentPaneTabIds.length>=8) throw new Error('Agent host capacity is eight pages');
    if(this.agentPaneTabIds.some(id=>this.tabs.get(id)?.state.profileId!==context.profileId)) throw new Error('Agent host pages must share the original profile');
    const areaId=randomUUID();
    this.transferView(view,this.window,host,false);
    if(!this.agentHost) {this.agentHost=host;host.on('resize',this.resize);}
    entry.state.agentAreaId=areaId;
    this.agentPaneTabIds.push(entry.state.id);
    let agentSlot=0;const occupied=new Set(this.agentSlots.values());while(occupied.has(agentSlot))agentSlot++;
    this.agentSlots.set(entry.state.id,agentSlot);
    if(agentSlot>=this.agentGridCount)this.agentGridCount=agentSlot>=4?8:4;
    entry.state.revision++;entry.geometry=undefined;entry.frameId=undefined;entry.computer=undefined;entry.stamp=undefined;
    const slot=this.paneTabIds.indexOf(entry.state.id),id=randomUUID();
    this.tabs.set(id,{state:{id,profileId:entry.state.profileId,url:'about:blank',title:'새 탭',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'dormant'}});
    this.paneTabIds[slot]=id;
    if(this.activeTabId===entry.state.id) {this.activeTabId=id;this.selectedTabs.set(this.activeProfileId,id);}
    this.applyLayout();this.onChange();
    return {areaId,context:{profileId:entry.state.profileId,tabId:entry.state.id}};
  }

  async returnFromAgent(context:BrowserContext):Promise<void> {
    this.assertLive();
    const entry=this.tabs.get(context.tabId),host=this.agentHost,view=entry?.view;
    if(!entry || entry.state.profileId!==context.profileId || context.profileId!==this.activeProfileId || !entry.state.agentAreaId || !this.agentPaneTabIds.includes(context.tabId) || !view || view.webContents.isDestroyed() || !host || host.isDestroyed()) throw new Error('No live agent target to return in the active profile');
    this.transferView(view,host,this.window,true);
    delete entry.state.agentAreaId;
    this.agentPaneTabIds=this.agentPaneTabIds.filter(id=>id!==entry.state.id);
    this.agentSlots.delete(entry.state.id);
    if(!this.agentPaneTabIds.length)this.agentGridCount=2;
    entry.state.revision++;entry.geometry=undefined;entry.frameId=undefined;entry.computer=undefined;entry.stamp=undefined;
    this.activateTab(entry.state.id);
  }

  private transferView(view:WebContentsView,from:BrowserWindow,to:BrowserWindow,backgroundThrottling:boolean):void {
    from.contentView.removeChildView(view);
    let attached=false;
    try {
      to.contentView.addChildView(view);attached=true;
      view.webContents.setBackgroundThrottling?.(backgroundThrottling);
    } catch(error) {
      if(attached) to.contentView.removeChildView(view);
      from.contentView.addChildView(view);
      view.webContents.setBackgroundThrottling?.(!backgroundThrottling);
      throw error;
    }
  }

  private agentSplitCount():SplitCount {return this.agentGridCount;}

  getAgentState():BrowserState {
    const tabs=this.agentPaneTabIds.flatMap(id=>{const entry=this.tabs.get(id);return entry?[entry.state]:[];});
    const paneTabIds=Array.from({length:this.agentSplitCount()},(_,slot)=>this.agentPaneTabIds.find(id=>this.agentSlots.get(id)===slot)??'');
    return structuredClone({profiles:this.profiles,activeProfileId:tabs[0]?.profileId??this.activeProfileId,activeTabId:tabs[0]?.id??null,splitCount:this.agentSplitCount(),paneTabIds,agentPaneTabIds:this.agentPaneTabIds,tabs,closedTabCount:0});
  }

  setAgentLayout(layout:Layout):void {
    this.assertLive();
    const clamp=(n:number)=>Number.isFinite(n)?Math.max(0,Math.min(10000,Math.round(n))):0;
    this.agentLayout={sidebarWidth:clamp(layout.sidebarWidth),top:clamp(layout.top),left:clamp(layout.left),bottom:clamp(layout.bottom),hideBrowser:layout.hideBrowser===true};
    this.applyLayout();
  }

  getContext(): BrowserContext {
    this.assertLive();
    const entry = this.active();
    return { profileId: entry.state.profileId, tabId: entry.state.id };
  }

  // Trusted UI only: deliberately absent from BrowserPort/AgentAction and worker routing.
  /** Main-only DOM/compositor barrier. DOM tasks must not acquire screenshot capability. */
  async settleGoalPage(context:BrowserContext):Promise<void>{
    const entry=this.target(context),view=entry.view;
    if(!entry.sessionPartition||!entry.state.agentAreaId||!view||entry.visible!==true||entry.state.lifecycle!=='live')throw new Error('Only live goal-owned agent pages can settle');
    const wc=view.webContents,frame=wc.mainFrame,serial=entry.navigationSerial,geometry=entry.geometry,url=entry.state.url,goalId=entry.goalId,areaId=entry.state.agentAreaId;
    // Bootstrap only, before a grant or action: wait for native loading and acquire
    // a fresh revision after same-document startup events. Never reuse a stale pin.
    // Replacements, navigation, ownership and geometry changes still fail closed.
    const owned=()=>{if(this.target(context)!==entry||entry.view!==view||wc.isDestroyed()||wc.mainFrame!==frame||entry.navigationSerial!==serial||entry.geometry!==geometry||entry.visible!==true||entry.state.lifecycle!=='live'||entry.goalId!==goalId||entry.state.agentAreaId!==areaId||entry.state.url!==url||wc.getURL()!==url||context.profileId!==this.activeProfileId||this.controlVisuals.has(context.tabId))throw new Error('Goal page changed during DOM settlement');};
    const deadline=Date.now()+5000;
    for(let attempt=0;attempt<3;attempt++){
      owned();
      let quietSince=Date.now(),lastRevision=entry.state.revision;
      while(true){
        owned();
        if(wc.isLoading()||entry.state.isLoading||entry.state.revision!==lastRevision){quietSince=Date.now();lastRevision=entry.state.revision;}
        else if(Date.now()-quietSince>=100)break;
        if(Date.now()>=deadline)throw new Error('Goal page loading did not settle');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      const revision=entry.state.revision;
      owned();
      await wc.executeJavaScriptInIsolatedWorld(1001,[{code:scrollSettlementScript()}]);
      owned();
      if(entry.state.revision===revision&&!wc.isLoading()&&!entry.state.isLoading)return;
    }
    throw new Error('Goal page changed during DOM settlement');
  }

  async captureUserPreview(context:BrowserContext):Promise<PagePreview> {
    let revision=0;
    try {
      const entry=this.target(context),view=entry.view;
      revision=entry.state.revision;
      if(!view || entry.visible!==true || entry.state.lifecycle!=='live') throw new Error('Unavailable');
      const wc=view.webContents,frame=wc.mainFrame,serial=entry.navigationSerial,geometry=entry.geometry;
      const current=():void=>{
        if(this.target(context)!==entry || entry.view!==view || view.webContents!==wc || wc.isDestroyed() || wc.mainFrame!==frame || entry.visible!==true || entry.state.lifecycle!=='live' || entry.state.revision!==revision || entry.navigationSerial!==serial || entry.geometry!==geometry) throw new Error('Stale');
      };
      current();
      const before=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:observationScript()}]) as DOMSnapshot;
      current();
      if(typeof before?.stamp!=='string' || before.computer?.captureBlocked!==false || !isSafeNavigation(before.url,before.url) || before.url==='about:blank') throw new Error('Unavailable');
      let image=await wc.capturePage();
      current();
      const after=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:observationScript()}]) as DOMSnapshot;
      current();
      if(after?.stamp!==before.stamp || after.url!==before.url || JSON.stringify(after.computer)!==JSON.stringify(before.computer)) throw new Error('Stale');
      if(image.isEmpty()) throw new Error('Empty');
      const {width,height}=image.getSize();
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0) throw new Error('Dimensions');
      if(width>400) image=image.resize({width:400,height:Math.max(1,Math.floor(height*400/width)),quality:'good'});
      const bytes=image.toPNG({scaleFactor:1});
      const imageDataUrl='data:image/png;base64,'+bytes.toString('base64');
      if(!bytes.length || imageDataUrl.length>1024*1024) throw new Error('Limit');
      return {profileId:context.profileId,tabId:context.tabId,revision,imageDataUrl};
    } catch {
      return {profileId:context.profileId,tabId:context.tabId,revision,imageDataUrl:null,error:'미리보기를 사용할 수 없습니다.'};
    }
  }

  invalidatePageContext(context:BrowserContext):void{
    const entry=this.target(context);
    entry.state.revision++;entry.frameId=undefined;entry.computer=undefined;entry.stamp=undefined;
    this.onChange();
  }

  updateControlJobs(jobs:readonly Job[]):void {
    if(this.disposed) return;
    this.goalDomJobs.clear();
    this.goalSearchJobs.clear();
    const live=new Set<string>();
    for(const job of jobs) {
      this.knownControlJobs.add(job.id);
      if(this.cancelledVisualJobs.has(job.id)) continue;
      if(job.status!=='running' && job.status!=='awaiting_approval') {
        if(job.status!=='queued') this.cancelledVisualJobs.add(job.id);
        continue;
      }
      const entry=this.tabs.get(job.tabId);
      if(!entry?.visible || entry.state.profileId!==job.profileId || job.profileId!==this.activeProfileId) continue;
      if(job.status==='running' && job.agentScope?.goalId && !job.computerUse && entry.sessionPartition && entry.state.agentAreaId===job.agentScope.areaId)this.goalDomJobs.add(job.id);
      const scope=job.agentScope;
      if(this.goalDomJobs.has(job.id) && !job.approval && !job.shareScreen && scope?.goalId===entry.goalId && scope?.allowedOrigins?.length && Date.parse(scope.expiresAt)>Date.now()){
        this.goalSearchJobs.set(job.id,{profileId:job.profileId,tabId:job.tabId,areaId:scope.areaId,goalId:scope.goalId!,expires:Date.parse(scope.expiresAt),origins:[...scope.allowedOrigins],scope:JSON.stringify([job.id,job.profileId,job.tabId,job.executionEpoch,scope])});
      }
      if(entry.goalNavigating)continue;
      live.add(job.tabId);
      const prior=this.controlVisuals.get(job.tabId);
      const visual:PaneControlVisual={profileId:job.profileId,tabId:job.tabId,jobId:job.id,phase:job.status==='awaiting_approval'?'awaiting_approval':prior?.jobId===job.id && prior.phase!=='awaiting_approval'?prior.phase:'working',...(prior?.jobId===job.id && prior.x!==undefined?{x:prior.x,y:prior.y}:{})};
      this.controlVisuals.set(job.tabId,visual);
      const epoch=entry.visualEpoch??0;
      if(JSON.stringify(prior)!==JSON.stringify(visual)) void this.visualScript(entry,controlVisualSetScript(visual)).catch(()=>{
        if(this.goalDomJobs.has(job.id) && (entry.visualEpoch??0)!==epoch)return;
        void this.cancelControlVisuals(job.id).catch(()=>{});
      });
    }
    for(const [id,visual] of this.controlVisuals) if(!live.has(id)) void this.cancelControlVisuals(visual.jobId).catch(()=>{});
  }

  getControlVisuals():PaneControlVisual[] {return structuredClone([...this.controlVisuals.values()]);}

  async cancelControlVisuals(jobId?:string):Promise<void> {
    if(jobId!==undefined) this.cancelledVisualJobs.add(jobId);
    else for(const id of [...this.knownControlJobs,...this.activePointerJobs]) this.cancelledVisualJobs.add(id);
    const clears:Promise<void>[]=[];
    for(const [id,visual] of this.controlVisuals) if(jobId===undefined || visual.jobId===jobId) {
      this.cancelledVisualJobs.add(visual.jobId);this.controlVisuals.delete(id);
      const entry=this.tabs.get(id);if(entry) clears.push(this.visualScript(entry,controlVisualClearScript()));
    }
    const results=await Promise.allSettled(clears);
    const failure=results.find(r=>r.status==='rejected');if(failure?.status==='rejected') throw failure.reason;
  }

  private async visualScript(entry:TabEntry,code:string):Promise<void> {
    const wc=entry.view?.webContents;if(!wc || wc.isDestroyed()) return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([wc.executeJavaScriptInIsolatedWorld(1001,[{code}]),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Control feedback acknowledgement timeout; visibility unknown')),250);})]);}
    finally {clearTimeout(timer);}
  }

  async newTab(url = 'about:blank', ownership: 'user' | 'agent' = 'user'): Promise<string> {
    this.assertLive();
    const destination = normalizeNavigation(url);
    const id = randomUUID();
    const profile = this.profiles.find(p => p.id === this.activeProfileId);
    if (!profile) throw new Error('Unknown profile');
    const state: BrowserTab = { id, profileId: profile.id, url: destination, title: '새 탭', isLoading: false, canGoBack: false, canGoForward: false, ownership, revision: 0, lifecycle: 'dormant' };
    const entry: TabEntry = { state };
    this.tabs.set(id, entry);
    this.activateTab(id);
    await entry.ready;
    return id;
  }

  private materialize(entry: TabEntry): WebContentsView {
    this.assertLive();
    if (entry.view) return entry.view;
    const state = entry.state;
    const { id, url: destination } = state;
    const profile = this.profiles.find(p => p.id === state.profileId);
    if (!profile) throw new Error('Unknown profile');
    const sessionKey=entry.sessionPartition??profile.id;
    let ses = this.sessions.get(sessionKey);
    if (!ses) {
      ses = session.fromPartition(entry.sessionPartition??`${profile.incognito ? '' : 'persist:'}sidework-${profile.id}`);
      this.sessions.set(sessionKey, ses);
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      ses.on('will-download', this.receiveDownload);
    }
    const view = new WebContentsView({ webPreferences: { session: ses, nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false } });
    entry.view = view;
    state.lifecycle = 'live';
    view.setVisible(false);
    const host=state.agentAreaId?this.agentHost:this.window;
    if(!host || host.isDestroyed()) throw new Error('Invalid page host');
    host.contentView.addChildView(view);
    const wc = view.webContents;
    if(state.agentAreaId) wc.setBackgroundThrottling(false);
    wc.on('before-input-event', (event, input) => {
      const key = browserShortcut(input);
      if (!key) return;
      event.preventDefault();
      const host=state.agentAreaId?this.agentHost:this.window;
      if(!host || host.isDestroyed()) return;
      host.webContents.focus();
      const modifiers: ('meta'|'control')[] = [input.meta ? 'meta' : 'control'];
      host.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      host.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowedNavigation=(url:string)=>isAllowedURL(url) && (!entry.sessionPartition || !state.agentAreaId || safeGoalPageUrl(url));
    wc.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
    wc.on('will-redirect', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
    wc.on('will-frame-navigate', event => { if (!allowedNavigation(event.url)) event.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    const changed = () => {
      if (this.disposed || wc.isDestroyed() || !this.tabs.has(id)) return;
      state.url = wc.getURL() || destination;
      state.title = state.url === 'about:blank' ? '새 탭' : wc.getTitle().slice(0, 300);
      state.isLoading = wc.isLoading();
      state.canGoBack = wc.navigationHistory.canGoBack();
      state.canGoForward = wc.navigationHistory.canGoForward();
      this.applyLayout();
      this.onChange();
    };
    wc.on('did-start-navigation', (details, _url, _inPlace, legacyMainFrame) => {
      if ((details.isMainFrame ?? legacyMainFrame) !== true) return;
      const visual=this.controlVisuals.get(id);
      entry.visualEpoch=(entry.visualEpoch??0)+1;
      if(visual && this.goalDomJobs.has(visual.jobId) && !this.cancelledVisualJobs.has(visual.jobId)) {
        // Invalidate the old document's feedback, not the live goal's execution authority.
        // Main scope/epoch checks and fresh DOM checks still gate every subsequent RPC.
        entry.goalNavigating=true;this.controlVisuals.delete(id);
      } else if(visual) void this.cancelControlVisuals(visual.jobId).catch(()=>{});
      state.error = undefined; state.revision++; entry.frameId = undefined; entry.stamp = undefined; entry.computer = undefined; changed();
    });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || this.disposed || !this.tabs.has(id)) return;
      const message = navigationErrorMessage(code, description);
      if (message) { state.error = message; changed(); }
    });
    wc.on('did-navigate', changed);
    wc.on('did-navigate-in-page', changed);
    wc.on('did-start-loading', changed);
    wc.on('did-stop-loading', () => {entry.goalNavigating=false;changed();});
    wc.on('page-title-updated', changed);
    const serial = entry.navigationSerial = (entry.navigationSerial ?? 0) + 1;
    const ready = wc.loadURL(destination).then(changed);
    entry.ready = ready;
    void ready.then(() => { if (entry.ready === ready) entry.ready = undefined; }, (error: unknown) => {
      if (entry.ready === ready) entry.ready = undefined;
      if (this.disposed || !this.tabs.has(id) || entry.navigationSerial !== serial) return;
      const info = typeof error === 'object' && error !== null ? error as { errno?: unknown; code?: unknown } : {};
      const code = typeof info.errno === 'number' ? info.errno : info.code === 'ERR_ABORTED' ? -3 : -1;
      const message = navigationErrorMessage(code, typeof info.code === 'string' ? info.code : '');
      if (message) { state.error = message; this.onChange(); }
    });
    return view;
  }

  activateTab(id: string): void {
    this.assertLive();
    const tab = this.tabs.get(id);
    if (!tab || tab.state.agentAreaId || tab.state.profileId !== this.activeProfileId) throw new Error('Unknown user tab in active profile');
    const previous = this.activeTabId;
    if (!this.paneTabIds.includes(id)) this.paneTabIds[Math.max(0,this.paneTabIds.indexOf(previous ?? ''))] = id;
    this.activeTabId = id;
    this.selectedTabs.set(this.activeProfileId, id);
    if (this.splitCount === 1) tab.state.revision++;
    if (this.splitCount === 1 || tab.state.url !== 'about:blank') this.materialize(tab);
    this.applyLayout();
    this.onChange();
  }

  private async closeNativeView(entry:TabEntry,reason:'tab'|'quit'):Promise<boolean>{
    const view=entry.view,wc=view?.webContents;
    if(!wc||wc.isDestroyed())return true;
    const revision=entry.state.revision,url=wc.getURL();
    const owned=()=>!this.disposed&&!this.disposing&&this.tabs.get(entry.state.id)===entry&&entry.view===view&&entry.state.revision===revision;
    const current=()=>owned()&&view?.webContents===wc&&!wc.isDestroyed()&&wc.getURL()===url;
    return new Promise<boolean>(resolve=>{
      let finished=false,asked=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(closed:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);wc.removeListener('destroyed',destroyed);wc.removeListener('will-prevent-unload',veto);resolve(closed);};
      const destroyed=()=>finish(owned());
      const request=()=>{timer=setTimeout(()=>finish(false),5_000);try{wc.close({waitForBeforeUnload:true});}catch{finish(false);}};
      const veto=(event:Event)=>{
        if(finished)return;
        clearTimeout(timer);
        if(asked||!current()||!this.confirmClose){finish(false);return;}
        asked=true;
        try{
          // Match Electron's synchronous native veto decision. An async close retry can race its cancellation ACK.
          if(this.confirmClose(structuredClone(entry.state),reason)!==true||!current()){finish(false);return;}
          timer=setTimeout(()=>finish(false),5_000);event.preventDefault();
        }catch{finish(false);}
      };
      wc.once('destroyed',destroyed);wc.on('will-prevent-unload',veto);request();
    });
  }

  async closeTab(id: string): Promise<void> {
    this.assertLive();
    const entry = this.tabs.get(id);
    if (!entry) throw new Error('Unknown tab');
    const closed = await this.closeNativeView(entry,'tab');
    if (!closed || this.disposed || this.tabs.get(id) !== entry) return;
    if (!entry.sessionPartition && !this.profiles.find(p => p.id === entry.state.profileId)?.incognito) {
      this.closedTabs.push({ profileId: entry.state.profileId, url: entry.state.url });
      if (this.closedTabs.length > 20) this.closedTabs.shift();
    }
    this.destroyTab(entry);
    if (this.activeTabId === id) {
      this.selectedTabs.delete(this.activeProfileId);
      this.activeTabId = [...this.tabs.values()].find(t => !t.state.agentAreaId && t.state.profileId === this.activeProfileId)?.state.id ?? null;
      if (!this.activeTabId) await this.newTab();
      else this.activateTab(this.activeTabId);
    }
    this.applyLayout();
    this.onChange();
  }

  async restoreClosedTab(): Promise<void> {
    this.assertLive();
    if (!this.profiles.some(p => p.id === this.activeProfileId && !p.incognito)) return;
    let index = this.closedTabs.length - 1;
    while (index >= 0 && this.closedTabs[index]!.profileId !== this.activeProfileId) index--;
    if (index < 0) return;
    const [closed] = this.closedTabs.splice(index, 1);
    if (!closed) return;
    // Only the GET URL is restored, never a form, POST body, DOM or approval.
    await this.newTab(closed.url);
  }

  async prepareToQuit(): Promise<boolean> {
    this.assertLive();
    if(this.quitPrepared)return true;
    this.preparingQuit=true;
    try{
      // Commit URL metadata before closing any native page. Never persist an empty teardown session.
      await this.persistProfiles(true);
      for(const entry of [...this.tabs.values()]){
        if(!await this.closeNativeView(entry,'quit')){
          // Vetoed pages stay live. Already-closed clean pages can only reload their saved GET URL.
          for(const tab of this.tabs.values()){const wc=tab.view?.webContents;if(tab.view&&(!wc||wc.isDestroyed()))this.detachClosedView(tab);}
          for(const id of this.paneTabIds){const tab=this.tabs.get(id);if(tab&&!tab.view&&tab.state.url!=='about:blank')this.materialize(tab);}
          this.applyLayout();return false;
        }
        this.detachClosedView(entry);
      }
      this.quitPrepared=true;return true;
    }finally{this.preparingQuit=false;this.onChange();}
  }

  private detachClosedView(entry:TabEntry):void{
    const host=entry.state.agentAreaId?this.agentHost:this.window;
    if(entry.view&&host&&!host.isDestroyed())host.contentView.removeChildView(entry.view);
    this.agentPaneTabIds=this.agentPaneTabIds.filter(id=>id!==entry.state.id);
    this.agentSlots.delete(entry.state.id);
    if(!this.agentPaneTabIds.length)this.agentGridCount=2;
    delete entry.state.agentAreaId;
    entry.view=undefined;entry.ready=undefined;entry.debuggerOwned=false;entry.visible=false;
    entry.frameId=undefined;entry.stamp=undefined;entry.computer=undefined;entry.geometry=undefined;
    entry.state.lifecycle='dormant';entry.state.isLoading=false;entry.state.revision++;
  }

  async createProfile(name: string, incognito = false): Promise<string> {
    this.assertLive();
    const clean = name.trim();
    if (!clean || clean.length > 60 || [...clean].some(c => c.charCodeAt(0) < 32)) throw new Error('Invalid profile name');
    if (this.profiles.length >= 40) throw new Error('Profile limit reached');
    const id = `p-${randomUUID()}`;
    this.profiles.push({ id, name: clean, incognito: incognito === true });
    await this.persistProfiles();
    this.onChange();
    return id;
  }

  async activateProfile(id: string): Promise<void> {
    this.assertLive();
    if (!this.profiles.some(p => p.id === id)) throw new Error('Unknown profile');
    for (const entry of this.tabs.values()) if(!entry.state.agentAreaId) entry.state.revision++;
    this.paneTabIds=[];
    this.activeProfileId = id;
    const selected = this.selectedTabs.get(id);
    this.activeTabId = selected && this.tabs.has(selected) && !this.tabs.get(selected)!.state.agentAreaId ? selected : [...this.tabs.values()].find(t => !t.state.agentAreaId && t.state.profileId === id)?.state.id ?? null;
    if (!this.activeTabId) await this.newTab();
    else this.activateTab(this.activeTabId);
    await this.setSplitCount(this.splitCount);
    this.applyLayout();
    await this.persistProfiles();
    this.onChange();
  }

  async navigate(url: string, tabId?:string): Promise<void> {
    const destination = normalizeNavigation(url);
    const entry = tabId ? this.target({profileId:this.activeProfileId,tabId}) : this.active();
    entry.state.revision++;entry.frameId=undefined;
    if(!entry.view){entry.state.url=destination;entry.state.error=undefined;this.materialize(entry);this.onChange();return;}
    const serial = (entry.navigationSerial ?? 0) + 1;
    entry.navigationSerial = serial;
    entry.state.error = undefined;
    // Manual browser navigation acknowledges the request, not a finished document.
    // Redirects and user replacements may abort loadURL while the new page loads normally.
    void this.materialize(entry).webContents.loadURL(destination).catch((error: unknown) => {
      if (this.disposed || !this.tabs.has(entry.state.id) || entry.navigationSerial !== serial) return;
      const info = typeof error === 'object' && error !== null ? error as { errno?: unknown; code?: unknown } : {};
      const code = typeof info.errno === 'number' ? info.errno : info.code === 'ERR_ABORTED' ? -3 : -1;
      const message = navigationErrorMessage(code, typeof info.code === 'string' ? info.code : '');
      if (message) { entry.state.error = message; this.onChange(); }
    });
  }

  async back(): Promise<void> {
    const entry=this.active();const wc = this.materialize(entry).webContents;
    if (wc.navigationHistory.canGoBack()) {entry.state.revision++;entry.frameId=undefined;wc.navigationHistory.goBack();}
  }

  async forward(): Promise<void> {
    const entry=this.active();const wc = this.materialize(entry).webContents;
    if (wc.navigationHistory.canGoForward()) {entry.state.revision++;entry.frameId=undefined;wc.navigationHistory.goForward();}
  }

  async reload(): Promise<void> {const entry=this.active();entry.state.revision++;entry.frameId=undefined;this.materialize(entry).webContents.reload(); }

  private searchObservationMode(context:BrowserContext,jobId?:string):DOMObservationMode|undefined {
    if(!jobId || this.cancelledVisualJobs.has(jobId))return;
    const grant=this.goalSearchJobs.get(jobId),entry=this.target(context);
    if(!grant || grant.profileId!==context.profileId || grant.tabId!==context.tabId || grant.goalId!==entry.goalId || grant.areaId!==entry.state.agentAreaId || grant.expires<=Date.now() || context.profileId!==this.activeProfileId || !entry.sessionPartition || entry.state.ownership!=='agent' || entry.visible!==true || (entry.view?.webContents.isLoadingMainFrame?.()??entry.state.isLoading) || entry.goalNavigating || entry.state.lifecycle!=='live' || this.controlVisuals.get(context.tabId)?.jobId!==jobId || !['https://www.google.com/','https://www.naver.com/'].includes(entry.state.url) || entry.view?.webContents.getURL()!==entry.state.url || !grant.origins.includes(new URL(entry.state.url).origin))return;
    return {kind:'provider-search',scope:grant.scope};
  }

  async observe(context: BrowserContext, options?:{computerUse?:boolean;shareScreen?:boolean;jobId?:string}): Promise<Observation> {
    if(options?.computerUse && options.shareScreen!==true) throw new Error('Screen share consent required');
    const entry = this.target(context);
    validateTarget({ profileId: entry.state.profileId, tabId: entry.state.id, revision: entry.state.revision }, context);
    this.materialize(entry);
    await entry.ready;
    validateTarget({ ...this.target(context).state, tabId:entry.state.id }, context);
    const revision = entry.state.revision;
    // Only main's live goal DOM binding can request the explicit focused view.
    // Bootstrap/manual observations and every pixel/share request remain full.
    const mode=!options?.computerUse && !options?.shareScreen?this.searchObservationMode(context,options?.jobId):undefined;
    const wc=this.materialize(entry).webContents,frame=wc.mainFrame;
    const raw: unknown = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: observationScript(mode) }]);
    validateTarget({ ...this.target(context).state, tabId:entry.state.id }, { ...context, expectedRevision: revision });
    if(mode && (entry.view?.webContents!==wc || wc.mainFrame!==frame || JSON.stringify(this.searchObservationMode(context,options?.jobId))!==JSON.stringify(mode)))throw new Error('Stale DOM revision');
    if (typeof raw !== 'object' || raw === null || !('stamp' in raw) || typeof raw.stamp !== 'string' || !('elements' in raw) || !Array.isArray(raw.elements)) throw new Error('Invalid page observation');
    const snapshot = raw as DOMSnapshot;
    if(mode && entry.observationFrame!==undefined && entry.observationFrame!==frame)entry.state.revision++;
    entry.observationFrame=frame;
    if (entry.stamp !== undefined && entry.stamp !== snapshot.stamp) entry.state.revision++;
    entry.stamp = snapshot.stamp;
    entry.computer = snapshot.computer;
    const screen=options?.computerUse ? await this.captureFrame(entry,context,snapshot) : undefined;
    const candidate:unknown=snapshot.readingViewport;
    let readingViewport:Observation['readingViewport'];
    if(typeof candidate==='object' && candidate!==null && 'documentId' in candidate && 'scrollY' in candidate && 'height' in candidate && 'scrollHeight' in candidate && 'text' in candidate) {
      const {documentId,scrollY,height,scrollHeight,text}=candidate;
      if(typeof documentId==='string' && documentId.length>0 && documentId.length<=200 && typeof text==='string' && text.length<=12000 && typeof scrollY==='number' && typeof height==='number' && typeof scrollHeight==='number' && [scrollY,height,scrollHeight].every(Number.isFinite) && scrollY>=0 && height>0 && height<=30000 && scrollHeight>=height && scrollHeight<=100000000 && scrollY<=scrollHeight-height+1) readingViewport={documentId,scrollY,height,scrollHeight,text};
    }
    if(snapshot.observationMode==='search-form' && (!mode || snapshot.url!==entry.state.url || typeof snapshot.documentId!=='string' || !snapshot.documentId || snapshot.documentId.length>200 || snapshot.readingViewport))throw new Error('Invalid focused observation');
    const observation:Observation={ ...context, revision: entry.state.revision, url: snapshot.url, title: snapshot.title, text: snapshot.text, elements: snapshot.elements, capturedAt: new Date().toISOString(), ...(screen?{screen}:{}), ...(readingViewport?{readingViewport}:{}), ...(snapshot.observationMode==='search-form'?{documentId:snapshot.documentId,observationMode:'search-form' as const}:{}) };
    this.onChange();
    return observation;
  }

  async execute(action: BrowserAction, context: ExecutionContext): Promise<BrowserActionResult> {
    assertBrowserAction(action);
    this.assertExecution(context);
    if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) throw new Error('Invalid expected revision');
    const computer=action.type.startsWith('computer_');
    const prior=computer ? this.target(context).frameId : undefined;
    if(computer && (!prior || !('frameId' in action) || action.frameId!==prior)) throw new Error('Stale or unknown screen frame');
    const fresh = await this.observe(context,computer?{computerUse:true,shareScreen:true}:action.type==='screenshot'?{shareScreen:true}:{jobId:context.jobId});
    const entry = this.target(context);
    validateTarget({ ...fresh, tabId: fresh.tabId }, context);
    validateTarget({ ...entry.state,tabId:entry.state.id }, context);
    this.assertExecution(context);
    const result = (message: string): BrowserActionResult => ({ context: { profileId: context.profileId, tabId: context.tabId }, message });
    switch (action.type) {
      case 'computer_click':
      case 'computer_type':
      case 'computer_key': {
        const frame=fresh.screen;
        if(!frame || frame.frameId!==action.frameId) throw new Error('Stale screen frame');
        const wc=this.materialize(entry).webContents;
        if(action.type!=='computer_click' && entry.computer?.focusBlocked!==false) throw new Error('Sensitive or unknown focus prohibits input');
        if(action.type==='computer_click' && (action.x>=frame.width || action.y>=frame.height)) throw new Error('Computer coordinates outside frame');
        // BrowserController is reached only through the approval-bound runtime. Never focus the global active tab.
        entry.frameId=undefined;
        if(action.type!=='computer_click') entry.state.revision++;
        if(action.type==='computer_click') {
          const link=screenLinkAt(frame,action.x,action.y);
          if(link && isSafeNavigation(fresh.url,link.url)) {entry.state.revision++;await wc.loadURL(link.url);}
          else {
            const x=Math.min(frame.viewportWidth-1,Math.floor(action.x*frame.viewportWidth/frame.width)),y=Math.min(frame.viewportHeight-1,Math.floor(action.y*frame.viewportHeight/frame.height));
            await this.executeGlide(entry,context,frame,x,y);
          }
        } else if(action.type==='computer_type') await this.withControlPhase(entry,context,'typing',async()=>{this.assertExecution(context);await this.inputDebugger(entry).sendCommand('Input.insertText',{text:action.value});});
        else {
          const codes:Record<string,number>={Tab:9,Enter:13,Escape:27,Backspace:8,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,PageUp:33,PageDown:34,Home:36,End:35,Space:32};
          const params={key:action.key==='Space'?' ':action.key,code:action.key,windowsVirtualKeyCode:codes[action.key]};
          const debug=this.inputDebugger(entry);
          await this.withControlPhase(entry,context,'typing',async()=>{
          this.assertExecution(context);
          await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...params,...(action.key==='Space'?{text:' '}:action.key==='Enter'?{text:'\r'}:{})});
          this.assertExecution(context);
          await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...params});
          });
        }
        this.onChange();
        return result('Local computer input dispatched; observe to verify result');
      }
      case 'observe': return result('Page observed');
      case 'screenshot': {
        assertJobId(context.jobId);
        if (fresh.url === 'about:blank') throw new Error('Blank homepage has no native screenshot');
        const frame=await this.captureFrame(entry,context,{...fresh,stamp:entry.stamp!,computer:entry.computer!},false);
        const bytes=Buffer.from(frame.pngBase64,'base64');
        let directory = this.dataRoot;
        for (const segment of ['jobs', context.jobId, 'artifacts']) {
          directory = join(directory, segment);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe job artifact directory');
        }
        const id = randomUUID();
        const name = `screenshot-${id}.png`;
        const path = join(directory, name);
        this.assertExecution(context);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        return { context: { profileId: context.profileId, tabId: context.tabId }, message: 'Screenshot saved', artifact: { id, kind: 'screenshot', name, path, createdAt: new Date().toISOString() } };
      }
      case 'navigate': await this.materialize(entry).webContents.loadURL(normalizeNavigation(action.url)); return result('Navigation completed');
      case 'open_tab': {
        if(entry.state.agentAreaId || entry.frameId || this.splitCount>1) throw new Error('Agent host, computer use and split panes cannot open or retarget agent tabs');
        const id = await this.newTab(action.url, 'agent');
        return { context: { profileId: context.profileId, tabId: id }, message: 'Agent tab opened' };
      }
      case 'submit_search': {
        const mode=this.searchObservationMode(context,context.jobId),grant=this.goalSearchJobs.get(context.jobId);
        const matches=fresh.elements.filter(el=>el.ref===action.ref),query=matches[0];
        if(!mode || !grant || !grant.origins.includes('https://search.naver.com') || !grant.origins.includes('https://www.naver.com') || fresh.url!=='https://www.naver.com/' || fresh.observationMode!=='search-form' || !fresh.documentId || matches.length!==1 || query?.sensitive!==false || query.tag!=='input' || query.role!=='combobox' || query.inputType!=='search' || query.interaction?.kind!=='input' || query.interaction.submission?.kind!=='naver-native-get' || query.interaction.submission.method!=='get' || query.interaction.submission.url!=='https://search.naver.com/search.naver')throw new Error('Native search submission capability denied');
        // No click/cursor phase: the query ref authorizes native form semantics.
        this.assertExecution(context);
        await this.materialize(entry).webContents.executeJavaScriptInIsolatedWorld(1001,[{code:actionScript(action,entry.stamp!,{observation:mode,nativeSearchSubmission:true,jobId:context.jobId})}]);
        entry.state.revision++;this.onChange();
        return result('submit_search dispatched; observe to verify native results');
      }
      case 'click':
      case 'fill':
      case 'scroll':
        if ((action.type === 'click' || action.type === 'fill') && !fresh.elements.some(el => el.ref === action.ref)) throw new Error('Unknown DOM target');
        if (action.type === 'fill' && fresh.elements.find(el => el.ref === action.ref)?.sensitive) throw new Error('Sensitive fill is prohibited');
        await this.withControlPhase(entry,context,action.type==='scroll'?'scrolling':action.type==='fill'?'typing':'clicking',async()=>{
          if(action.type === 'scroll' && context.smoothScroll === true) await this.executeSmoothScroll(action,entry,context);
          else await this.materialize(entry).webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: actionScript(action, entry.stamp!,fresh.observationMode==='search-form'?{observation:this.searchObservationMode(context,context.jobId)}:undefined) }]);
          if(action.type === 'scroll') {
            await this.materialize(entry).webContents.executeJavaScriptInIsolatedWorld(1001,[{code:scrollSettlementScript()}]);
            this.assertExecution(context);
            validateTarget({...this.target(context).state,tabId:entry.state.id},context);
          }
        });
        entry.state.revision++;
        this.onChange();
        return { context: { profileId: context.profileId, tabId: context.tabId }, message: `${action.type} dispatched; observe to verify result` };
      default: throw new Error('Unsupported browser action');
    }
  }

  async cancelScroll(jobId?:string):Promise<void> {
    const results=await Promise.allSettled([...this.activeScrolls.values()].filter(scroll=>jobId===undefined || scroll.jobId===jobId).map(scroll=>scroll.cancel()));
    const failed=results.find(result=>result.status==='rejected');
    if(failed?.status==='rejected') throw failed.reason;
  }

  private async withControlPhase(entry:TabEntry,context:ExecutionContext,phase:ControlPhase,perform:()=>Promise<void>):Promise<void> {
    const revision=entry.state.revision;
    try {
      await this.controlPhase(entry,context,phase);
      this.assertExecution(context);
      if(this.target(context)!==entry) throw new Error('Input target changed');
      validateTarget({...entry.state,tabId:entry.state.id},{...context,expectedRevision:revision});
      await perform();
      await this.controlPhase(entry,context,'working');
    } catch(error) {
      if(this.controlVisuals.get(context.tabId)?.jobId===context.jobId) await this.cancelControlVisuals(context.jobId);
      throw error;
    }
  }

  private async controlPhase(entry:TabEntry,context:ExecutionContext,phase:ControlPhase,position?:{x:number;y:number}):Promise<void> {
    const prior=this.controlVisuals.get(context.tabId);
    if(!prior || prior.jobId!==context.jobId || this.cancelledVisualJobs.has(context.jobId)) return;
    const visual={...prior,phase,...position};this.controlVisuals.set(context.tabId,visual);
    await this.visualScript(entry,controlVisualSetScript(visual));this.onChange();
  }

  private async executeGlide(entry:TabEntry,context:ExecutionContext,frame:ScreenFrame,x:number,y:number):Promise<void> {
    const wc=this.materialize(entry).webContents,stamp=entry.stamp,metadata=JSON.stringify(entry.computer);
    const debug=this.inputDebugger(entry);
    const check=()=>{
      this.assertExecution(context);
      const current=this.target(context);
      if(current!==entry || current.view?.webContents!==wc || !current.visible) throw new Error('Computer pointer target changed or hidden');
      validateTarget({...current.state,tabId:current.state.id},context);
      if(![x,y].every(Number.isFinite) || x<0 || y<0 || x>=frame.viewportWidth || y>=frame.viewportHeight) throw new Error('Computer pointer outside viewport');
    };
    const documentCheck=async()=>{
      check();const current=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:observationScript()}]) as DOMSnapshot;
      check();if(current.stamp!==stamp || JSON.stringify(current.computer)!==metadata) throw new Error('Stale document or viewport during pointer movement');
    };
    const previous=this.controlVisuals.get(context.tabId);
    const start={x:Math.max(0,Math.min(frame.viewportWidth-1,previous?.x??Math.floor(frame.viewportWidth/2))),y:Math.max(0,Math.min(frame.viewportHeight-1,previous?.y??Math.floor(frame.viewportHeight/2)))};
    this.activePointerJobs.add(context.jobId);
    try {
      await documentCheck();
      const hit=async(remember:boolean)=>{
        check();const same=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:controlVisualHitScript(x,y,remember)}]);
        check();if(same!==true) throw new Error('Computer pointer hit target changed or unknown');
      };
      await hit(true);
      const reduced=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:controlVisualMotionScript()}])===true;
      for(let i=reduced?8:0;i<=8;i++) {
        await documentCheck();
        const t=1-Math.pow(1-i/8,3),point={x:Math.round(start.x+(x-start.x)*t),y:Math.round(start.y+(y-start.y)*t)};
        check();await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none'});
        check();await this.controlPhase(entry,context,'moving',point);
        if(i<8) await new Promise<void>(resolve=>setTimeout(resolve,45));
      }
      await documentCheck();await this.controlPhase(entry,context,'clicking',{x,y});
      await documentCheck();await hit(false);check();
      entry.state.revision++;
      this.assertExecution(context);await debug.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
      this.assertExecution(context);await debug.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
      await this.controlPhase(entry,context,'working');
    } catch(error) {await this.cancelControlVisuals(context.jobId);throw error;}
    finally {this.activePointerJobs.delete(context.jobId);}
  }

  private async executeSmoothScroll(action:BrowserAction,entry:TabEntry,context:ExecutionContext):Promise<void> {
    const wc=this.materialize(entry).webContents;
    if(this.activeScrolls.has(entry.state.id)) throw new Error('Smooth scroll already active for tab');
    let failure:Error | undefined;
    let rejectWait:((error:Error)=>void) | undefined;
    const cancelled=new Promise<never>((_resolve,reject)=>{rejectWait=reject;});
    let cancellation:Promise<void> | undefined;
    const owned={jobId:context.jobId,cancel:():Promise<void>=>{
      failure ??= new Error('Smooth scroll cancelled');
      rejectWait?.(failure);
      cancellation ??= (async()=>{
        if(wc.isDestroyed()) return;
        let timer:ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            wc.executeJavaScriptInIsolatedWorld(1001,[{code:cancelScrollScript(context.jobId)}]),
            new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Smooth scroll cancellation timeout; movement unknown')),250);}),
          ]);
        } finally {clearTimeout(timer);}
      })();
      return cancellation;
    }};
    const checkLease=()=>{
      this.assertExecution(context);
      const current=this.target(context);
      if(current!==entry || current.view?.webContents!==wc || current.visible!==true) throw new Error('Smooth scroll target hidden or changed');
      validateTarget({...current.state,tabId:current.state.id},context);
    };
    checkLease();
    this.activeScrolls.set(entry.state.id,owned);
    const deadline=setTimeout(()=>{
      failure ??= new Error('Smooth scroll execution timeout');
      void owned.cancel().catch(()=>{ /* Cancellation uncertainty remains a failure. */ });
    },1800);
    const lease=setInterval(()=>{
      try {checkLease();} catch(error) {
        failure ??= error instanceof Error ? error : new Error('Smooth scroll lease unknown');
        void owned.cancel().catch(()=>{ /* Execution remains failed; never retry unknown movement. */ });
      }
    },40);
    try {
      const dispatched=Promise.resolve().then(()=>{
        if(failure) throw failure;
        checkLease();
        return wc.executeJavaScriptInIsolatedWorld(1001,[{code:actionScript(action,entry.stamp!,{smoothScroll:true,jobId:context.jobId})}]);
      });
      await Promise.race([dispatched,cancelled]);
      if(failure) throw failure;
      checkLease();
    } catch(error) {
      await owned.cancel();
      throw error;
    } finally {clearTimeout(deadline);clearInterval(lease);if(this.activeScrolls.get(entry.state.id)===owned) this.activeScrolls.delete(entry.state.id);}
  }

  setLayout(layout: Layout): void {
    this.assertLive();
    const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.round(n))) : 0;
    this.layout = { sidebarWidth: clamp(layout.sidebarWidth), top: clamp(layout.top), left: clamp(layout.left), bottom: clamp(layout.bottom), hideBrowser: layout.hideBrowser === true };
    this.applyLayout();
  }

  async dispose(): Promise<void> {
    if (this.disposed||this.disposing) return;
    this.disposing = true;
    let failure: unknown;
    try { await this.cancelControlVisuals(); } catch(error) {failure=error;}
    try { await this.cancelScroll(); } catch (error) { failure = error; }
    try { if(!this.quitPrepared) await this.persistProfiles(true); } catch (error) { this.disposing=false;throw error; }
    this.disposed=true;
    this.window.removeListener('resize', this.resize);
    this.agentHost?.removeListener('resize',this.resize);
    for (const entry of [...this.tabs.values()]) this.destroyTab(entry);
    for (const [id, ses] of this.sessions) {
      ses.removeListener('will-download', this.receiveDownload);
      if (id.startsWith('sidework-goal-') || this.profiles.find(p => p.id === id)?.incognito) {
        await ses.clearStorageData();
        await ses.clearCache();
      } else ses.flushStorageData();
    }
    this.sessions.clear();
    if (failure) throw failure;
  }

  private async persistProfiles(force = false): Promise<void> {
    const profiles = this.profiles.filter(p => !p.incognito);
    const activeProfileId = profiles.some(p => p.id === this.activeProfileId) ? this.activeProfileId : 'default';
    const payload = JSON.stringify({ profiles, activeProfileId });
    const normal = [...this.tabs.values()].filter(t => !t.sessionPartition && profiles.some(p => p.id === t.state.profileId) && t.state.url.length <= 4096 && isAllowedURL(t.state.url)).slice(0, 100);
    const selected = activeProfileId === this.activeProfileId ? this.activeTabId : this.selectedTabs.get(activeProfileId);
    const sessionPayload = JSON.stringify({ version: 1, activeProfileId, activeTabIndex: Math.max(0, normal.findIndex(t => t.state.id === selected)), tabs: normal.map(t => ({ profileId: t.state.profileId, url: t.state.url })), closedTabs: this.closedTabs.filter(t => profiles.some(p => p.id === t.profileId) && t.url.length <= 4096 && isAllowedURL(t.url)).slice(-20) });
    // DOM revisions, loading/title changes and observations are not session metadata.
    // Avoid queueing duplicate URL snapshots; dispose still forces a final write/flush.
    const snapshot = `${payload}\n${sessionPayload}`;
    if (!force && !this.disposed && !this.persistenceError && snapshot === this.persistSnapshot) {
      await this.persistTail;
      if (this.persistenceError) throw this.persistenceError;
      return;
    }
    this.persistSnapshot = snapshot;
    this.persistTail = this.persistTail.then(async () => {
      const path = join(this.dataRoot, 'browser-profiles.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, path);
      const sessionPath = join(this.dataRoot, 'browser-session.json');
      const sessionTemporary = `${sessionPath}.${randomUUID()}.tmp`;
      await writeFile(sessionTemporary, sessionPayload, { mode: 0o600 });
      await rename(sessionTemporary, sessionPath);
      this.persistenceError = null;
    }).catch(() => { this.persistenceError = new Error('Could not save browser profiles'); });
    await this.persistTail;
    if (this.persistenceError) throw this.persistenceError;
  }

  private active(): TabEntry {
    this.assertLive();
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (!tab || tab.state.profileId !== this.activeProfileId || (tab.view?.webContents.isDestroyed() ?? false)) throw new Error('No active browser target');
    return tab;
  }

  private assertLive(): void { if (this.disposed||this.disposing) throw new Error('Browser controller disposed or closing'); }

  private assertExecution(context:ExecutionContext):void {
    this.assertLive();
    if(this.cancelledVisualJobs.has(context.jobId)) throw new Error('Execution cancelled');
    if(this.allowExecution && this.allowExecution(context)!==true) throw new Error('Execution lease cancelled or no longer running');
  }

  private inputDebugger(entry:TabEntry) {
    const debug=this.materialize(entry).webContents.debugger;
    if(debug.isAttached()) {
      if(!entry.debuggerOwned) throw new Error('Computer input blocked: debugger/DevTools already attached by another owner');
      return debug;
    }
    entry.debuggerOwned=false;
    try {debug.attach('1.3');} catch {throw new Error('Computer input blocked: owned debugger unavailable');}
    entry.debuggerOwned=true;
    debug.once('detach',()=>{entry.debuggerOwned=false;entry.frameId=undefined;});
    return debug;
  }

  private async captureFrame(entry:TabEntry, context:BrowserContext, snapshot:DOMSnapshot, remember=true):Promise<ScreenFrame> {
    if(entry.visible!==true) throw new Error('Browser capture target is hidden');
    const metadata=snapshot.computer;
    if(!metadata || metadata.captureBlocked!==false) throw new Error('Sensitive or unknown page capture prohibited');
    if(snapshot.url==='about:blank') throw new Error('Blank homepage has no native screenshot');
    if(!isSafeNavigation(snapshot.url,snapshot.url)) throw new Error('Sensitive page URL capture prohibited');
    const {viewportWidth,viewportHeight}=metadata;
    if(!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth<=0 || viewportHeight<=0 || viewportWidth>30000 || viewportHeight>30000) throw new Error('Invalid viewport');
    const revision=entry.state.revision;
    const wc=this.materialize(this.target(context)).webContents;
    // Caret blinking/host approval focus is not a document change. Normalize only
    // the insertion caret while capturing, then restore it even on failure.
    // DOM revision, content pixels, target, geometry and sensitive checks remain strict.
    let caretStyle:string|undefined;
    let image:NativeImage;
    try {
      await wc.executeJavaScriptInIsolatedWorld(1001,[{code:controlVisualCaptureScript(true)}]);
      caretStyle=await wc.insertCSS('*, *::before, *::after { caret-color: transparent !important; }',{cssOrigin:'user'});
      image=await wc.capturePage();
    } finally {
      try {if(caretStyle!==undefined) await wc.removeInsertedCSS(caretStyle);}
      finally {await wc.executeJavaScriptInIsolatedWorld(1001,[{code:controlVisualCaptureScript(false)}]);}
    }
    validateTarget({...this.target(context).state,tabId:entry.state.id},{...context,expectedRevision:revision});
    if(image.isEmpty()) throw new Error('Screenshot capture was empty');
    let {width,height}=image.getSize();
    if(!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width<=0 || height<=0) throw new Error('Invalid capture dimensions');
    const scale=Math.min(1,1280/width,900/height);
    if(scale<1) {width=Math.max(1,Math.floor(width*scale));height=Math.max(1,Math.floor(height*scale));image=image.resize({width,height,quality:'good'});}
    const bytes=image.toPNG({scaleFactor:1});
    if(!bytes.length || bytes.length>4*1024*1024) throw new Error('Screen capture exceeds image limit');
    const after=await wc.executeJavaScriptInIsolatedWorld(1001,[{code:observationScript()}]) as DOMSnapshot;
    validateTarget({...this.target(context).state,tabId:entry.state.id},{...context,expectedRevision:revision});
    if(after.stamp!==snapshot.stamp || JSON.stringify(after.computer)!==JSON.stringify(metadata)) throw new Error('Stale document or viewport during capture');
    const safeLinks=metadata.links.slice(0,120).filter(link=>isSafeNavigation(snapshot.url,link.url) && [link.x,link.y,link.width,link.height].every(Number.isFinite) && link.x>=0 && link.y>=0 && link.width>0 && link.height>0 && link.x+link.width<=viewportWidth && link.y+link.height<=viewportHeight).map(link=>({...link,x:link.x*width/viewportWidth,y:link.y*height/viewportHeight,width:link.width*width/viewportWidth,height:link.height*height/viewportHeight}));
    const frameId=createHash('sha256').update(bytes).update(JSON.stringify([{profileId:context.profileId,tabId:context.tabId},revision,snapshot.stamp,entry.geometry,width,height,viewportWidth,viewportHeight,safeLinks])).digest('hex');
    if(remember) entry.frameId=frameId;
    return {frameId,width,height,viewportWidth,viewportHeight,pngBase64:bytes.toString('base64'),safeLinks};
  }

  private target(context: BrowserContext): TabEntry {
    this.assertLive();
    const entry=this.tabs.get(context.tabId);
    const agent=!!entry?.state.agentAreaId && !!this.agentHost && !this.agentHost.isDestroyed() && this.agentPaneTabIds.includes(context.tabId) && !!entry.view && entry.visible===true;
    if (!entry || entry.state.profileId!==context.profileId || context.profileId!==this.activeProfileId || (!agent && (entry.state.agentAreaId || !this.paneTabIds.includes(context.tabId))) || entry.view?.webContents.isDestroyed()) throw new Error('Browser target changed or hidden');
    return entry;
  }

  async setSplitCount(count: SplitCount): Promise<void> {
    this.assertLive();
    if (![1,2,4,8].includes(count)) throw new Error('Invalid split count');
    const ids=this.paneTabIds.filter(id=>this.tabs.get(id)?.state.profileId===this.activeProfileId);
    const selected=this.activeTabId;
    if(selected && !ids.includes(selected)) ids.unshift(selected);
    if(selected && ids.indexOf(selected)>=count) {ids.splice(ids.indexOf(selected),1);ids.unshift(selected);}
    while(ids.length<count) {
      const reusable=[...this.tabs.values()].find(entry=>!entry.state.agentAreaId && entry.state.profileId===this.activeProfileId && !ids.includes(entry.state.id));
      if(reusable) {ids.push(reusable.state.id);continue;}
      const id=randomUUID();
      this.tabs.set(id,{state:{id,profileId:this.activeProfileId,url:'about:blank',title:'새 탭',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'dormant'}});
      ids.push(id);
    }
    this.splitCount=count;
    this.paneTabIds=ids.slice(0,count);
    for(const id of this.paneTabIds) {const entry=this.tabs.get(id)!;if(entry.state.url!=='about:blank') this.materialize(entry);}
    this.applyLayout();this.onChange();
  }

  private applyLayout(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    const {width,height}=this.window.getContentBounds();
    const rectangles=paneLayout(this.splitCount,{width,height,...this.layout});
    const host=this.agentHost;
    const agentRectangles=host&&!host.isDestroyed()?paneLayout(this.agentSplitCount(),{...host.getContentBounds(),...this.agentLayout}):[];
    for(const entry of this.tabs.values()) {
      const agent=!!entry.state.agentAreaId;
      const rectangle=agent?agentRectangles[this.agentSlots.get(entry.state.id)??-1]:rectangles[this.paneTabIds.indexOf(entry.state.id)];
      const visible=!!rectangle && (agent || entry.state.profileId===this.activeProfileId) && entry.state.url!=='about:blank' && (agent?!this.agentLayout.hideBrowser:(!this.layout.hideBrowser || this.splitCount>1)) && rectangle.width>0 && rectangle.height>0;
      entry.visible=visible;
      if(!visible) {const visual=this.controlVisuals.get(entry.state.id);if(visual) void this.cancelControlVisuals(visual.jobId).catch(()=>{});}
      if(!entry.view) continue;
      const geometry=JSON.stringify([visible,rectangle]);
      const tracked=entry as TabEntry & {geometry?:string};
      if(tracked.geometry!==geometry) {entry.state.revision++;tracked.geometry=geometry;}
      entry.view.setVisible(visible);
      if(visible) entry.view.setBounds(rectangle!);
    }
  }

  private destroyTab(entry: TabEntry): void {
    const visual=this.controlVisuals.get(entry.state.id);if(visual) void this.cancelControlVisuals(visual.jobId).catch(()=>{});
    this.tabs.delete(entry.state.id);
    this.agentPaneTabIds=this.agentPaneTabIds.filter(id=>id!==entry.state.id);
    this.agentSlots.delete(entry.state.id);
    if(!this.agentPaneTabIds.length)this.agentGridCount=2;
    const slot=this.paneTabIds.indexOf(entry.state.id);
    if(!this.disposed && this.splitCount>1 && slot>=0) {
      const id=randomUUID();
      this.tabs.set(id,{state:{id,profileId:entry.state.profileId,url:'about:blank',title:'새 탭',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'dormant'}});
      this.paneTabIds[slot]=id;
    } else this.paneTabIds=this.paneTabIds.filter(id=>id!==entry.state.id);
    if (!entry.view) return;
    const wc=entry.view.webContents;
    if(entry.debuggerOwned && wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try {wc.debugger.detach();} catch { /* Only release our attachment; destruction still proceeds. */ }
      entry.debuggerOwned=false;
    }
    const host=entry.state.agentAreaId?this.agentHost:this.window;
    if (host&&!host.isDestroyed()) host.contentView.removeChildView(entry.view);
    if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
  }
}