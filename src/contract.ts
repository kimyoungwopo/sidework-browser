// Shared wire contract. No Electron/React dependencies. Parent owns this file.
import type { GoalTask } from './goal-contract';
export type PermissionMode = 'read-only' | 'guard';
export type JobStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'unknown';
export interface Profile { id: string; name: string; incognito: boolean }
export interface BrowserTab { id: string; profileId: string; title: string; url: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean; ownership: 'user' | 'agent'; revision: number; error?: string; lifecycle?: 'live' | 'dormant';agentAreaId?:string }
export type SplitCount = 1 | 2 | 4 | 8;
export interface BrowserDownload {id:string;profileId:string;tabId:string;filename:string;sourceOrigin:string;state:BrowserDownloadState;receivedBytes:number;totalBytes:number|null;startedAt:string;error:string|null}
export type BrowserDownloadState = 'progressing'|'completed'|'cancelled'|'interrupted'|'blocked';
export interface BrowserState { profiles: Profile[]; activeProfileId: string; tabs: BrowserTab[]; activeTabId: string | null; closedTabCount?: number; splitCount?: SplitCount; paneTabIds?: string[];agentPaneTabIds?:string[] }
export interface Settings { permissionMode: PermissionMode; provider: 'codex'; model: string; memoryEnabled: boolean; maxSteps: number; confirmMutations: true }
export const DEFAULT_SETTINGS: Settings = { permissionMode: 'guard', provider: 'codex', model: '', memoryEnabled: false, maxSteps: 10, confirmMutations: true };
export interface BrowserContext { profileId: string; tabId: string }
export interface PagePreview {profileId:string;tabId:string;revision:number;imageDataUrl:string|null;error?:string}
export type ControlPhase = 'working'|'awaiting_approval'|'moving'|'clicking'|'typing'|'scrolling';
export interface PageControlState extends BrowserContext {state:'reclaiming'|'user'|'unknown'}
export interface PaneControlVisual extends BrowserContext {jobId:string;phase:ControlPhase;x?:number;y?:number}
export interface ObservedElement { ref: string; tag: string; role: string; name: string; inputType: string; sensitive: boolean;interaction?:{kind:'local'|'input'|'navigation'|'search'|'consequential'|'unknown';url?:string;submission?:{kind:'naver-native-get';method:'get';url:'https://search.naver.com/search.naver'};binding?:{kind:'label-submit';labelFor:string;controlId:string;controlType:'submit';method:'get'}} }
export interface SafeScreenLink { x:number; y:number; width:number; height:number; url:string }
export interface ScreenFrame { frameId:string; width:number; height:number; viewportWidth:number; viewportHeight:number; pngBase64:string; safeLinks:SafeScreenLink[] }
export interface ReadingViewport {documentId:string;scrollY:number;height:number;scrollHeight:number;text:string}
export interface PageReadingEvidence extends BrowserContext {url:string;documentId:string;sections:{scrollY:number;text:string}[];complete:boolean;stopReason:'bottom'|'limit'}
export interface Observation extends BrowserContext { documentId?:string;observationMode?:'search-form'; revision: number; url: string; title: string; text: string; elements: ObservedElement[]; capturedAt: string; screen?:ScreenFrame;readingViewport?:ReadingViewport }
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'open_tab'; url: string }
  | { type: 'click'; ref: string }
  | { type: 'submit_search'; ref: string }
  | { type: 'fill'; ref: string; value: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'observe' }
  | { type: 'screenshot' }
  | ComputerAction;
