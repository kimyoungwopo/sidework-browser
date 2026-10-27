import type { AppCommand, AppState, ResourceSample } from '../contract';

export function resourceSummary(sample: ResourceSample | undefined) {
  if (!sample) return null;
  const checkpoint = (value: number | null) => value === null ? '미측정' : `${Math.round(value)} ms`;
  return { processCount: sample.processes.length, workingSetMiB: (sample.processes.reduce((total, process) => total + process.workingSetKB, 0) / 1024).toFixed(1), browserCheckpoint: checkpoint(sample.processUptimeAtBrowserReadyMs), agentCheckpoint: checkpoint(sample.processUptimeAtAgentReadyMs) };
}

export function readiness(state: AppState | null) {
  return { browser: Boolean(state?.browserReady), agent: Boolean(state?.bridgeReady), submit: Boolean(state?.browserReady && state.bridgeReady && state.providerStatus.installed && state.providerStatus.authenticated) };
}

export function panelConnectionCommand(panel: 'assistant' | 'history' | 'settings' | 'profiles'): AppCommand | null {
  return panel === 'profiles' ? null : { type: 'agent.connect' };
}

export function agentStatus(state: AppState | null): string {
  if (state?.agentConnecting) return 'AI 연결 중';
  if (!state?.bridgeReady) return 'AI 연결 안 됨';
  return state.providerStatus.installed && state.providerStatus.authenticated ? 'Codex · 로그인됨' : 'Codex · 설치 / 로그인 확인 필요';
}

export function browserLayout(width: number, url: string | undefined, panelOpen = false, splitCount = 1): Extract<AppCommand, { type: 'layout.set' }> {
  return { type: 'layout.set', left: width >= 1100 ? 228 : 64, top: 56, bottom: 0, sidebarWidth: panelOpen ? (width < 1200 ? 360 : 380) : 0, hideBrowser: splitCount === 1 && (!url || url === 'about:blank' || url === 'about:newtab') };
}

export function tabNavigationIndex(key:string,index:number,count:number,orientation:'vertical'|'horizontal'):number|null {
  if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(index)||index<0||index>=count)return null;
  if(key==='Home')return 0;
  if(key==='End')return count-1;
  if(key===(orientation==='vertical'?'ArrowDown':'ArrowRight'))return (index+1)%count;
  if(key===(orientation==='vertical'?'ArrowUp':'ArrowLeft'))return (index+count-1)%count;
  return null;
}

export function shouldSubmitComposer(key: string, shiftKey: boolean, isComposing: boolean, keyCode: number): boolean {
  return key === 'Enter' && !shiftKey && !isComposing && keyCode !== 229;
}
