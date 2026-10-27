import { useEffect, useRef, useState } from 'react';
import type { AppCommand, AppState, JobStatus } from '../contract';
import type { GoalStatus, GoalTask } from '../goal-contract';

export const goalStatusNames: Record<GoalStatus | JobStatus | 'allocating' | 'blocked', string> = {
  planning: '계획 중', cancelling: '중지 중', allocating: '작업 화면 준비 중', queued: '대기 중', running: '진행 중', awaiting_approval: '승인 필요', blocked: '실행 불가', completed: '완료', partial: '일부 완료', failed: '실패', cancelled: '취소됨', interrupted: '중단됨', unknown: '결과 확인 필요',
};
export const goalWorking = (goal: GoalTask) => ['planning', 'running', 'awaiting_approval', 'cancelling'].includes(goal.status);
type Props = { goal: GoalTask; state: AppState; dispatch: (command: AppCommand) => Promise<boolean> };

export default function GoalTasks({ goal, state, dispatch }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false), consumed = useRef(new Set<string>());
  const [, setClock] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setClock(value => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  const run = async (command: AppCommand) => {
    if (flight.current) return;
    flight.current = true; setPending(true); setError(null);
    try {
      if (!await dispatch(command)) setError('요청 실패 · 현재 상태를 확인하고 다시 시도하세요.');
      else if (command.type === 'job.approve') consumed.current.add(`${command.jobId}:${command.approvalId}`);
    } catch { setError('요청 연결 실패 · 다시 시도하세요.'); }
    finally { flight.current = false; setPending(false); }
  };
  if (goal.profileId !== state.activeProfileId) return null;
  return <section className="goal-tasks panel-scroll" aria-label={`작업 상세 · ${goal.title}`}>
    <h3>{goal.title}</h3><p className="goal-prompt">{goal.prompt}</p>
    <div className="goal-status" role="status" aria-live="polite" aria-atomic="true">{goalStatusNames[goal.status]}</div>
    {goalWorking(goal) && <button type="button" className="secondary-button" aria-label={`${goal.title} 중지`} disabled={pending || !state.bridgeReady || goal.status === 'cancelling'} onClick={() => { if (goal.status !== 'cancelling') void run({ type: 'goals.cancel', goalId: goal.id }); }}>이 작업 중지</button>}
    <p className="setting-help">작업별 임시 세션 · 일반 탭의 로그인과 별개입니다. 추가 요청은 새 독립 작업으로 시작하세요.</p>
    {goal.error && <p role="alert">{goal.error}</p>}{error && <p role="alert">{error}</p>}
    <ul className="goal-children">{goal.children.map(child => {
      const job = state.jobs.find(item => item.id === child.jobId && item.profileId === goal.profileId && (!child.context || item.tabId === child.context.tabId));
      const tab = state.agentTabs?.find(item => item.id === child.context?.tabId && item.profileId === goal.profileId);
      const approval = job?.status === 'awaiting_approval' ? job.approval : null;
      const key = `${job?.id}:${approval?.id}`;
      const valid = !!(job && approval && approval.digest && state.profiles.some(profile => profile.id === job.profileId && !profile.incognito) && tab && tab.agentAreaId && state.browserReady && state.bridgeReady &&
        (state.agentPaneTabIds ?? []).includes(tab.id) && tab.lifecycle !== 'dormant' &&
        approval.context.profileId === job.profileId && approval.context.tabId === job.tabId && approval.revision === tab.revision &&
        Date.parse(approval.expiresAt) > Date.now() && (!job.agentScope || (job.agentScope.areaId === tab.agentAreaId && Date.parse(job.agentScope.expiresAt) > Date.now())) &&
        !state.pageControls?.some(item => item.profileId === job.profileId && item.tabId === job.tabId));
      return <li key={child.id} className="goal-child" aria-label={`하위 작업 · ${child.title}`}>
        <h4>{child.title}</h4><p role="status" aria-live="polite">{goalStatusNames[child.status]}{job ? ` · ${job.steps}단계` : ''}</p>
        {job?.events.at(-1)?.text && <p>{job.events.at(-1)!.text}</p>}
        {(job?.answer || child.answer) && <div className="answer"><strong>작업 결과</strong><p>{job?.answer || child.answer}</p></div>}
        {(child.error || job?.error) && <p className="job-error">{child.error || job?.error}</p>}
        {tab && <div className="goal-actions"><button type="button" className="secondary-button" aria-label={`${child.title} 화면 보기`} disabled={pending || !state.browserReady} onClick={() => void run({ type: 'agents.show' })}>화면 보기 · 작업 검사</button><button type="button" className="secondary-button" aria-label={`${child.title} 직접 사용`} disabled={pending || !state.browserReady || state.pageControls?.some(item => item.tabId === tab.id && item.profileId === tab.profileId && item.state === 'reclaiming')} onClick={() => void run({ type: 'tab.takeControl', profileId: tab.profileId, tabId: tab.id })}>직접 사용</button>{job && ['queued', 'running', 'awaiting_approval'].includes(job.status) && <button type="button" className="secondary-button" aria-label={`${child.title} 중지`} disabled={pending || !state.bridgeReady} onClick={() => void run({ type: 'job.cancel', jobId: job.id })}>하위 작업 중지</button>}</div>}
        {approval && job && <section className="goal-approval" aria-label={`${child.title} 행동 승인`}><p>승인 필요 · {approval.action.type} · 대상과 행동은 작업 화면에서 검사할 수 있습니다. 이번 행동에만 적용됩니다.</p><p>{approval.summary}</p><button type="button" className="secondary-button" aria-label={`${child.title} 행동 거부`} disabled={pending || !state.bridgeReady || consumed.current.has(key)} onClick={() => void run({ type: 'job.approve', jobId: job.id, approvalId: approval.id, allow: false })}>거부</button><button type="button" className="primary-button" aria-label={`${child.title} 이번 행동 허용`} disabled={pending || !valid || consumed.current.has(key)} onClick={() => { if (valid && !consumed.current.has(key)) void run({ type: 'job.approve', jobId: job.id, approvalId: approval.id, allow: true }); }}>이번 행동 허용</button>{!valid && <p className="setting-help">대상 화면·승인 만료를 확인하세요. 작업 화면에서 검사할 수 있습니다.</p>}</section>}
      </li>;
    })}</ul>
  </section>;
}