export type ComputerKey = 'Tab' | 'Enter' | 'Escape' | 'Backspace' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Space';
export type ComputerAction = {type:'computer_click';x:number;y:number;frameId:string} | {type:'computer_type';value:string;frameId:string} | {type:'computer_key';key:ComputerKey;frameId:string};
export type AgentAction = BrowserAction | {type:'read_page';maxScreens:number} | { type: 'finish'; text: string };
export interface PlanStep { thought: string; action: AgentAction }
export interface Artifact { id: string; kind: 'screenshot'; name: string; path: string; createdAt: string }
export interface BrowserActionResult { context: BrowserContext; message: string; artifact?: Artifact }
export interface ExecutionContext extends BrowserContext { expectedRevision: number; jobId: string; smoothScroll?:boolean }
export interface BrowserPort {
  observe(context: BrowserContext, options?: {computerUse?:boolean;shareScreen?:boolean;jobId?:string}): Promise<Observation>;
  execute(action: BrowserAction, context: ExecutionContext): Promise<BrowserActionResult>;
}
export interface JobEvent { id: string; at: string; kind: 'status' | 'thought' | 'action' | 'observation' | 'approval' | 'error'; text: string }
export interface PendingApproval { id: string; action: BrowserAction; digest: string; context: BrowserContext; revision: number; expiresAt: string; summary: string }
export interface InitialDocument { url:string;revision:number;documentId?:string }
export interface AgentScope {areaId:string;origin:string;expiresAt:string;goalId?:string;allowedOrigins?:string[]}
export interface SectionTask { tabId:string;expectedRevision:number;expectedUrl:string;prompt:string }
export interface TaskInput { prompt:string;profileId:string;tabId:string;computerUse?:boolean;shareScreen?:boolean;initialDocument?:InitialDocument;executionEpoch?:number;agentScope?:AgentScope }
export interface Job { id: string; prompt: string; profileId: string; tabId: string; status: JobStatus; createdAt: string; updatedAt: string; events: JobEvent[]; artifacts: Artifact[]; answer: string | null; error: string | null; approval: PendingApproval | null; steps: number;computerUse?:boolean;shareScreen?:boolean;synchronizedScroll?:boolean;initialDocument?:InitialDocument;executionEpoch?:number;agentScope?:AgentScope }
export interface MemoryEntry { id: string; text: string; createdAt: string }
export interface CoreSnapshot { jobs: Job[]; activeJobId: string | null; settings: Settings; memory: MemoryEntry[];activeJobIds?:string[] }
export interface PlannerInput { prompt: string; observation: Observation; history: JobEvent[]; settings: Settings; memory: MemoryEntry[]; signal: AbortSignal;computerUse?:boolean;jobId?:string;synchronizeFirstScroll?:boolean;pageReading?:PageReadingEvidence;agentAutomation?:boolean }
export interface Planner { next(input: PlannerInput): Promise<PlanStep> }
export interface ProviderStatus { installed: boolean; authenticated: boolean; liveVerified: boolean; detail: string }
export interface ProviderActivity {running:number;waiting:number;limit:number;reason?:string}
export interface CodexDesktopStatus {installed:boolean;detail:string;version?:string;targetReady:boolean}
export interface CodexDesktopHandoff {requestId:string;status:'requested';requestedAt:string;paneIndex:number}
export interface ResourceProcess { pid: number; role: string; workingSetKB: number; peakWorkingSetKB: number; cpuPercent: number }
export interface ResourceSample { sampledAt: string; processes: ResourceProcess[]; tabs: number; liveTabs: number; dormantTabs: number; processUptimeAtBrowserReadyMs: number | null; processUptimeAtAgentReadyMs: number | null; caveat: string }
export interface AppState extends BrowserState, CoreSnapshot { providerStatus: ProviderStatus; browserReady: boolean; bridgeReady: boolean; agentConnecting: boolean; diagnostics?: ResourceSample;providerActivity?:ProviderActivity;downloads?:BrowserDownload[];controlVisuals?:PaneControlVisual[];pageControls?:PageControlState[];pagePreviews?:PagePreview[];codexDesktop?:CodexDesktopStatus;codexDesktopHandoff?:CodexDesktopHandoff;surface?:'browser'|'agent';agentTabs?:BrowserTab[];goalTasks?:GoalTask[]; error: string | null; appVersion: string }
export type AppCommand =
  | {type:'goals.start';prompt:string}
  | {type:'goals.cancel';goalId:string}
  | {type:'agents.show'}
  | {type:'agents.start';tabId:string;prompt:string;computerUse?:boolean;shareScreen?:boolean;expectedUrl?:string;expectedRevision?:number}
  | {type:'agents.startSections';tasks:SectionTask[];consent:true}
  | {type:'tab.preview';profileId:string;tabId:string}
  | {type:'tab.takeControl';profileId:string;tabId:string}
  | {type:'downloads.cancel';downloadId:string}
  | {type:'downloads.reveal';downloadId:string}
  | {type:'codexDesktop.check'}
  | {type:'codexDesktop.handoff';tabId:string;expectedRevision:number;expectedUrl:string;prompt:string;consent:true}
  | { type: 'tab.new'; url?: string }
  | { type: 'tab.activate'; tabId: string }
  | { type: 'tab.close'; tabId: string }
  | { type: 'tab.restore' }
  | { type: 'tab.navigate'; url: string;tabId?:string }
  | {type:'workspace.split';count:SplitCount}
  | { type: 'tab.back' }
  | { type: 'tab.forward' }
  | { type: 'tab.reload' }
  | { type: 'profile.create'; name: string; incognito?: boolean }
  | { type: 'profile.activate'; profileId: string }
  | { type: 'job.start'; prompt: string;tabId?:string;computerUse?:boolean;shareScreen?:boolean }
  | {type:'jobs.startVisible';prompt:string;shareScreen:true;computerUse?:boolean;synchronizedScroll?:boolean}
  | {type:'jobs.startSections';tasks:SectionTask[];consent:true}
  | {type:'jobs.cancelAll'}
  | { type: 'job.cancel'; jobId: string }
  | { type: 'job.approve'; jobId: string; approvalId: string; allow: boolean }
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'memory.add'; text: string }
  | { type: 'memory.remove'; id: string }
  | { type: 'provider.check' }
  | { type: 'agent.connect' }
  | { type: 'diagnostics.refresh' }
  | { type: 'artifact.open'; jobId: string; artifactId: string }
  | { type: 'layout.set'; sidebarWidth: number; top: number; left: number; bottom: number; hideBrowser: boolean };
