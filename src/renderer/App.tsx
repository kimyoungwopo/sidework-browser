import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Check, CheckCircle2, ChevronDown, Clock3, ExternalLink, FileText, Globe2, History, LoaderCircle, LockKeyhole, MessageSquare, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Trash2, UserRound, X } from 'lucide-react';
import type { AppBridge, AppCommand, AppState, BrowserDownload, BrowserTab, Job, JobStatus, PendingApproval, SectionTask, SplitCount } from '../contract';
import { agentStatus, browserLayout, panelConnectionCommand, readiness, resourceSummary, shouldSubmitComposer, tabNavigationIndex } from './behavior';
import AgentArea from './AgentArea';
import GoalTasks, { goalStatusNames, goalWorking } from './GoalTasks';
import './styles.css';
import './aside-shell.css';
import './goal-tasks.css';

declare global { interface Window { sidework?: AppBridge } }
type Panel = 'assistant' | 'history' | 'settings' | 'profiles' | 'codexDesktop' | 'sections' | 'downloads' | 'spaces';
const statusNames: Record<JobStatus, string> = { queued: '대기 중', running: '진행 중', awaiting_approval: '승인 필요', completed: '완료', cancelled: '취소됨', failed: '실패', interrupted: '중단됨', unknown: '결과 확인 필요' };
type Dispatch = (command: AppCommand) => Promise<boolean>;

function PageTakeover({state,tab,label,statusLabel,dispatch}:{state:AppState|null;tab?:BrowserTab;label:string;statusLabel:string;dispatch:Dispatch}){
 const [pending,setPending]=useState(false),flight=useRef(false);
 if(!state||!tab||tab.profileId!==state.activeProfileId)return null;
 const control=state.pageControls?.find(control=>control.profileId===tab.profileId&&control.tabId===tab.id);
 const busy=state.jobs.some(job=>job.profileId===tab.profileId&&['queued','running','awaiting_approval'].includes(job.status));
 if(!busy&&!control)return null;
 const disabled=pending||!state.browserReady||!busy||control?.state==='reclaiming';
 const run=async()=>{if(disabled||flight.current)return;flight.current=true;setPending(true);try{await dispatch({type:'tab.takeControl',profileId:tab.profileId,tabId:tab.id});}finally{flight.current=false;setPending(false);}};
 return <><button type="button" className="takeover-button" aria-label={label} title={label} disabled={disabled} onClick={()=>void run()}><UserRound size={13}/><span>직접 사용</span></button>{control&&<span className="control-badge" aria-label={statusLabel} aria-live="polite" title="기존 작업은 자동 재개하지 않습니다. 새 요청과 화면 공유 동의가 필요합니다.">{{reclaiming:'제어권 회수 중',user:'직접 사용 중',unknown:'중지 확인 필요'}[control.state]}</span>}</>;
}

function ControlBadge({ state, tab, label, fallback = null }: { state: AppState | null; tab?: BrowserTab; label: string; fallback?: ReactNode }) {
  if (!state || !tab || tab.profileId !== state.activeProfileId) return fallback;
  if(state.pageControls?.some(control=>control.profileId===tab.profileId&&control.tabId===tab.id))return null;
  const activeIds = state.activeJobIds ?? (state.activeJobId ? [state.activeJobId] : []);
  const job = state.jobs.find(item => activeIds.includes(item.id) && item.tabId === tab.id && item.profileId === tab.profileId && ['running', 'awaiting_approval'].includes(item.status));
  const visual = state.controlVisuals?.find(item => item.tabId === tab.id && item.profileId === tab.profileId && item.jobId === job?.id);
  if (!visual || !job || (job.status === 'awaiting_approval') !== (visual.phase === 'awaiting_approval')) return fallback;
  const phases = { working: 'AI 판단 중', awaiting_approval: '승인 대기', moving: '이동 중', clicking: '클릭 중', typing: '입력 중', scrolling: '스크롤 중' };
  const text = phases[visual.phase];
  const acting = visual.phase !== 'working' && visual.phase !== 'awaiting_approval';
  return <span className="control-badge" data-control-phase={visual.phase} title={acting ? `AI 제어 중 · ${text}` : text} aria-label={label} aria-live="polite" aria-atomic={true}>{text}</span>;
}

