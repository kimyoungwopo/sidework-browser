import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppState, BrowserTab, Job, JobStatus } from '../contract';
import { AGENT_AREA_LAYOUT } from '../agent-area-layout';
import './agent-area.css';

type Props = { state: AppState; dispatch: (command: AppCommand) => Promise<boolean> };
const statusNames: Record<JobStatus, string> = {
  queued: '대기 중', running: '진행 중', awaiting_approval: '행동 확인 대기',
  completed: '완료', cancelled: '취소됨', failed: '실패', interrupted: '중단됨', unknown: '결과 확인 필요',
};
const working = (job?: Job) => !!job && ['queued', 'running', 'awaiting_approval'].includes(job.status);
function pageJob(state: AppState, tab?: BrowserTab) {
  const jobs = state.jobs.filter(job => tab && job.profileId === tab.profileId && job.tabId === tab.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return jobs.find(working) ?? jobs[0];
}
function safeUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    if (!['https:', 'http:'].includes(url.protocol)) return '웹 주소 없음';
    // Approval metadata is not a second channel for credentials, query or fragment values.
    return `${url.origin}${url.pathname}`;
  } catch { return '주소 확인 불가'; }
}
function PageControls({ state, dispatch, tab, label }: Props & { tab?: BrowserTab; label: string }) {
  const job = pageJob(state, tab);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const flight = useRef(false);
  const current = useRef({ state, tab, job });
  current.current = { state, tab, job };
  const control = state.pageControls?.find(item => item.profileId === tab?.profileId && item.tabId === tab?.id);
  const run = async (command: AppCommand) => {
    if (flight.current || current.current.tab?.id !== tab?.id || current.current.tab?.profileId !== tab?.profileId) return;
    if (command.type === 'job.cancel' && current.current.job?.id !== command.jobId) return;
    flight.current = true; setPending(true); setError(false);
    try { if (!await dispatch(command)) setError(true); }
    catch { setError(true); }
    finally { flight.current = false; setPending(false); }
  };
  if (!tab) return null;
  return <>
    <h2 className="agent-area-page-title" title={tab.title}>{tab.title || '제목 없는 페이지'}</h2>
    <span className="agent-area-status" aria-label={`${label} 상태`}>{error ? '요청 실패 · 다시 확인' : control ? { reclaiming: '제어권 회수 중', user: '직접 사용 중', unknown: '중지 확인 필요' }[control.state] : job ? statusNames[job.status] : '작업 없음'}</span>
    <span className="agent-area-page-actions">
      <button type="button" aria-label={`${label} 직접 사용`} disabled={pending || !state.browserReady || control?.state === 'reclaiming'} onClick={() => {
        if (!pending && state.browserReady && control?.state !== 'reclaiming') void run({ type: 'tab.takeControl', profileId: tab.profileId, tabId: tab.id });
      }}>직접 사용</button>
      {working(job) && <button type="button" aria-label={`${label} 작업 중지`} disabled={pending || !state.bridgeReady} onClick={() => {
        if (!pending && state.bridgeReady && job) void run({ type: 'job.cancel', jobId: job.id });
      }}>중지</button>}
    </span>
  </>;
}