export interface AppBridge { getState(): Promise<AppState>; dispatch(command: AppCommand): Promise<AppState>; onState(listener: (state: AppState) => void): () => void }
export type BridgeCommand =
  | {type:'goal.plan';goalId:string;prompt:string}
  | {type:'goal.cancelPlan';goalId:string}
  | { type: 'start'; input: TaskInput }
  | {type:'startTogether';inputs:TaskInput[]}
  | {type:'startBatch';inputs:TaskInput[]}
  | {type:'cancelAll'}
  | { type: 'cancel'; jobId: string }
  | { type: 'approve'; jobId: string; approvalId: string; allow: boolean }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'memory.add'; text: string }
  | { type: 'memory.remove'; id: string };
export type WorkerToMain =
  | { kind: 'ready' }
  | { kind: 'snapshot'; snapshot: CoreSnapshot }
  | { kind: 'response'; id: string; ok: boolean; error?: string; value?: unknown }
  | { kind: 'browser.request'; id: string; operation: 'observe'; context: BrowserContext;jobId?:string;computerUse?:boolean;shareScreen?:boolean }
  | { kind: 'browser.request'; id: string; operation: 'execute'; context: ExecutionContext; action: BrowserAction }
  | { kind: 'provider.verified' }
  | {kind:'provider.activity';activity:ProviderActivity};
export type MainToWorker =
  | { kind: 'init'; dataRoot: string; codexPath: string | null;maxPlannerProcesses?:number }
  | { kind: 'command'; id: string; command: BridgeCommand }
  | { kind: 'browser.response'; id: string; ok: boolean; value?: Observation | BrowserActionResult; error?: string }
  | { kind: 'shutdown' };