// A conservative UI gate only; the main process revalidates the exact document.
function publicSectionUrl(value: string): boolean {
  try {
    if (value.length > 4096) return false;
    const url = new URL(value);
    if ([...url.searchParams.keys()].some(key => /token|secret|password|session|credential|^(?:code|state|key|api_key|otp)$/i.test(key)) || /(?:token|secret|password|session|credential|code|api_key)\s*=/i.test(decodeURIComponent(url.hash))) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.')) return false;
    if (host.includes(':') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if ([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return false;
    }
    return true;
  } catch { return false; }
}

function IconButton({ label, children, onClick, disabled = false, selected = false, className = '' }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; selected?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${selected ? 'selected' : ''} ${className}`} title={label} aria-label={label} aria-pressed={selected || undefined} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SpaceTile({ state, tab, index, dispatch, onInspect }: { state: AppState; tab: BrowserTab; index: number; dispatch: Dispatch; onInspect: (job: Job) => void }) {
  const [refreshing, setRefreshing] = useState(false), flight = useRef(false);
  const [brokenImage, setBrokenImage] = useState<string | null>(null);
  const preview = (state.pagePreviews ?? []).find(item => item.profileId === state.activeProfileId && item.profileId === tab.profileId && item.tabId === tab.id && item.revision === tab.revision);
  const candidate = preview?.imageDataUrl;
  const image = !preview?.error && typeof candidate === 'string' && candidate.length <= 3_000_000 && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(candidate) && candidate.slice(22).length % 4 === 0 && brokenImage !== candidate ? candidate : null;
  const refresh = async () => {
    if (!state.browserReady || flight.current) return;
    flight.current = true; setRefreshing(true); setBrokenImage(null);
    try { await dispatch({ type: 'tab.preview', profileId: tab.profileId, tabId: tab.id }); }
    finally { flight.current = false; setRefreshing(false); }
  };
  let domain = '새 탭';
  try { domain = new URL(tab.url).hostname || '새 탭'; } catch { /* Invalid URLs have no domain. */ }
  const pageJobs = state.jobs.filter(job => job.profileId === tab.profileId && job.tabId === tab.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt));
  const job = pageJobs.find(item => ['queued','running','awaiting_approval'].includes(item.status)) ?? pageJobs[0];
  const busy = Boolean(job && ['queued','running','awaiting_approval'].includes(job.status));
  const control = state.pageControls?.find(item => item.profileId === tab.profileId && item.tabId === tab.id);
  const [stopping, setStopping] = useState(false), stopFlight = useRef(false);
  const stop = async () => {
    if (!busy || !job || !state.bridgeReady || stopFlight.current) return;
    stopFlight.current = true; setStopping(true);
    try { await dispatch({ type: 'job.cancel', jobId: job.id }); }
    finally { stopFlight.current = false; setStopping(false); }
  };
  return <section className={`space-tile ${tab.id === state.activeTabId ? 'is-selected' : ''}`} data-space-tab={tab.id} aria-label={`작업 화면 ${index + 1}`}>
    <div className="space-window-bar"><Globe2 size={12}/><span>{domain}</span><span>{tab.id === state.activeTabId ? '선택됨' : '열린 화면'}</span></div>
    <div className="space-preview">{image ? <img src={image} alt={`${tab.title || '새 탭'} 현재 페이지 미리보기`} onError={() => setBrokenImage(image)}/> : <span>미리보기 새로고침</span>}</div>
    <div className="space-details"><h3>화면 {index + 1} · {tab.title || '새 탭'}</h3><p className="space-request">{job?.prompt ?? '직접 탐색 · 요청한 AI 작업이 없습니다.'}</p><div className="space-state" aria-label={`작업 화면 ${index + 1} 상태`}><span className={`status-dot ${job?.status ?? ''}`}/><span>{job ? `${statusNames[job.status]} · ${job.steps}단계` : '직접 탐색'}</span><ControlBadge state={state} tab={tab} label={`작업 화면 ${index + 1} AI 제어 상태`}/></div><div className="space-actions"><button className="secondary-button" aria-label={`작업 화면 ${index + 1} 열기`} disabled={!state.browserReady} onClick={() => void dispatch({ type: 'tab.activate', tabId: tab.id })}>화면 열기<ArrowRight size={12}/></button>{job && <button className="secondary-button" aria-label={`작업 화면 ${index + 1} 작업 보기`} onClick={() => onInspect(job)}>작업 보기</button>}{busy && <button className="secondary-button" aria-label={`작업 화면 ${index + 1} 작업 중지`} disabled={!state.bridgeReady || stopping} onClick={() => void stop()}><Square size={11}/>이 화면 중지</button>}{(busy || control) && <PageTakeover state={state} tab={tab} label={`작업 화면 ${index + 1} 직접 사용`} statusLabel={`작업 화면 ${index + 1} 제어권 상태`} dispatch={dispatch}/>}</div><button className="space-refresh" aria-label={`작업 화면 ${index + 1} 미리보기 새로고침`} disabled={!state.browserReady || refreshing} onClick={() => void refresh()}><RefreshCw size={12} className={refreshing ? 'spin' : ''}/>{refreshing ? '캡처 중' : '미리보기 새로고침'}</button>{preview?.error && <p className="space-preview-error" role="status">{preview.error} · 다시 새로고침하세요.</p>}</div>
  </section>;
}

function DownloadRow({download,dispatch}:{download:BrowserDownload;dispatch:Dispatch}){
  const [pending,setPending]=useState(false),flight=useRef(false);
  const run=async(type:'downloads.cancel'|'downloads.reveal')=>{
    if(flight.current)return;flight.current=true;setPending(true);
    try{await dispatch({type,downloadId:download.id});}finally{flight.current=false;setPending(false);}
  };
  const names:Record<BrowserDownload['state'],string>={progressing:'진행 중',completed:'완료',cancelled:'취소됨',interrupted:'중단됨',blocked:'차단됨'};
  const bytes=download.totalBytes!==null&&download.totalBytes>0?`${download.receivedBytes} B / ${download.totalBytes} B`:`${download.receivedBytes} B · 전체 크기 알 수 없음`;
  return <li className="download-row" aria-label={download.filename}><div className="download-info"><strong>{download.filename}</strong><p>{names[download.state]} · {bytes}</p><span className="download-origin">{download.sourceOrigin}</span>{download.error&&<p className="download-error" role="alert">{download.error}</p>}</div><div className="download-actions">{download.state==='progressing'&&<button className="secondary-button" aria-label="다운로드 취소" disabled={pending} onClick={()=>void run('downloads.cancel')}>다운로드 취소</button>}{download.state==='completed'&&<button className="secondary-button" aria-label="폴더에서 보기" disabled={pending} onClick={()=>void run('downloads.reveal')}>폴더에서 보기</button>}</div></li>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('assistant');
  const [panelOpen, setPanelOpen] = useState(false);
  const [width, setWidth] = useState(window.innerWidth);
  const [address, setAddress] = useState('');
  const [homeMode, setHomeMode] = useState<'search' | 'ask'>('search');
  const homeSearch=useRef<HTMLInputElement>(null),homeRequest=useRef<HTMLTextAreaElement>(null),homeFocusRequested=useRef(false);
  const selectHomeMode=(mode:'search'|'ask')=>{if(mode===homeMode){(mode==='search'?homeSearch.current:homeRequest.current)?.focus();return;}homeFocusRequested.current=true;setHomeMode(mode);};
  useEffect(()=>{if(homeFocusRequested.current){homeFocusRequested.current=false;(homeMode==='search'?homeSearch.current:homeRequest.current)?.focus();}},[homeMode]);
  const [prompt, setPrompt] = useState('');
  const [sectionConsentScope, setSectionConsentScope] = useState<string | null>(null);
  const sectionFlights = useRef(new Map<string, string>());
  const [pendingSections, setPendingSections] = useState<string[]>([]);
  const usedSectionConsent = useRef<string | null>(null);
  const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
  const [desktopConsentScope, setDesktopConsentScope] = useState<string | null>(null);
  const [taskMode, setTaskMode] = useState<'dom' | 'computer'>('dom');
  const [targetTabId, setTargetTabId] = useState<string | null>(null);
  const [shareScreen, setShareScreen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const flight = useRef(new Set<string>());
  const seenApprovals = useRef(new Set<string>());
  const composer = useRef<HTMLTextAreaElement>(null);
  const layoutQueue = useRef(Promise.resolve());
  const dispatch = useCallback<Dispatch>(async command => {
    const bridge = window.sidework;
    if (!bridge) { setError('앱 연결을 사용할 수 없습니다. Sidework 데스크톱 앱에서 다시 열어 주세요.'); return false; }
    const key = command.type === 'agents.startSections' ? `agents.startSections:${command.tasks.map(task => task.tabId).sort().join('|')}` : command.type === 'agents.start' || command.type === 'tab.navigate' ? `${command.type}:${command.tabId ?? 'active'}` : command.type === 'goals.cancel' ? `${command.type}:${command.goalId}` : command.type === 'job.cancel' || command.type === 'job.approve' ? `${command.type}:${command.jobId}` : command.type==='downloads.cancel'||command.type==='downloads.reveal'?`${command.type}:${command.downloadId}` : command.type==='tab.takeControl'||command.type==='tab.preview'?`${command.type}:${command.profileId}:${command.tabId}` : command.type;
    if (flight.current.has(key)) return false;
    flight.current.add(key);
    if (key !== 'layout.set') setPending(true);
    if (command.type === 'tab.navigate' || key === 'tab.back' || key === 'tab.forward' || key === 'tab.reload') setError(null);
    try { const next = await bridge.dispatch(command); setState(next); if (next.error) { setError(next.error); return false; } return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.'); return false; }
    finally { flight.current.delete(key); setPending([...flight.current].some(item => item !== 'layout.set')); }
  }, []);

  const openPanel = useCallback((next: Panel) => {
    setPanel(next); setPanelOpen(true);
    if (next === 'assistant') { setSelectedJobId(null); setSelectedGoalId(null); }
    const command = (next === 'codexDesktop' || next === 'downloads' || next === 'spaces') ? null : next === 'sections' ? { type: 'agent.connect' } as const : panelConnectionCommand(next);
    if (command) void dispatch(command);
  }, [dispatch]);

  useEffect(() => {
    const bridge = window.sidework;
    if (!bridge) { setError('데스크톱 연결 없음 · 브라우저 미리보기에서는 실제 탐색과 AI 작업을 사용할 수 없습니다.'); return; }
    let disposed = false;
    let received = false;
    const unsubscribe = bridge.onState(next => { received = true; if (!disposed) setState(next); });
    void bridge.getState().then(next => { if (!disposed && !received) setState(next); }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : '앱 상태를 불러오지 못했습니다. 앱을 다시 실행해 주세요.'); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  useEffect(() => { const resize = () => setWidth(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const agentSurface = state?.surface === 'agent';
  const downloads=state?.downloads?.filter(download=>download.profileId===state.activeProfileId)??[];
  const tab = state?.tabs.find(item => item.id === state.activeTabId);
  const splitCount = state?.splitCount ?? 1;
  const panes = (state?.paneTabIds ?? (state?.activeTabId ? [state.activeTabId] : [])).slice(0, splitCount).map(id => state?.tabs.find(item => item.id === id && item.profileId === state.activeProfileId));
  const layout = browserLayout(width, tab?.url, panelOpen, splitCount);
  const hasState = state !== null;
  useEffect(() => {
    if (!hasState || agentSurface) return;
    let superseded = false;
    // Serialize native bounds updates; rapid resizes must not drop the last one.
    layoutQueue.current = layoutQueue.current.then(async () => {
      if (!superseded) await dispatch(browserLayout(width, tab?.url, panelOpen, splitCount));
    });
    return () => { superseded = true; };
  }, [dispatch, width, tab?.url, hasState, panelOpen, splitCount, agentSurface]);
  useEffect(() => { if (error || state?.error || tab?.error) setPanelOpen(true); }, [error, state?.error, tab?.error]);
  useEffect(() => { setAddress(tab && !['about:blank', 'about:newtab'].includes(tab.url) ? tab.url : ''); }, [tab?.id, tab?.url]);
  useEffect(() => {
    if (agentSurface) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); document.getElementById('address')?.focus(); }
      if (event.key.toLowerCase() === 't' && state?.browserReady) { event.preventDefault(); void dispatch({ type: 'tab.new' }); }
      if (event.key.toLowerCase() === 'j') { event.preventDefault(); if (panelOpen && panel === 'assistant') setPanelOpen(false); else openPanel('assistant'); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [dispatch, openPanel, panelOpen, panel, state?.browserReady, agentSurface]);

  const activeIds = state?.activeJobIds ?? (state?.activeJobId ? [state.activeJobId] : []);
  const activeJobs = state?.jobs.filter(job => activeIds.includes(job.id)) ?? [];
  const isAgentJob = (job: Job) => Boolean(job.agentScope || [...(state?.agentTabs ?? []), ...(state?.tabs ?? [])].some(tab => tab.ownership === 'agent' && tab.id === job.tabId && tab.profileId === job.profileId));
  const browserJobs = state?.jobs.filter(job => job.profileId === state.activeProfileId && !isAgentJob(job)) ?? [];
  const goals = state?.goalTasks?.filter(goal => goal.profileId === state.activeProfileId) ?? [];
  const selectedGoal = goals.find(goal => goal.id === selectedGoalId);
  const goalInFlight = goals.some(goalWorking);
  const inspectGoal = (id: string) => { setSelectedGoalId(id); setPanel('assistant'); setPanelOpen(true); };
  const recentJobs = state?.jobs.filter(job => job.profileId === state.activeProfileId && !goals.some(goal => goal.children.some(child => child.jobId === job.id))).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? [];
  const userTabs = state?.tabs.filter(item => item.profileId === state.activeProfileId && item.ownership === 'user') ?? [];
  const agentTabs = state?.agentTabs?.filter(item => item.profileId === state.activeProfileId) ?? [];
  const panelTabNames=['assistant','history','settings'] as const;
  const activatePanelTabKey=(event:ReactKeyboardEvent<HTMLButtonElement>,item:typeof panelTabNames[number])=>{
    if(event.nativeEvent.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    const next=tabNavigationIndex(event.key,panelTabNames.indexOf(item),panelTabNames.length,'horizontal');
    if(next===null)return;event.preventDefault();
    const focus=event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    openPanel(panelTabNames[next]);focus?.focus();
  };
  const activateBrowserTabKey=async(event:ReactKeyboardEvent<HTMLButtonElement>,id:string)=>{
    if(!ready||event.nativeEvent.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    const index=userTabs.findIndex(tab=>tab.id===id),next=tabNavigationIndex(event.key,index,userTabs.length,'vertical');
    if(next===null)return;event.preventDefault();
    const focus=event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    if(await dispatch({type:'tab.activate',tabId:userTabs[next].id}))focus?.focus();
  };
  const inspectJob = (job: Job) => { if (isAgentJob(job)) { void dispatch({ type: 'agents.show' }); } else { openPanel('assistant'); setSelectedJobId(job.id); } };
  const agentJobCount = activeJobs.filter(job => job.profileId === state?.activeProfileId && (job.agentScope || state?.agentTabs?.some(tab => tab.id === job.tabId && tab.profileId === job.profileId))).length;
  const activeJob = activeJobs.find(job => !isAgentJob(job));
  const busy = activeJobs.length > 0;
  const pendingStarts = [...flight.current].filter(key => key.startsWith('agents.start:') && !activeJobs.some(job => key === `agents.start:${job.tabId}`)).length;
  const sectionReservations = [...sectionFlights.current].filter(([key]) => !activeJobs.some(job => key === JSON.stringify([job.profileId, job.tabId]))).length;
  const logicalSlots = activeJobs.length + pendingStarts + sectionReservations;
  const approvalKey = activeJobs.filter(job => job.status === 'awaiting_approval' && job.approval).map(job => `${job.id}:${job.approval!.id}`).join('|');
  useEffect(() => {
    if (agentSurface) return;
    const awaiting = activeJobs.filter(job => !isAgentJob(job) && job.status === 'awaiting_approval' && job.approval);
    const fresh = awaiting.filter(job => !seenApprovals.current.has(`${job.id}:${job.approval!.id}`));
    awaiting.forEach(job => seenApprovals.current.add(`${job.id}:${job.approval!.id}`));
    if (fresh.length) { setPanelOpen(true); setPanel(current => current === 'sections' ? 'sections' : 'assistant'); if (!awaiting.some(job => job.id === selectedJobId)) setSelectedJobId(fresh[0].id); }
  }, [approvalKey, agentSurface]);
  const selectedJob = browserJobs.find(job => job.id === selectedJobId);
  const currentJob = selectedJobId === 'new' ? undefined : selectedJob ?? activeJob ?? browserJobs[0];
  const { browser: ready, agent: agentReady, submit: canSubmit } = readiness(state);
  const providerReady = Boolean(state?.providerStatus.installed && state.providerStatus.authenticated);
  const profile = state?.profiles.find(item => item.id === state.activeProfileId);
  const desktopTarget = panes.find(pane => pane?.id === state?.activeTabId);
  const desktopScope = JSON.stringify([state?.activeProfileId, profile?.incognito, state?.activeTabId, splitCount, panes.map(pane => pane ? [pane.profileId, pane.id, pane.url, pane.revision] : null), prompt]);
  const desktopConsent = desktopConsentScope === desktopScope;
  useEffect(() => { setDesktopConsentScope(null); }, [desktopScope]);
  const desktopBlocked = !ready || !state?.codexDesktop?.installed || !state.codexDesktop.targetReady || !desktopTarget || !profile || profile.incognito || !desktopTarget.url.trim() || ['about:blank', 'about:newtab'].includes(desktopTarget.url) || !prompt.trim() || prompt.length > 4000 || !desktopConsent || flight.current.has('codexDesktop.handoff');
  const handoffDesktop = () => {
    if (desktopBlocked || !desktopTarget) return;
    setDesktopConsentScope(null);
    void dispatch({ type: 'codexDesktop.handoff', tabId: desktopTarget.id, expectedRevision: desktopTarget.revision, expectedUrl: desktopTarget.url, prompt, consent: true });
  };
  const sectionKey = (pane: BrowserTab) => JSON.stringify([pane.profileId, pane.id]);
  const sectionDraft = (pane: BrowserTab) => sectionDrafts[sectionKey(pane)] ?? '';
  const sectionScope = JSON.stringify([state?.activeProfileId, profile?.incognito, splitCount, panes.map(pane => pane ? [pane.profileId, pane.id, pane.url, pane.revision, sectionDraft(pane)] : null)]);
  const sectionConsent = sectionConsentScope === sectionScope;
  useEffect(() => { setSectionConsentScope(null); usedSectionConsent.current = null; }, [sectionScope]);
  const sectionJob = (pane: BrowserTab) => state?.jobs.filter(job => job.tabId === pane.id && job.profileId === pane.profileId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))[0];
  const sectionJobPending = (job: Job) => !agentReady || flight.current.has(`job.approve:${job.id}`) || flight.current.has(`job.cancel:${job.id}`);
  const sectionTasks = (targets: BrowserTab[]): SectionTask[] => targets.map(pane => ({ tabId: pane.id, expectedRevision: pane.revision, expectedUrl: pane.url, prompt: sectionDraft(pane) }));
  const sectionBusy = (pane: BrowserTab) => activeJobs.some(job => job.tabId === pane.id && job.profileId === pane.profileId) || sectionFlights.current.has(sectionKey(pane)) || flight.current.has(`agents.start:${pane.id}`);
  const sectionTargets = panes.filter((pane): pane is BrowserTab => Boolean(pane && sectionDraft(pane).trim() && !sectionBusy(pane)));
  const sectionBlock = (targets: BrowserTab[]): string | null => {
    if (!canSubmit) return '브라우저와 Codex 연결을 확인하세요.';
    if (!profile || profile.incognito) return '일반 프로필에서만 공유할 수 있습니다.';
    if (panes.some(pane => !pane) || new Set(panes.map(pane => pane?.id)).size !== panes.length) return '현재 화면 구성을 확인하세요.';
    if (!targets.length) return '유휴 화면에 요청을 입력하세요.';
    if (targets.some(pane => pane.profileId !== state?.activeProfileId || !publicSectionUrl(pane.url) || pane.isLoading || pane.lifecycle === 'dormant' || !Number.isSafeInteger(pane.revision) || pane.revision < 0)) return '공개 웹 주소의 로딩이 끝난 화면만 실행할 수 있습니다.';
    if (targets.some(pane => !sectionDraft(pane).trim() || sectionDraft(pane).length > 8000)) return '각 요청은 공백이 아닌 1–8000자여야 합니다.';
    if (targets.some(sectionBusy)) return '이미 실행 중인 화면입니다.';
    if (logicalSlots + targets.length > 8) return '독립 작업은 최대 8개입니다.';
    return null;
  };
  const startSections = (targets: BrowserTab[]) => {
    if (!sectionConsent || sectionBlock(targets) || usedSectionConsent.current === sectionScope) return;
    usedSectionConsent.current = sectionScope;
    setSectionConsentScope(null);
    const keys = targets.map(sectionKey);
    keys.forEach((key, index) => sectionFlights.current.set(key, targets[index].id));
    setPendingSections([...sectionFlights.current.keys()]);
    void dispatch({ type: 'agents.startSections', tasks: sectionTasks(targets), consent: true }).finally(() => {
      keys.forEach(key => sectionFlights.current.delete(key));
      setPendingSections([...sectionFlights.current.keys()]);
    });
  };
  const navigate = (event: FormEvent, value: string) => { event.preventDefault(); if (ready && value.trim()) void dispatch({ type: 'tab.navigate', url: value.trim() }); };
  const targetTab = panes.find(item => item?.id === (targetTabId ?? tab?.id));
  // Consent binds the visible document set, not a reusable global preference.
  const consentScope = `${state?.activeProfileId}:${splitCount}:${panes.map(pane => pane ? `${pane.id}:${pane.revision}:${pane.url}` : '').join('|')}:${targetTab?.id}:${taskMode}`;
  useEffect(() => { setShareScreen(false); }, [consentScope]);
  const targetJob = activeJobs.find(job => job.tabId === targetTab?.id && job.profileId === targetTab?.profileId);
  const targetBusy = Boolean(targetTab && sectionBusy(targetTab));
  const openComputerTask = (tabId: string) => { setTargetTabId(tabId); openPanel('sections'); };
  const visibleTargets = panes.filter((pane): pane is BrowserTab => Boolean(pane && !['about:blank', 'about:newtab', ''].includes(pane.url)));
  const batchBlocked = !canSubmit || !profile || profile.incognito || prompt.length > 8000 || visibleTargets.some(pane => !publicSectionUrl(pane.url) || pane.isLoading || pane.lifecycle === 'dormant' || !Number.isSafeInteger(pane.revision) || pane.revision < 0) || !prompt.trim() || !shareScreen || !visibleTargets.length || logicalSlots + visibleTargets.length > 8 || visibleTargets.some(sectionBusy) || [...flight.current].some(key => key.startsWith('agents.start:'));
  const submitBatch = async () => {
    if ((taskMode !== 'computer'&&visibleTargets.length<2) || batchBlocked || visibleTargets.some(sectionBusy)) return;
    setShareScreen(false);
    const keys = visibleTargets.map(sectionKey);
    keys.forEach((key, index) => sectionFlights.current.set(key, visibleTargets[index].id));
    setPendingSections([...sectionFlights.current.keys()]);
    try {
      if (await dispatch({ type: 'agents.startSections', tasks: visibleTargets.map(pane => ({ tabId: pane.id, expectedRevision: pane.revision, expectedUrl: pane.url, prompt: prompt.trim() })), consent: true })) setPrompt(current => current === prompt ? '' : current);
    } finally {
      keys.forEach(key => sectionFlights.current.delete(key));
      setPendingSections([...sectionFlights.current.keys()]);
    }
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!prompt.trim() || prompt.length > 8000 || targetBusy || logicalSlots >= 8 || !canSubmit || !targetTab || (!shareScreen || !publicSectionUrl(targetTab.url) || targetTab.isLoading || targetTab.lifecycle === 'dormant' || !Number.isSafeInteger(targetTab.revision) || targetTab.revision < 0 || !profile || profile.incognito)) return;
    const command = { type: 'agents.start' as const, prompt: prompt.trim(), tabId: targetTab.id, expectedRevision: targetTab.revision, expectedUrl: targetTab.url, computerUse: taskMode === 'computer', shareScreen: true };
    setShareScreen(false);
    if (await dispatch(command)) setPrompt(current => current === prompt ? '' : current);
  };

  const goalBlocked = !state?.bridgeReady ? '앱의 AI 연결을 확인하세요.' : !providerReady ? 'Codex 설치와 로그인이 필요합니다.' : !prompt.trim() ? '새 작업 요청을 입력하세요.' : prompt.length > 8000 ? '요청은 8000자 이내로 입력하세요.' : flight.current.has('goals.start') ? '작업을 접수하고 있습니다.' : null;
  const submitGoal = async (event?: FormEvent) => {
    event?.preventDefault();
    if (goalBlocked) return;
    const draft = prompt;
    if (await dispatch({ type: 'goals.start', prompt: draft })) {
      setError(null);
      // Background task bootstrap must not erase the user's ordinary-tab draft.
    }
  };

  if (agentSurface && state) return <AgentArea state={state} dispatch={dispatch} />;

  return <div className="app-shell" style={{ '--panel-width': `${layout.sidebarWidth}px` } as CSSProperties}>
    <nav className="aside-sidebar" aria-label="브라우저 사이드바">
      <div className="sidebar-window-space"><span className="sidebar-wordmark">Sidework</span><Globe2 size={15}/></div>
      <div className="sidebar-scroll">
        <button className="sidebar-new" aria-label="새 작업" disabled={!ready} onClick={() => { setSelectedJobId('new'); void dispatch({ type: 'tab.new' }); }}><MessageSquare size={16}/><span className="sidebar-label">새 작업</span><Plus className="sidebar-trailing" size={14}/></button>
        <section className="sidebar-section" aria-label="최근 작업 탐색"><h2>작업</h2>{goals.slice(0, 6).map(goal => <button key={goal.id} className="sidebar-row task-row" title={`${goal.title} · ${goalStatusNames[goal.status]}`} aria-label={`작업 열기 · ${goal.title}`} onClick={() => inspectGoal(goal.id)}><MessageSquare size={14}/><span className="sidebar-label">{goal.title}</span><span className={`status-dot ${goal.status}`} /><span className="sidebar-trailing">{goalStatusNames[goal.status]}</span></button>)}{recentJobs.slice(0, 6).map(job => <button key={job.id} className="sidebar-row task-row" title={job.prompt} aria-label={`작업 열기 · ${job.prompt}`} onClick={() => inspectJob(job)}><MessageSquare size={14}/><span className="sidebar-label">{job.prompt}</span><span className={`status-dot ${job.status}`} /></button>)}{!recentJobs.length && !goals.length && <p className="sidebar-empty">시작한 작업이 여기에 표시됩니다.</p>}<button className="sidebar-row subdued" aria-label="작업 기록" onClick={() => openPanel('history')}><History size={15}/><span className="sidebar-label">작업 기록</span></button></section>
        <section className="sidebar-section" aria-label="일반 탭"><h2>탭</h2><button className="sidebar-row subdued" aria-label="새 탭" disabled={!ready} onClick={() => void dispatch({ type: 'tab.new' })}><Plus size={16}/><span className="sidebar-label">새 탭</span></button>
          <div className="sidebar-tabs" role="tablist" aria-label="브라우저 탭" aria-orientation="vertical">{userTabs.map(item => <div className={`sidebar-tab ${item.id === state?.activeTabId ? 'active' : ''}`} key={item.id}><button role="tab" id={`browser-tab-${item.id}`} tabIndex={item.id===state?.activeTabId?0:-1} aria-controls="browser-content" onKeyDown={event=>void activateBrowserTabKey(event,item.id)} aria-label={item.title || '새 탭 선택'} title={item.title || '새 탭'} aria-selected={item.id === state?.activeTabId} disabled={!ready} onClick={() => void dispatch({ type: 'tab.activate', tabId: item.id })}>{item.isLoading ? <LoaderCircle className="spin" size={15}/> : <Globe2 size={15}/>}<span className="sidebar-label">{item.title || '새 탭'}</span></button><IconButton label={`${item.title || '새 탭'} 닫기`} disabled={!ready} onClick={() => void dispatch({ type: 'tab.close', tabId: item.id })}><X size={12}/></IconButton></div>)}</div>
          <button className="sidebar-row subdued" aria-label="닫은 탭 다시 열기" disabled={!ready || !state?.closedTabCount || flight.current.has('tab.restore')} onClick={() => void dispatch({ type: 'tab.restore' })}><History size={15}/><span className="sidebar-label">닫은 탭 다시 열기</span></button>
        </section>
        <section className="sidebar-section agent-tab-group" aria-label="에이전트 탭"><button className="sidebar-row" aria-label="에이전트 작업 영역" disabled={!ready || flight.current.has('agents.show')} onClick={() => void dispatch({ type: 'agents.show' })}><Square size={14}/><span className="sidebar-label">에이전트 작업 영역</span><span className="sidebar-count" title={`${agentJobCount}개 작업 진행 중`}>{agentTabs.length}</span></button>{agentTabs.map(item => <button key={item.id} className="sidebar-row agent-tab-row" title={item.title || '에이전트 탭'} aria-label={`${item.title || '에이전트 탭'} · 에이전트 작업 영역에서 열기`} disabled={!ready || flight.current.has('agents.show')} onClick={() => void dispatch({ type: 'agents.show' })}><Globe2 size={14}/><span className="sidebar-label">{item.title || '에이전트 탭'}</span><ExternalLink className="sidebar-trailing" size={12}/></button>)}</section>
        <details className="sidebar-tools" open={width < 1100}><summary aria-label="도구"><Settings2 size={15}/><span className="sidebar-label">도구</span><ChevronDown className="sidebar-trailing" size={12}/></summary><button className="sidebar-row" aria-label="작업 공간" aria-expanded={panelOpen && panel === 'spaces'} onClick={() => { if(panelOpen && panel === 'spaces')setPanelOpen(false);else openPanel('spaces'); }}><Globe2 size={15}/><span className="sidebar-label">작업 공간</span></button><button className="sidebar-row" aria-label="화면별 AI" onClick={() => openPanel('sections')}><Square size={15}/><span className="sidebar-label">화면별 AI</span></button><button className="sidebar-row" aria-label="Codex Desktop 연결" onClick={() => openPanel('codexDesktop')}><ExternalLink size={15}/><span className="sidebar-label">Codex Desktop 연결</span></button><button className="sidebar-row" aria-label="다운로드" aria-expanded={panelOpen && panel === 'downloads'} onClick={() => { if(panelOpen && panel === 'downloads')setPanelOpen(false);else openPanel('downloads'); }}><ArrowUp size={15} className="download-icon"/><span className="sidebar-label">다운로드</span></button></details>
      </div>
      <div className="sidebar-footer"><button className="sidebar-row" data-testid="profile-menu" aria-label="프로필 관리" title={profile?.name ?? '프로필 관리'} onClick={() => openPanel('profiles')}><UserRound size={16}/><span className="sidebar-label">{profile?.name ?? '프로필'}</span>{profile?.incognito && <LockKeyhole className="sidebar-trailing" size={13}/>}</button><IconButton label="설정" selected={panelOpen && panel === 'settings'} onClick={() => openPanel('settings')}><Settings2 size={16}/></IconButton></div>
    </nav>
    <header className="browser-chrome">
      <div className="navigation-bar"><div className="nav-controls"><IconButton label="뒤로 가기" disabled={!ready || !tab?.canGoBack} onClick={() => void dispatch({ type: 'tab.back' })}><ArrowLeft size={17}/></IconButton><IconButton label="앞으로 가기" disabled={!ready || !tab?.canGoForward} onClick={() => void dispatch({ type: 'tab.forward' })}><ArrowRight size={17}/></IconButton><IconButton label="새로고침" disabled={!ready || !tab} onClick={() => void dispatch({ type: 'tab.reload' })}><RefreshCw size={16} className={tab?.isLoading ? 'spin' : ''}/></IconButton></div>
        <form className="address-form" onSubmit={event => navigate(event, address)}><Search size={15}/><input id="address" aria-label="주소 또는 검색어" placeholder="검색하거나 주소 입력" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.target.select()} onKeyDown={event => { if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && event.key === 'Enter') event.preventDefault(); }} disabled={!ready || flight.current.has('tab.new') || flight.current.has('tab.activate') || flight.current.has('profile.activate')} autoComplete="off" spellCheck={false}/><kbd>⌘ L</kbd></form>
        {splitCount === 1 && <><ControlBadge state={state} tab={tab} label="선택 화면 AI 제어 상태"/><PageTakeover state={state} tab={tab} label="이 화면 직접 사용" statusLabel="선택 화면 제어권 상태" dispatch={dispatch}/></>}
        <select className="split-selector" aria-label="화면 분할" value={splitCount} disabled={!ready} onChange={event => { const count = Number(event.target.value); if ([1, 2, 4, 8].includes(count)) void dispatch({ type: 'workspace.split', count: count as SplitCount }); }}>{([1, 2, 4, 8] as const).map(count => <option key={count} value={count}>{count} 화면</option>)}</select>
        <button className={`assistant-toggle ${panelOpen && panel === 'assistant' ? 'selected' : ''}`} aria-label="어시스턴트" aria-expanded={panelOpen && panel === 'assistant'} title="AI 사이드바 · ⌘ J" onClick={() => { if (panelOpen && panel === 'assistant') setPanelOpen(false); else openPanel('assistant'); }}><MessageSquare size={16}/><span>AI</span>{busy && <span className={`status-dot ${activeJob?.status}`}/>}</button>
      </div>
    </header>
    <main className="browser-surface" id="browser-content" role="tabpanel" aria-labelledby={tab?`browser-tab-${tab.id}`:undefined} aria-label="웹페이지 영역">
      {splitCount > 1 && <div className="pane-grid" data-testid="pane-grid" aria-label="분할 웹페이지" style={{ gridTemplateColumns: `repeat(${Math.min(splitCount, 4)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(splitCount / Math.min(splitCount, 4))}, minmax(0, 1fr))` }}>{panes.map((pane, index) => pane && <BrowserPane key={pane.id} tab={pane} index={index} focused={pane.id === state?.activeTabId} ready={ready} dispatch={dispatch} onTask={openComputerTask} state={state} job={activeJobs.find(job => job.tabId === pane.id && job.profileId === pane.profileId) ?? state?.jobs.find(job => job.tabId === pane.id && job.profileId === pane.profileId)} />)}</div>}
      {layout.hideBrowser && <section className="new-tab-page" aria-label="새 탭 작업 시작">
        <div className="home-content">
          <div className="home-identity"><Globe2 size={38} strokeWidth={1.1}/><h1>Sidework</h1></div>
          <div className="home-composer">
            <form className="home-search" aria-label={homeMode === 'search' ? '새 탭 검색 폼' : '새 탭 요청 폼'} onSubmit={event => { if (homeMode === 'search') navigate(event, prompt); else void submitGoal(event); }}>
              {homeMode === 'search' ? <><Search size={18}/><input ref={homeSearch} aria-describedby="home-mode-help" aria-label="새 탭 검색 또는 주소" placeholder="검색어 또는 웹 주소를 입력하세요" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && event.key === 'Enter') event.preventDefault(); }} disabled={!ready}/></> : <textarea ref={homeRequest} aria-describedby="home-mode-help" aria-label="새 탭 AI 요청" placeholder="어떤 일을 도와드릴까요?" value={prompt} onChange={event => setPrompt(event.target.value)} rows={2} onKeyDown={event => { if (shouldSubmitComposer(event.key, event.shiftKey, event.nativeEvent.isComposing, event.nativeEvent.keyCode)) { event.preventDefault(); void submitGoal(); } }}/>}<div className="home-mode-switch" role="group" aria-label="검색 또는 요청 방식"><button type="button" aria-label="Search" aria-pressed={homeMode === 'search'} onClick={() => selectHomeMode('search')}>Search</button><button type="button" aria-label="Ask" aria-pressed={homeMode === 'ask'} onClick={() => selectHomeMode('ask')}>Ask</button></div>
              <button className="home-submit" aria-describedby="home-mode-help" aria-label={homeMode === 'search' ? '검색 또는 주소 열기' : '새 탭 요청 보내기'} disabled={homeMode === 'ask' ? Boolean(goalBlocked) : !ready || !prompt.trim()} title={homeMode === 'ask' ? goalBlocked || '새 독립 작업 시작' : '검색 또는 주소 열기'}><ArrowRight size={17}/></button>
            </form>
            <div className="home-secondary"><button aria-label="현재 페이지 요청 열기" onClick={() => openPanel('assistant')}><Plus size={13}/><span>페이지 요청</span></button><span><LockKeyhole size={12}/>{profile?.incognito ? '비공개' : '로컬 프로필'}</span><button aria-label="권한 설정 열기" onClick={() => openPanel('settings')}><ShieldCheck size={13}/>{state?.settings.permissionMode === 'guard' ? '승인 모드' : '읽기 전용'}</button><button className="home-provider" aria-label="모델 연결 설정 열기" onClick={() => openPanel('settings')}>{state?.settings.model || 'Codex 기본 모델'}<ChevronDown size={12}/></button></div>
            {homeMode === 'search' && <p id="home-mode-help" className="home-input-hint">Enter로 검색 · 주소를 입력하면 바로 이동합니다.</p>}
            {homeMode === 'ask' && <div id="home-mode-help" className="home-blocked" role="status"><p>{goalBlocked || 'Enter로 새 독립 작업 시작 · Shift + Enter 줄바꿈'}</p><p>작업마다 별도 임시 브라우저 세션을 사용합니다. 일반 탭의 로그인은 공유하지 않습니다.</p>{!providerReady && <button type="button" className="text-button" aria-label="Codex 준비" onClick={() => openPanel('settings')}>Codex 준비 · 설치와 로그인 확인</button>}</div>}
          </div>
          <section className="recent-tasks" aria-label="최근 작업"><div className="recent-heading"><h2>최근 작업</h2><button aria-label="전체 작업 기록 열기" onClick={() => openPanel('history')}>모두 보기<ArrowRight size={12}/></button></div>{goals.length > 0 && <div className="recent-task-grid">{goals.slice(0, 3).map(goal => <button className="recent-task" key={goal.id} aria-label={`최근 작업 열기 · ${goal.title}`} onClick={() => inspectGoal(goal.id)}><div className="recent-meta"><span>{goalStatusNames[goal.status]}</span></div><h3>{goal.title}</h3><p>{goal.error || goal.children.find(child => child.answer)?.answer || goal.prompt}</p></button>)}</div>}{recentJobs.length ? <div className="recent-task-grid">{recentJobs.slice(0, 3).map(job => <button className="recent-task" key={job.id} aria-label={`최근 작업 열기 · ${job.prompt}`} onClick={() => inspectJob(job)}><div className="recent-meta"><span>{statusNames[job.status]}</span><span className={`status-dot ${job.status}`}/></div><h3>{job.prompt}</h3><p>{job.answer || job.error || job.events.at(-1)?.text || `${job.steps}단계 · 작업을 열어 실행 기록을 확인하세요.`}</p><span className="recent-date">{new Date(job.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></button>)}</div> : !goals.length && <div className="recent-empty"><p>아직 시작한 작업이 없습니다.</p><span>Search로 탐색하거나 Ask로 새 작업을 시작하세요.</span></div>}</section>
        </div>
      </section>}
    </main>
    <aside className="assistant-panel" aria-label="Sidework 작업 패널" hidden={!panelOpen}>
      <div className="panel-heading"><div><span className="heading-symbol"><MessageSquare size={16} /></span><h2 id="task-panel-heading">{{ assistant: '어시스턴트', history: '작업 기록', settings: '설정', profiles: '프로필', codexDesktop: 'Codex Desktop 연결', sections: '화면별 AI', downloads: '이번 세션 다운로드', spaces: '작업 공간' }[panel]}</h2></div><div className="panel-heading-actions"><IconButton label="요청 작성" onClick={() => { openPanel('assistant'); if (panel !== 'codexDesktop') setPrompt(''); composer.current?.focus(); }}><Plus size={17} /></IconButton><IconButton label="사이드바 닫기" onClick={() => setPanelOpen(false)}><X size={17} /></IconButton></div></div>
      <div className="panel-tabs" role="tablist" aria-label="패널 보기">{panelTabNames.map(item => <button role="tab" id={`panel-tab-${item}`} tabIndex={(panel===item||(!panelTabNames.some(name=>name===panel)&&item==='assistant'))?0:-1} aria-controls="task-panel-content" onKeyDown={event=>activatePanelTabKey(event,item)} aria-selected={panel === item} key={item} aria-current={panel === item ? 'page' : undefined} onClick={() => openPanel(item)}>{{ assistant: '대화', history: '기록', settings: '설정' }[item]}</button>)}</div>
      <div className="panel-body" id="task-panel-content" role="tabpanel" aria-labelledby={panelTabNames.some(name=>name===panel)?`panel-tab-${panel}`:'task-panel-heading'}>
      {(error || state?.error || tab?.error) && <div className="error-banner" role="alert"><span>{error || state?.error || tab?.error}</span>{error && <IconButton label="오류 닫기" onClick={() => setError(null)}><X size={14} /></IconButton>}</div>}
      {busy && activeJob && panel !== 'sections' && panel !== 'spaces' && (panel !== 'assistant' || (selectedJobId !== null && selectedJobId !== activeJob.id)) && <div className="active-job-banner"><button onClick={() => openPanel('assistant')}><span className={`status-dot ${activeJob.status}`} />{statusNames[activeJob.status]} · 작업 보기<ArrowRight size={13} /></button><button aria-label="진행 중인 작업 중지" disabled={pending} onClick={() => void dispatch({ type: 'job.cancel', jobId: activeJob.id })}><Square size={11} />중지</button></div>}
      {!state ? <div className="panel-empty"><Globe2 size={25} /><h3>{error ? '앱 연결이 필요합니다' : '작업 공간을 불러오는 중'}</h3><p>{error ? 'Sidework 데스크톱 앱에서 실행해 주세요. 실제 연결 전에는 작업을 표시하지 않습니다.' : '브라우저 작업 공간을 불러옵니다.'}</p></div> : <>
        {panel === 'spaces' && <div className="panel-scroll spaces-view" aria-label="현재 열린 작업 화면"><div className="spaces-intro"><h3>현재 열린 작업 화면</h3><p>현재 보이는 페이지를 한곳에서 확인합니다. 별도의 백그라운드 브라우저 공간이 아닙니다.</p></div>{panes.filter((pane): pane is BrowserTab => Boolean(pane && pane.profileId === state.activeProfileId)).map((pane, index) => <SpaceTile state={state} tab={pane} index={index} dispatch={dispatch} onInspect={job => { setPanel('assistant'); setPanelOpen(true); setSelectedJobId(job.id); }} key={JSON.stringify([pane.profileId,pane.id])}/>)}{!panes.some(pane => pane?.profileId === state.activeProfileId) && <p className="setting-help">현재 보이는 페이지가 없습니다. 새 탭을 열어 시작하세요.</p>}</div>}
        {panel === 'downloads' && <div className="panel-scroll downloads-view">{!downloads.length ? <p className="setting-help">이번 세션에 다운로드한 파일이 없습니다.</p> : <ul className="download-list">{downloads.map(download => <DownloadRow key={download.id} download={download} dispatch={dispatch} />)}</ul>}</div>}
        {panel === 'sections' && <div className="panel-scroll section-workspace" aria-label="화면별 AI 작업 공간">
          <p className="screen-warning">입력한 대상 화면의 캡처와 페이지 내용이 연결된 제공자(Codex)에 전송됩니다. 다른 앱이나 OS 데스크톱은 공유하지 않습니다. 민감한 페이지는 공유하지 마세요.</p>
          {state.providerActivity ? <p className="provider-activity">모델 실행 {state.providerActivity.running} · 대기 {state.providerActivity.waiting} · 한도 {state.providerActivity.limit}{state.providerActivity.reason && <span> · {state.providerActivity.reason}</span>}</p> : <p className="provider-activity">모델 실행 용량 미측정</p>}
          <p className="setting-help">독립 작업 {activeJobs.length} / 8 · 요청 대기 {pendingSections.length}개 · 화면 8개는 모델 8개 동시 실행을 뜻하지 않습니다.</p>
          <label className="checkbox-line"><input type="checkbox" aria-label="화면별 AI 공유 동의" checked={sectionConsent} onChange={event => { usedSectionConsent.current = null; setSectionConsentScope(event.target.checked ? sectionScope : null); }} />이번 요청의 대상 화면 공유에 동의합니다.</label>
          <button className="primary-button full" aria-label="입력한 화면 AI 시작" disabled={!sectionConsent || Boolean(sectionBlock(sectionTargets))} onClick={() => startSections(sectionTargets)}>입력한 화면 AI 시작</button>
          <button className="secondary-button full" aria-label="모든 화면 AI 중지" disabled={!busy || !agentReady || flight.current.has('jobs.cancelAll')} onClick={() => void dispatch({ type: 'jobs.cancelAll' })}>모든 화면 AI 중지</button>
          {sectionBlock(sectionTargets) && <p className="setting-help" role="status">{sectionBlock(sectionTargets)}</p>}
          {panes.map((pane, index) => pane && <section className="section-ai-card" key={JSON.stringify([pane.profileId, pane.id])} aria-label={`화면 ${index + 1} AI 작업`}><h3>화면 {index + 1} · {pane.title || '새 탭'}</h3><p className="section-ai-url">{pane.url || '주소 없음'}</p><label className="field-label">화면 {index + 1} AI 요청<textarea className="text-input" aria-label={`화면 ${index + 1} AI 요청`} value={sectionDrafts[JSON.stringify([pane.profileId, pane.id])] ?? ''} onChange={event => setSectionDrafts(current => ({ ...current, [JSON.stringify([pane.profileId, pane.id])]: event.target.value }))} rows={3} /></label><button className="secondary-button full" aria-label={`화면 ${index + 1} AI 시작`} disabled={!sectionConsent || Boolean(sectionBlock([pane]))} onClick={() => startSections([pane])}>화면 {index + 1} AI 시작</button>{(() => {
            const job = sectionJob(pane);
            return job ? <><div className="section-ai-job" aria-label={`화면 ${index + 1} AI 상태`}><span>{statusNames[job.status]} · {job.steps}단계</span>{activeIds.includes(job.id) && <button className="secondary-button" aria-label={`화면 ${index + 1} AI 중지`} disabled={!agentReady || flight.current.has(`job.cancel:${job.id}`)} onClick={() => void dispatch({ type: 'job.cancel', jobId: job.id })}>이 화면 중지</button>}</div><JobView job={job} state={state} dispatch={dispatch} pending={sectionJobPending(job)} /></> : <p className="setting-help">아직 실행한 작업이 없습니다.</p>;
          })()}</section>)}
        </div>}
        {panel === 'codexDesktop' && <div className="panel-scroll settings-view" aria-label="Codex Desktop 전달 패널"><section className="settings-section">
          <h3>공식 Codex Desktop</h3>
          <p className="setting-help">설치: {state.codexDesktop?.installed ? '확인됨' : '미확인'} {state.codexDesktop?.version}</p>
          <p className="setting-help">전용 패키지 대상: {state.codexDesktop?.targetReady ? '준비됨' : '준비되지 않음'}</p>
          <p className="setting-help">{state.codexDesktop?.detail || '연결 확인을 눌러 설치와 대상 앱을 확인하세요.'}</p>
          <p className="setting-help">설치 확인은 실제 실행이나 앱 접근 권한을 보장하지 않습니다.</p>
          <button className="secondary-button" aria-label="Codex Desktop 연결 확인" disabled={flight.current.has('codexDesktop.check')} onClick={() => void dispatch({ type: 'codexDesktop.check' })}>Codex Desktop 연결 확인</button>
          <p className="setting-help">현재 선택 화면: {desktopTarget?.title || '대상 없음'}</p>
          {desktopTarget && <p className="setting-help">{desktopTarget.url}</p>}
          <p className="screen-warning">공식 Computer Use는 앱·창 단위로 동작하여 다른 분할 화면도 보일 수 있습니다. 선택 화면만의 강제 격리를 보장하지 않습니다.</p>
          <p className="screen-warning">전송·앱 접근 승인·중지는 공식 Codex에서 직접 처리하세요. 새 요청 화면을 연 뒤 직접 확인하고 보내야 합니다. 앱 권한은 별도로 승인해야 하며, 이 동의로 권한을 부여하지 않습니다. 자동으로 결과를 가져오지 않습니다.</p>
          <label className="field-label">요청<textarea className="text-input" aria-label="AI에게 요청" value={prompt} onChange={event => setPrompt(event.target.value)} rows={5} /></label>
          <p className="setting-help">요청 {prompt.length} / 4000자</p>
          <label className="checkbox-line"><input type="checkbox" aria-label="Codex Desktop 전달 동의" checked={desktopConsent} onChange={event => setDesktopConsentScope(event.target.checked ? desktopScope : null)} />요청 문구와 현재 페이지 URL을 새 Codex 요청 화면에 전달하는 데 동의합니다.</label>
          <button className="primary-button full" aria-label="Codex Desktop에서 계속" disabled={desktopBlocked} onClick={handoffDesktop}>Codex Desktop에서 계속</button>
          {state.codexDesktopHandoff?.status === 'requested' && <div role="status"><p>새 요청 화면 열기 요청됨 — Codex에서 확인 후 보내세요</p><p className="setting-help">최근 전달 기록 · 화면 {state.codexDesktopHandoff.paneIndex}. 작업 실행·완료를 뜻하지 않습니다.</p></div>}
        </section></div>}
        {panel === 'settings' && <SettingsPanel state={state} dispatch={dispatch} pending={pending} />}
        {panel === 'profiles' && <ProfilesPanel state={state} dispatch={dispatch} pending={!ready || goalInFlight || flight.current.has('goals.start') || [...flight.current].some(type => type.startsWith('tab.') || type.startsWith('profile.'))} />}
        {panel === 'history' && <div className="panel-scroll history-view" data-testid="history-panel"><div className="section-intro"><h3>내 작업</h3><p>실행 결과와 승인 내역을 확인하세요.</p></div>{goals.length > 0 && <ul className="history-list">{goals.map(goal => <li key={goal.id}><button aria-label={`기록 열기 · ${goal.title}`} onClick={() => inspectGoal(goal.id)}><strong>{goal.title}</strong><small>{goalStatusNames[goal.status]}</small></button></li>)}</ul>}{browserJobs.length === 0 && !goals.length ? <div className="inline-empty"><History size={24} /><h3>아직 작업 기록이 없습니다</h3><p>요청한 작업이 이곳에 쌓입니다.<br />샘플 기록은 만들지 않습니다.</p></div> : <ul className="history-list">{browserJobs.map(job => <li key={job.id}><button onClick={() => { openPanel('assistant'); setSelectedJobId(job.id); }}><div><span className={`status-dot ${job.status}`} /><strong>{job.prompt}</strong><ArrowRight size={15} /></div><small>{statusNames[job.status]}<span>{new Date(job.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></small></button></li>)}</ul>}</div>}
        {panel === 'assistant' && selectedGoal && <GoalTasks goal={selectedGoal} state={state} dispatch={dispatch}/>}
        {panel === 'assistant' && !selectedGoal && <>{browserJobs.length > 0 && <div className="job-selector"><label>검토할 작업<select aria-label="검토할 작업" value={currentJob?.id ?? ''} onChange={event => setSelectedJobId(event.target.value || 'new')}><option value="">새 요청 · 검토할 작업 선택</option>{browserJobs.map(job => <option key={job.id} value={job.id}>{statusNames[job.status]} · {state.tabs.find(tab => tab.id === job.tabId)?.title || job.tabId} · {job.prompt}</option>)}</select></label>{currentJob && activeIds.includes(currentJob.id) && <button type="button" aria-label="선택 작업 중지" disabled={!agentReady || flight.current.has(`job.cancel:${currentJob.id}`)} onClick={() => void dispatch({ type: 'job.cancel', jobId: currentJob.id })}>이 작업 중지</button>}</div>}<div className="panel-scroll conversation" aria-live="polite">{currentJob ? <JobView job={currentJob} state={state} dispatch={dispatch} pending={!agentReady || flight.current.has(`job.approve:${currentJob.id}`) || flight.current.has(`job.cancel:${currentJob.id}`)} /> : <div className="assistant-welcome"><div className="welcome-icon"><MessageSquare size={23} strokeWidth={1.5} /></div><h3>지금 보고 있는 페이지에서<br />함께 처리할 일을 알려주세요.</h3><p>내용을 읽고 정리하거나,<br />에이전트 작업 영역에서 반복 작업을 진행합니다.</p><div className="quiet-rule" /><div className="welcome-detail"><ShieldCheck size={16} /><p>일반 조작은 에이전트 작업 영역에서 진행하고,<br /><strong>중요하거나 영향이 불명확한 행동은 확인</strong>합니다.</p></div></div>}{!providerReady && <div className="provider-notice"><strong>Codex 연결이 필요합니다</strong><p>로컬 Codex CLI 설치와 로그인을 마친 뒤 설정에서 연결을 확인하세요.</p><button className="text-button" onClick={() => openPanel('settings')}>연결 설정 열기 <ArrowRight size={13} /></button></div>}</div>
          <div className={`composer-area ${targetBusy ? 'is-busy' : ''}`}><div className="computer-controls"><div className="job-capacity"><span>독립 작업 {activeJobs.length} / 8</span><button type="button" aria-label="모든 작업 중지" disabled={!busy || !agentReady || flight.current.has('jobs.cancelAll')} onClick={() => void dispatch({ type: 'jobs.cancelAll' })}>모두 중지</button></div><label>작업 대상 화면<select aria-label="작업 대상 화면" value={targetTab?.id ?? ''} onChange={event => { setTargetTabId(event.target.value); setShareScreen(false); }}>{!targetTab && <option value="">화면을 선택하세요</option>}{panes.map((pane, index) => pane && <option key={pane.id} value={pane.id}>{index + 1} · {pane.title || '새 탭'}</option>)}</select></label></div><details className="composer-options"><summary>작업 옵션 · {taskMode === 'computer' ? '컴퓨터 작업' : '페이지 텍스트'}</summary><div className="computer-controls">{state.providerActivity ? <p className="provider-activity">모델 실행 {state.providerActivity.running} · 대기 {state.providerActivity.waiting} · 한도 {state.providerActivity.limit}{state.providerActivity.reason && <span> · {state.providerActivity.reason}</span>}</p> : <p className="provider-activity">모델 실행 용량 미측정</p>}<label>작업 방식<select aria-label="작업 방식" value={taskMode} onChange={event => { setTaskMode(event.target.value === 'computer' ? 'computer' : 'dom'); setTargetTabId(event.target.value === 'computer' ? (targetTab?.id ?? null) : null); setShareScreen(false); }}><option value="dom">페이지 텍스트 · DOM</option><option value="computer">화면 · 컴퓨터 작업</option></select></label>{taskMode === 'computer' && <p className="screen-warning">선택한 화면의 캡처와 페이지 내용이 연결된 제공자(Codex)에 전송됩니다. 민감한 페이지는 공유하지 마세요. 다른 앱이나 데스크톱은 공유하지 않습니다.</p>}
          <>
          <p className="screen-warning">일괄 실행: 보이는 비어 있지 않은 {visibleTargets.length}개 화면에 같은 요청을 각각 보냅니다. 모든 대상 화면 공유에 동의한 경우에만 실행하세요. 화면 8개가 모델 8개 동시 실행을 뜻하지 않습니다.</p>
          <button type="button" className="secondary-button" aria-label="보이는 화면 일괄 실행" disabled={batchBlocked} onClick={()=>void submitBatch()}>보이는 화면 일괄 실행</button></></div></details><p className="screen-warning">대상 페이지의 내용·화면을 연결된 제공자(Codex)에 전송합니다. 일반 조작은 자동 진행하고, 중요한 행동이나 영향이 불명확한 조작은 작업 영역에서 확인합니다. 민감한 페이지는 공유하지 마세요.</p><label className="checkbox-line"><input type="checkbox" aria-label="선택 화면 공유 동의" checked={shareScreen} onChange={event=>setShareScreen(event.target.checked)}/>이번 요청의 대상 페이지 내용·화면 공유에 동의합니다.</label><div className="context-line"><Globe2 size={13} /><span>{targetTab?.title || '선택 화면 없음'}</span><span className="context-mode">{state.settings.permissionMode === 'guard' ? '승인 모드' : '읽기 전용'}</span></div><form className="composer" onSubmit={event => void submit(event)}><textarea ref={composer} aria-label="AI에게 요청" placeholder={targetBusy ? '이 화면에서 작업 중입니다. 다른 화면을 선택할 수 있어요.' : '이 페이지에서 무엇을 도와드릴까요?'} value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} onKeyDown={event => { if (shouldSubmitComposer(event.key, event.shiftKey, event.nativeEvent.isComposing, event.nativeEvent.keyCode)) { event.preventDefault(); void submit(); } }} /><div className="composer-bottom"><span>Shift + Enter 줄바꿈</span>{targetJob && <button type="button" className="stop-button" aria-label="선택 화면 작업 중지" onClick={() => void dispatch({ type: 'job.cancel', jobId: targetJob.id })}><Square size={12} fill="currentColor" />중지</button>}<button className="send-button" aria-label="에이전트에게 맡기기" title="선택 페이지를 에이전트 작업 영역에 맡기기" disabled={!prompt.trim() || prompt.length > 8000 || !canSubmit || !targetTab || targetBusy || logicalSlots >= 8 || !shareScreen || !publicSectionUrl(targetTab.url) || targetTab.isLoading || targetTab.lifecycle === 'dormant' || !Number.isSafeInteger(targetTab.revision) || targetTab.revision < 0 || !profile || profile.incognito}><span>에이전트에게 맡기기</span><ArrowUp size={17} /></button></div></form><div className="composer-disclaimer">AI의 결과를 확인하세요. 민감한 정보는 입력하지 마세요.</div></div>
        </>}
      </>}
      </div>
      {panel === 'codexDesktop' ? <div className="panel-footer"><span>공식 앱으로 요청 전달</span><span>실행·결과는 Codex에서 확인</span></div> : <div className="panel-footer"><span className={`status-dot ${agentReady && state?.providerStatus.authenticated ? 'completed' : ''}`} /><span>{agentStatus(state)}</span><span>{state?.providerStatus.liveVerified ? '이전 실행 검증됨' : '실행 미검증'}</span></div>}
    </aside>
  </div>;
}

function BrowserPane({ tab, index, focused, ready, dispatch, onTask, job, state }: { state: AppState | null; tab: BrowserTab; index: number; focused: boolean; ready: boolean; dispatch: Dispatch; onTask: (tabId: string) => void; job?: Job }) {
  const [url, setUrl] = useState('');
  const blank = ['about:blank', 'about:newtab', ''].includes(tab.url);
  useEffect(() => { setUrl(blank ? '' : tab.url); }, [tab.id, tab.url, blank]);
  const number = index + 1;
  const navigate = (event: FormEvent) => { event.preventDefault(); if (ready && url.trim()) void dispatch({ type: 'tab.navigate', tabId: tab.id, url: url.trim() }); };
  return <section className={`browser-pane ${focused ? 'focused' : ''}`} data-pane-id={tab.id} aria-label={`화면 ${number}`}><div className="pane-header"><button aria-label={`화면 ${number} 선택`} aria-pressed={focused} disabled={!ready} onClick={() => void dispatch({ type: 'tab.activate', tabId: tab.id })}>{number}</button><form aria-label={`화면 ${number} 탐색`} onSubmit={navigate}><input aria-label={`화면 ${number} 주소`} placeholder="주소 또는 검색어" value={url} disabled={!ready} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && event.key === 'Enter') event.preventDefault(); }} /></form><button aria-label={`화면 ${number} 컴퓨터 작업`} title="이 화면의 컴퓨터 작업 작성" disabled={!ready} onClick={() => onTask(tab.id)}>AI</button><PageTakeover state={state} tab={tab} label={`화면 ${number} 직접 사용`} statusLabel={`화면 ${number} 제어권 상태`} dispatch={dispatch}/>{job && <><ControlBadge state={state} tab={tab} label={`화면 ${number} AI 제어 상태`} fallback={<span className="pane-status" title={statusNames[job.status]} aria-label={`화면 ${number} 상태`}>{statusNames[job.status]}</span>} />{['queued', 'running', 'awaiting_approval'].includes(job.status) && <button aria-label={`화면 ${number} 작업 중지`} disabled={!ready} onClick={() => void dispatch({ type: 'job.cancel', jobId: job.id })}><Square size={12} /></button>}</>}</div><div className="pane-body">{blank && <div className="pane-empty"><Globe2 size={20} /><p>주소를 입력해 시작하세요.</p><form onSubmit={navigate}><input aria-label={`화면 ${number} 새 주소`} value={url} onChange={event => setUrl(event.target.value)} onKeyDown={event => { if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && event.key === 'Enter') event.preventDefault(); }} disabled={!ready} placeholder="웹 주소 또는 검색어" /><button disabled={!ready || !url.trim()}>열기</button></form></div>}</div></section>;
}

function ApprovalCard({ approval, job, state, dispatch, pending }: { approval: PendingApproval; job: Job; state: AppState; dispatch: Dispatch; pending: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const action = approval.action;
  const boundTab = state.tabs.find(tab => tab.id === approval.context.tabId && tab.profileId === approval.context.profileId);
  const expired = new Date(approval.expiresAt).getTime() <= now;
  const stale = !boundTab || boundTab.revision !== approval.revision || !(state.paneTabIds ?? (state.activeTabId ? [state.activeTabId] : [])).includes(approval.context.tabId) || state.activeProfileId !== approval.context.profileId || job.tabId !== approval.context.tabId || job.profileId !== approval.context.profileId;
  const names = { navigate: '페이지 이동', open_tab: '새 탭 열기', click: '요소 클릭', submit_search: '검색 제출', fill: '텍스트 입력', scroll: '페이지 스크롤', observe: '페이지 읽기', screenshot: '스크린샷 저장', computer_click: '화면 좌표 클릭', computer_type: '화면 텍스트 입력', computer_key: '화면 키 입력' };
  return <section className="approval-card" aria-label="행동 승인 요청"><div className="approval-title"><ShieldCheck size={18} /><h3>이 행동을 허용할까요?</h3></div><p>한 번의 행동에만 적용됩니다.</p><dl><dt>행동</dt><dd>{names[action.type]}</dd><dt>대상</dt><dd aria-label="승인 대상">{'url' in action ? action.url : boundTab?.url || '대상 탭 없음'}{'ref' in action && <code>{action.ref}</code>}</dd><dt>프로필 / 탭</dt><dd>{state.profiles.find(item => item.id === approval.context.profileId)?.name ?? approval.context.profileId} / {boundTab?.title || approval.context.tabId}</dd><dt>만료</dt><dd>{new Date(approval.expiresAt).toLocaleTimeString('ko-KR')}</dd></dl>{(action.type === 'fill' || action.type === 'computer_type') && <p className="approval-private"><LockKeyhole size={12} />입력값은 이 화면에 표시하지 않습니다.</p>}{(expired || stale) && <p className="approval-invalid">{expired ? '승인 시간이 만료되었습니다. 허용할 수 없습니다.' : '페이지 또는 프로필이 변경되었습니다. 허용할 수 없습니다.'}</p>}<div className="approval-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => void dispatch({ type: 'job.approve', jobId: job.id, approvalId: approval.id, allow: false })}>거부</button><button type="button" className="primary-button" disabled={pending || expired || stale} onClick={() => { if (!pending && !expired && !stale) void dispatch({ type: 'job.approve', jobId: job.id, approvalId: approval.id, allow: true }); }}><Check size={15} />이번 행동 허용</button></div></section>;
}

function JobView({ job, state, dispatch, pending }: { job: Job; state: AppState; dispatch: Dispatch; pending: boolean }) {
  return <div className="job-view"><div className="request-message"><span>내 요청</span><p>{job.prompt}</p></div><div className="job-heading" aria-label="작업 상태"><span className={`status-dot ${job.status}`} /><strong>{statusNames[job.status]}</strong><span>{job.steps}단계</span></div>{job.approval && job.status === 'awaiting_approval' && <ApprovalCard approval={job.approval} job={job} state={state} dispatch={dispatch} pending={pending} />}{job.events.length > 0 && <details className="job-trace"><summary>실행 기록 · {job.events.length}개</summary><ol className="event-list">{job.events.map(event => <li key={event.id} className={event.kind === 'error' ? 'event-error' : ''}><span className="event-marker">{event.kind === 'error' ? <X size={12} /> : event.kind === 'approval' ? <ShieldCheck size={12} /> : <Check size={12} />}</span><div><small>{{ status: '상태', thought: '작업 계획', action: '행동', observation: '페이지 확인', approval: '승인', error: '오류' }[event.kind]}</small><p>{event.kind==='action' && event.text==='submit_search'?'검색 제출':event.text}</p></div></li>)}</ol></details>}{job.answer && <div className="answer"><div><CheckCircle2 size={16} /><strong>작업 결과</strong></div><p>{job.answer}</p></div>}{job.error && <p className="job-error" role="alert">{job.error}</p>}{job.status === 'unknown' && <p className="job-error">행동이 실행되었을 수 있습니다. 페이지를 직접 확인하세요. 같은 행동을 자동으로 다시 실행하지 않습니다.</p>}{job.status === 'interrupted' && <p className="job-note">앱 종료로 중단된 작업입니다. 자동으로 재개하지 않습니다.</p>}{job.artifacts.length > 0 && <div className="artifacts"><h4>저장된 증거</h4>{job.artifacts.map(artifact => <button key={artifact.id} onClick={() => void dispatch({ type: 'artifact.open', jobId: job.id, artifactId: artifact.id })}><FileText size={15} /><span>{artifact.name}</span><ExternalLink size={13} /></button>)}</div>}</div>;
}

function SettingsPanel({ state, dispatch, pending }: { state: AppState; dispatch: Dispatch; pending: boolean }) {
  const [model, setModel] = useState(state.settings.model);
  const [maxSteps, setMaxSteps] = useState(state.settings.maxSteps);
  const [note, setNote] = useState('');
  const aiDisabled = pending || !state.bridgeReady;
  const aiDispatch: Dispatch = command => aiDisabled ? Promise.resolve(false) : dispatch(command);
  useEffect(() => { setModel(state.settings.model); setMaxSteps(state.settings.maxSteps); }, [state.settings.model, state.settings.maxSteps]);
  return <div className="panel-scroll settings-view"><section className="settings-section"><h3>모델 연결</h3><div className="provider-heading"><span className="provider-logo">C</span><div><strong>Codex CLI</strong><small>공식 로컬 제공자</small></div><button className="secondary-button compact" disabled={pending} onClick={() => void dispatch({ type: 'provider.check' })}><RefreshCw size={13} />확인</button></div><ul className="capability-list">{[['설치', state.providerStatus.installed], ['로그인', state.providerStatus.authenticated], ['실제 모델 실행', state.providerStatus.liveVerified]].map(([label, checked]) => <li key={String(label)}><span>{label}</span><span className={checked ? 'verified' : 'unverified'}>{checked ? <Check size={13} /> : <Clock3 size={13} />}{checked ? '확인됨' : '미확인'}</span></li>)}</ul><p className="setting-help">{state.providerStatus.detail || '설치·로그인·실제 실행은 각각 확인합니다.'}</p><p className="setting-help">설정 확인만으로 AI 요청을 보내지 않습니다.</p></section>
    <section className="settings-section"><h3>행동 권한</h3><div className="permission-options">{(['guard', 'read-only'] as const).map(mode => <label key={mode} className={state.settings.permissionMode === mode ? 'chosen' : ''}><input type="radio" name="permission" value={mode} checked={state.settings.permissionMode === mode} disabled={aiDisabled} onChange={() => void aiDispatch({ type: 'settings.update', patch: { permissionMode: mode } })} /><span><strong>{mode === 'guard' ? '승인 모드' : '읽기 전용'}</strong><small>{mode === 'guard' ? '페이지 변경 행동마다 직접 승인' : '읽기·스크롤·스크린샷만 허용'}</small></span></label>)}</div></section>
    <section className="settings-section"><h3>실행 설정</h3><form onSubmit={async event => { event.preventDefault(); await aiDispatch({ type: 'settings.update', patch: { model: model.trim(), maxSteps } }); }}><label className="field-label" htmlFor="model">모델</label><input id="model" disabled={aiDisabled} className="text-input" placeholder="Codex 기본 모델 사용" value={model} onChange={event => setModel(event.target.value)} /><label className="field-label spaced" htmlFor="steps">최대 작업 단계 <span>1–20</span></label><input id="steps" disabled={aiDisabled} className="text-input" type="number" min={1} max={20} required value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} /><p className="setting-help">변경 사항은 다음 요청부터 적용됩니다.</p><button className="secondary-button full" disabled={aiDisabled || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20}>실행 설정 저장</button></form></section>
    <section className="settings-section"><div className="section-title-row"><h3>개인 메모리</h3><label className="switch"><input type="checkbox" aria-label="개인 메모리 사용" checked={state.settings.memoryEnabled} disabled={aiDisabled} onChange={event => void aiDispatch({ type: 'settings.update', patch: { memoryEnabled: event.target.checked } })} /><span /></label></div><p className="setting-help">직접 저장한 메모만 사용합니다. 끄면 메모를 모델에 전달하지 않습니다. 메모는 이 기기에 저장됩니다.</p><form className="memory-form" onSubmit={async event => { event.preventDefault(); if (note.trim() && await aiDispatch({ type: 'memory.add', text: note.trim() })) setNote(''); }}><textarea className="text-input" rows={3} aria-label="저장할 메모" placeholder="기억해 둘 작업 선호사항" value={note} onChange={event => setNote(event.target.value)} disabled={aiDisabled || !state.settings.memoryEnabled} /><button className="secondary-button full" disabled={aiDisabled || !state.settings.memoryEnabled || !note.trim()}><Plus size={14} />메모 저장</button></form>{state.memory.length === 0 ? <p className="setting-help empty-note">저장된 메모가 없습니다.</p> : <ul className="memory-list">{state.memory.map(entry => <li key={entry.id}><p>{entry.text}</p><IconButton label="메모 삭제" disabled={aiDisabled} onClick={() => void aiDispatch({ type: 'memory.remove', id: entry.id })}><Trash2 size={14} /></IconButton></li>)}</ul>}</section><ResourcesSection state={state} dispatch={dispatch} /><p className="version">Sidework {state.appVersion} · 로컬 작업 공간</p></div>;
}

function ResourcesSection({ state, dispatch }: { state: AppState; dispatch: Dispatch }) {
  const [refreshing, setRefreshing] = useState(false);
  const sample = state.diagnostics;
  const summary = resourceSummary(sample);
  return <section className="settings-section resources-section" aria-label="리소스 진단">
    <div className="section-title-row"><h3>리소스</h3><button className="secondary-button compact" aria-label="리소스 새로고침" disabled={refreshing || !state.browserReady} onClick={async () => { setRefreshing(true); try { await dispatch({ type: 'diagnostics.refresh' }); } finally { setRefreshing(false); } }}><RefreshCw size={13} className={refreshing ? 'spin' : ''} />{refreshing ? '측정 중' : '새로고침'}</button></div>
    <p className="setting-help">버튼을 누를 때만 측정합니다. 자동 수집하지 않습니다.</p>
    {!sample || !summary ? <p className="setting-help">아직 측정하지 않았습니다.</p> : <>
      <p className="setting-help">측정 시각: <time dateTime={sample.sampledAt}>{new Date(sample.sampledAt).toLocaleString('ko-KR')}</time></p>
      <dl className="resource-metrics"><dt>탭 {sample.tabs}개</dt><dd>라이브 {sample.liveTabs} · 대기 {sample.dormantTabs}</dd><dt>프로세스</dt><dd>{summary.processCount}개</dd><dt>작업 집합 합계</dt><dd>{summary.workingSetMiB} MiB</dd><dt>브라우저 준비</dt><dd>{summary.browserCheckpoint}</dd><dt>AI 준비</dt><dd>{summary.agentCheckpoint}</dd></dl>
      <p className="setting-help">준비 시점은 프로세스 가동 시간 기준입니다. 실제 콜드 스타트 전체 지연 시간이 아닙니다.</p>
      <details className="resource-processes"><summary>프로세스별 세부 정보</summary><div className="resource-table-scroll"><table><caption>작업 집합 / 최대 작업 집합 · MiB</caption><thead><tr><th scope="col">역할 / PID</th><th scope="col">현재 / 최대</th><th scope="col">CPU</th></tr></thead><tbody>{sample.processes.map(process => <tr key={process.pid}><th scope="row">{process.role}<small>{process.pid}</small></th><td>{(process.workingSetKB / 1024).toFixed(1)} / {(process.peakWorkingSetKB / 1024).toFixed(1)}</td><td>{process.cpuPercent.toFixed(1)}%</td></tr>)}</tbody></table></div></details>
      {sample.caveat && <p className="setting-help">{sample.caveat}</p>}
    </>}
    <p className="setting-help resource-caveat">작업 집합 / RSS 합계는 공유 메모리를 중복 계산할 수 있으며 고유 물리 RAM이 아닙니다. 외부 모델 CLI 프로세스는 포함되지 않을 수 있습니다. 메모리 절감이나 Chrome 대비 우위를 뜻하지 않습니다.</p>
    <p className="setting-help">닫은 탭은 URL만 복원합니다. 입력한 폼과 POST 본문은 복원하지 않습니다.</p>
  </section>;
}

function ProfilesPanel({ state, dispatch, pending }: { state: AppState; dispatch: Dispatch; pending: boolean }) {
  const [name, setName] = useState('');
  const [incognito, setIncognito] = useState(false);
  return <div className="panel-scroll profiles-view" data-testid="profiles-panel"><div className="section-intro"><h3>분리된 작업 공간</h3><p>프로필마다 로그인과 탐색 환경을 분리합니다. 개인 Chrome 프로필은 사용하지 않습니다.</p></div><ul className="profile-list">{state.profiles.map(profile => <li key={profile.id}><button data-testid={`profile-${profile.id}`} disabled={pending} onClick={() => void dispatch({ type: 'profile.activate', profileId: profile.id })} aria-current={state.activeProfileId === profile.id ? 'true' : undefined}><span className="profile-avatar"><UserRound size={17} /></span><span><strong>{profile.name}</strong><small>{profile.incognito ? '비공개 세션' : '전용 영구 프로필'}</small></span>{profile.id === state.activeProfileId && <Check size={16} />}</button></li>)}</ul><section className="settings-section"><h3>새 프로필</h3><form onSubmit={async event => { event.preventDefault(); if (name.trim() && await dispatch({ type: 'profile.create', name: name.trim(), incognito })) { setName(''); setIncognito(false); } }}><label className="field-label" htmlFor="profile-name">프로필 이름</label><input id="profile-name" data-testid="profile-name" className="text-input" value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="예: 리서치" required /><label className="checkbox-line"><input type="checkbox" checked={incognito} onChange={event => setIncognito(event.target.checked)} />비공개 프로필로 만들기</label><button className="primary-button full" disabled={pending || !name.trim()}><Plus size={15} />프로필 만들기</button></form></section></div>;
}