// UI is conservative; the main process still revalidates the exact ticket/document.
function canApprove(state: AppState, job: Job, tab?: BrowserTab) {
  const approval = job.approval;
  const scope = job.agentScope;
  const profile = state.profiles.find(item => item.id === job.profileId);
  return !!(state.browserReady && state.bridgeReady && profile && !profile.incognito &&
    job.status === 'awaiting_approval' && approval && approval.id && approval.digest &&
    tab && Boolean(tab.agentAreaId) && (state.agentPaneTabIds ?? state.paneTabIds ?? []).includes(tab.id) && tab.lifecycle !== 'dormant' &&
    job.profileId === state.activeProfileId && tab.profileId === job.profileId && tab.id === job.tabId &&
    approval.context.profileId === job.profileId && approval.context.tabId === job.tabId &&
    approval.revision === tab.revision && Date.parse(approval.expiresAt) > Date.now() &&
    (!scope || (scope.areaId === tab.agentAreaId && Date.parse(scope.expiresAt) > Date.now())) &&
    !state.pageControls?.some(item => item.profileId === job.profileId && item.tabId === job.tabId));
}
function ticketKey(job?: Job) {
  return job?.approval ? JSON.stringify([job.id, job.approval.id, job.approval.digest, job.approval.context, job.approval.revision, job.approval.expiresAt]) : '';
}
function Inspector({ state, dispatch, tabs }: Props & { tabs: BrowserTab[] }) {
  const jobs = state.jobs.filter(job => job.profileId === state.activeProfileId &&
    (job.agentScope || tabs.some(tab => tab.id === job.tabId && tab.profileId === job.profileId)));
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    jobs.find(job => job.id === state.activeJobId)?.id ?? jobs[0]?.id ?? null);
  // Do not follow incoming activeJobId/approval updates after a user selects inspection.
  const job = jobs.find(item => item.id === selectedId) ?? jobs[0];
  const tab = tabs.find(item => item.id === job?.tabId && item.profileId === job.profileId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  const flight = useRef(false);
  const consumed = useRef(new Set<string>());
  const current = useRef({ state, job, tab });
  current.current = { state, job, tab };
  const key = ticketKey(job);
  const expiry = job?.approval?.expiresAt;
  const scopeExpiry = job?.agentScope?.expiresAt;
  useEffect(() => {
    const dates = [expiry, scopeExpiry].map(value => Date.parse(value ?? '')).filter(value => Number.isFinite(value) && value > Date.now());
    if (!dates.length) return;
    const delay = Math.min(Math.max(1, Math.min(...dates) - Date.now() + 1), 2_147_483_647);
    const timer = setTimeout(() => setClock(value => value + 1), delay);
    return () => clearTimeout(timer);
  }, [expiry, scopeExpiry]);
  const allow = async () => {
    const latest = current.current;
    if (flight.current || !latest.job || ticketKey(latest.job) !== key || consumed.current.has(key) || !canApprove(latest.state, latest.job, latest.tab)) return;
    const approvalId = latest.job.approval!.id;
    flight.current = true; setPending(true); setError(null);
    try {
      if (await dispatch({ type: 'job.approve', jobId: latest.job.id, approvalId, allow: true })) consumed.current.add(key);
      else setError('확인 요청을 처리하지 못했습니다. 현재 상태를 확인하세요.');
    } catch { setError('확인 요청 연결 실패 · 현재 상태를 확인하세요.'); }
    finally { flight.current = false; setPending(false); }
  };
  const approval = job?.status === 'awaiting_approval' ? job.approval : null;
  const disabled = !job || !canApprove(state, job, tab) || pending || consumed.current.has(key);
  const goals = (state.goalTasks ?? []).filter(goal => goal.profileId === state.activeProfileId);
  const childFor = (item: Job) => goals.flatMap(goal => goal.children).find(child => child.jobId === item.id && (!child.context || child.context.tabId === item.tabId));
  const titleFor = (item: Job) => childFor(item)?.title || item.prompt.split('\n')[0] ||
    tabs.find(page => page.id === item.tabId)?.title || '이름 없는 작업';
  const taskButton = (item: Job) => <button key={item.id} type="button" className="agent-area-task" data-job-id={item.id} aria-label={`작업 선택 · ${titleFor(item)}`} aria-pressed={job?.id === item.id} onClick={() => { setSelectedId(item.id); setError(null); }}><span>{titleFor(item)}</span><small>{statusNames[item.status]}</small></button>;
  return <aside className="agent-area-inspector" aria-label="에이전트 작업 검사">
    <div className="agent-area-inspector-heading"><h2>작업</h2><span className="agent-area-muted">{jobs.length}개 브라우저 작업 · 화면은 함께 유지됩니다</span></div>
    <nav className="agent-area-task-list" aria-label="작업 목록">
      {goals.map(goal => <section key={goal.id} className="agent-area-task-group" aria-label={`목표 · ${goal.title}`}><h3>{goal.title}</h3>{goal.children.map(child => {
        const item = jobs.find(candidate => candidate.id === child.jobId && (!child.context || candidate.tabId === child.context.tabId));
        return item ? taskButton(item) : <div key={child.id} className="agent-area-task-unavailable"><span>{child.title}</span><small>{child.status === 'blocked' ? '실행 불가' : child.status === 'allocating' ? '작업 화면 준비 중' : '작업 연결 없음'}{child.error ? ` · ${child.error}` : ''}</small></div>;
      })}</section>)}
      {jobs.filter(item => !childFor(item)).map(taskButton)}
      {!jobs.length && !goals.length && <p className="agent-area-muted">에이전트 작업 없음</p>}
    </nav>
    <div className="agent-area-inspector-scroll" tabIndex={0} aria-label="선택 작업 상세">
      {!job ? <p className="agent-area-muted">에이전트 전용 페이지에서 시작한 작업이 여기에 표시됩니다.</p> : <>
        <section className="agent-area-current"><h3>{titleFor(job)}</h3><p>{statusNames[job.status]} · {job.steps}단계</p><p className="agent-area-muted">{tab?.title || '대상 페이지 없음'}</p>{job.error && <p className="agent-area-error">{job.error}</p>}</section>
        {approval && <section className="agent-area-approval" aria-label="확인이 필요한 행동">
          <h3>확인이 필요한 행동</h3>
          <p>중요한 행동이거나 영향 범위를 확인하지 못한 조작입니다. 일반 조작과 달리 자동으로 진행하지 않습니다. 내용을 판단할 수 없다면 실행하지 마세요.</p>
          <dl><dt>대상 URL (쿼리·인증 정보 숨김)</dt><dd>{safeUrl(tab?.url)}</dd><dt>문맥</dt><dd>프로필 {approval.context.profileId} · 페이지 {approval.context.tabId} · 문서 {approval.revision}</dd><dt>행동 다이제스트</dt><dd>{approval.digest}</dd><dt>확인 유효기한</dt><dd>{approval.expiresAt}</dd></dl>
          {job.agentScope && <dl><dt>작업 영역</dt><dd>{job.agentScope.areaId}</dd><dt>시작 출처</dt><dd>{safeUrl(job.agentScope.origin)}</dd><dt>작업 영역 유효기한</dt><dd>{job.agentScope.expiresAt}</dd></dl>}
          <button type="button" aria-label="확인 후 이 행동 실행" disabled={disabled} onClick={() => void allow()}>확인 후 이 행동 실행</button>
          {disabled && <p className="agent-area-muted">{pending ? '확인 요청 처리 중' : consumed.current.has(key) ? '이미 전달한 확인입니다.' : '대상·문서·프로필·유효기한 또는 연결 상태가 맞지 않아 허용할 수 없습니다.'}</p>}
        </section>}
        {error && <p role="alert" className="agent-area-error">{error}</p>}
        <section><h3>결과</h3><p className="agent-area-real-text">{job.answer ?? '아직 결과가 없습니다.'}</p>
          {job.artifacts.length > 0 && <ul className="agent-area-artifacts">{job.artifacts.map(artifact => <li key={artifact.id}><button type="button" aria-label={`결과 파일 열기 · ${artifact.name}`} onClick={() => void dispatch({ type: 'artifact.open', jobId: job.id, artifactId: artifact.id })}>{artifact.name}</button></li>)}</ul>}
        </section>
        <details className="agent-area-request" aria-label="원래 요청"><summary>원래 요청</summary><p className="agent-area-real-text">{childFor(job)?.prompt ?? job.prompt}</p></details>
      </>}
    </div>
  </aside>;
}

export default function AgentArea({ state, dispatch }: Props) {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const splitCount = state.splitCount ?? 1;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => { void dispatchRef.current({ type: 'layout.set', ...AGENT_AREA_LAYOUT }); };
    const resize = () => { clearTimeout(timer); timer = setTimeout(update, 150); };
    update();
    window.addEventListener('resize', resize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', resize); };
  }, [splitCount, state.browserReady]);
  // Parent projects tabs/paneTabIds to the native agent host. Ownership remains the final UI filter.
  const tabs = state.tabs.filter(tab => Boolean(tab.agentAreaId) && tab.profileId === state.activeProfileId);
  const paneIds = state.paneTabIds ?? (state.activeTabId ? [state.activeTabId] : []);
  const panes = Array.from({ length: splitCount }, (_, index) => tabs.find(tab => tab.id === paneIds[index]));
  const label = (tab: BrowserTab | undefined, index: number) => `에이전트 페이지 ${index + 1} · ${tab?.title || '빈 화면'}`;
  const columns = Math.min(splitCount, 4);
  return <div className="agent-area">
    <header className="agent-area-header">
      <div className="agent-area-heading"><h1>에이전트 작업 영역</h1><p>일반 조작 자동 · 중요한 행동은 확인</p></div>
      <div className="agent-area-main-chrome">{splitCount === 1 ? <PageControls state={state} dispatch={dispatch} tab={panes[0]} label={label(panes[0], 0)}/> : <span>{splitCount}개 에이전트 화면</span>}</div>
    </header>
    <main className="agent-area-grid" aria-label="에이전트 페이지 영역" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(splitCount / columns)}, minmax(0, 1fr))` }}>
      {panes.map((tab, index) => <section key={index} className="agent-area-pane" aria-label={label(tab, index)} data-native-tab={tab?.id}>
        {splitCount > 1 && <div className="agent-area-pane-chrome">{tab ? <PageControls state={state} dispatch={dispatch} tab={tab} label={label(tab, index)}/> : <span>빈 에이전트 화면 {index + 1}</span>}</div>}
        {!tab && <p className="agent-area-empty">빈 에이전트 화면 {index + 1}</p>}
        {/* Live pages are main-owned native views; never insert a replica here. */}
      </section>)}
    </main>
    <Inspector state={state} dispatch={dispatch} tabs={tabs}/>
  </div>;
}
