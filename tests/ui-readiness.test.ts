import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as React from 'react';
import type { AppCommand, AppState } from '../src/contract.ts';
import { DEFAULT_SETTINGS } from '../src/contract.ts';

function fixture(patch: Partial<AppState> = {}): AppState {
  return { profiles: [{ id: 'default', name: '기본', incognito: false }], activeProfileId: 'default', tabs: [{ id: 'tab', profileId: 'default', title: '새 탭', url: 'about:blank', isLoading: false, canGoBack: false, canGoForward: false, ownership: 'user', revision: 0 }], activeTabId: 'tab', jobs: [], activeJobId: null, settings: DEFAULT_SETTINGS, memory: [], providerStatus: { installed: true, authenticated: true, liveVerified: false, detail: '' }, browserReady: true, bridgeReady: false, agentConnecting: false, error: null, appVersion: 'test', ...patch };
}

function controlFixture(): AppState {
  const base = desktopFixture();
  const job: AppState['jobs'][number] = { id: 'control-job', profileId: 'default', tabId: 'tab', status: 'running', prompt: 'control', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
  return { ...base, bridgeReady: true, jobs: [job], activeJobId: job.id, activeJobIds: [job.id], controlVisuals: [{ profileId: job.profileId, tabId: job.tabId, jobId: job.id, phase: 'working' }] };
}
test('spaces overview is explicit browser UI showing only current visible pages without inference or capture', async () => {
  const initial = sectionFixture();
  const hidden = { ...initial.tabs[0], id: 'hidden', title: '숨긴 탭' };
  const foreign = { ...initial.tabs[0], id: 'foreign', profileId: 'other', title: '다른 프로필' };
  const ui = await harness({ ...initial, tabs: [...initial.tabs, hidden, foreign] });
  try {
    assert.equal(ui.label('작업 공간').props['aria-expanded'], false);
    assert.equal(ui.commands.some(c => c.type !== 'layout.set'), false);
    await ui.click('작업 공간');
    assert.equal(ui.label('작업 공간').props['aria-expanded'], true);
    const overview = ui.label('현재 열린 작업 화면');
    assert.equal(descendants(overview).filter(n => n.props['data-space-tab']).length, 2);
    assert.doesNotMatch(nodeText(overview), /숨긴 탭|다른 프로필/);
    assert.match(nodeText(overview), /현재 보이는 페이지/);
    const bounds = ui.commands.filter(c => c.type === 'layout.set').at(-1);
    assert.equal(bounds?.top, 56); assert.equal(bounds?.sidebarWidth, 380); assert.equal(bounds?.hideBrowser, false);
    assert.equal(ui.commands.some(c => c.type !== 'layout.set'), false);
    await ui.click('작업 공간');
    assert.equal(ui.all().find(n => n.type === 'aside')?.props.hidden, true);
  } finally { ui.cleanup(); }
});

test('spaces previews are fetched only by explicit per-page refresh and accept exact current PNG identity', async () => {
  const initial = sectionFixture(); const ui = await harness(initial);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  const preview = { profileId: 'default', tabId: 'second', revision: 4, imageDataUrl: png };
  try {
    await ui.click('작업 공간');
    assert.equal(ui.commands.some(c => c.type === 'tab.preview'), false);
    assert.match(nodeText(ui.label('작업 화면 2')), /미리보기 새로고침/);
    await ui.click('작업 화면 2 미리보기 새로고침');
    assert.deepEqual(ui.commands.filter(c => c.type === 'tab.preview'), [{ type: 'tab.preview', profileId: 'default', tabId: 'second' }]);
    await ui.update({ ...initial, pagePreviews: [preview] });
    assert.equal(ui.all().find(n => n.type === 'img')?.props.src, png);
    for (const patch of [
      { profileId: 'other' }, { tabId: 'hidden' }, { revision: 3 }, { imageDataUrl: null },
      { imageDataUrl: 'https://example.com/screenshot.png' }, { imageDataUrl: 'data:image/svg+xml;base64,AAAA' },
      { imageDataUrl: 'data:image/png;base64,not valid!' }, { imageDataUrl: 'data:image/png;base64,AAAA' }, { error: '캡처 실패' },
    ]) {
      await ui.update({ ...initial, pagePreviews: [{ ...preview, ...patch }] });
      assert.equal(ui.all().some(n => n.type === 'img'), false, JSON.stringify(patch));
      assert.match(nodeText(ui.label('작업 화면 2')), /미리보기 새로고침/);
    }
    await ui.update({ ...initial, tabs: [initial.tabs[0], { ...initial.tabs[1], revision: 5 }], pagePreviews: [preview] });
    assert.equal(ui.all().some(n => n.type === 'img'), false);
    await ui.render(); await ui.render();
    assert.equal(ui.commands.filter(c => c.type === 'tab.preview').length, 1);
    assert.equal(ui.commands.some(c => c.type === 'agent.connect' || c.type === 'job.start' || c.type === 'jobs.startSections' || c.type === 'job.approve'), false);
  } finally { ui.cleanup(); }
});

test('spaces actions select inspect stop and reclaim only the exact page and job while peers stay independent', async () => {
  const base = sectionFixture(), running = controlFixture().jobs[0];
  const jobs = base.tabs.map((tab, i) => ({ ...running, id: `space-job-${i}`, tabId: tab.id, prompt: `실제 요청 ${i}`, createdAt: '2026-10-24T01:00:00Z' }));
  const initial: AppState = { ...base, jobs: [{ ...jobs[1], id: 'older', status: 'completed', prompt: '이전 요청', createdAt: '2026-10-23T01:00:00Z' }, ...jobs], activeJobIds: jobs.map(j => j.id), activeJobId: jobs[0].id, controlVisuals: jobs.map(j => ({ profileId: j.profileId, tabId: j.tabId, jobId: j.id, phase: 'working' })) };
  const ui = await harness(initial);
  try {
    await ui.click('작업 공간');
    assert.match(nodeText(ui.label('작업 화면 2')), /Second.*실제 요청 1.*진행 중/s);
    assert.doesNotMatch(nodeText(ui.label('작업 화면 2')), /실제 요청 0|이전 요청/);
    assert.equal(nodeText(ui.label('작업 화면 2 AI 제어 상태')), 'AI 판단 중');
    assert.equal(ui.commands.some(c => c.type !== 'layout.set'), false);
    await ui.click('작업 화면 2 열기');
    assert.deepEqual(ui.commands.filter(c => c.type === 'tab.activate'), [{ type: 'tab.activate', tabId: 'second' }]);
    await ui.click('작업 화면 2 작업 중지');
    assert.deepEqual(ui.commands.filter(c => c.type === 'job.cancel'), [{ type: 'job.cancel', jobId: jobs[1].id }]);
    await ui.click('작업 화면 2 직접 사용');
    assert.deepEqual(ui.commands.filter(c => c.type === 'tab.takeControl'), [{ type: 'tab.takeControl', profileId: 'default', tabId: 'second' }]);
    assert.equal(nodeText(ui.label('작업 화면 1 AI 제어 상태')), 'AI 판단 중');
    await ui.click('작업 화면 2 작업 보기');
    assert.equal(ui.label('검토할 작업').props.value, jobs[1].id);
    assert.equal(ui.commands.some(c => c.type === 'agent.connect' || c.type === 'job.start' || c.type === 'jobs.cancelAll' || c.type === 'job.approve' || c.type === 'tab.preview'), false);
    await ui.click('작업 공간');
    await ui.update({ ...initial, jobs: jobs.map(j => ({ ...j, status: 'completed' })), activeJobIds: [], activeJobId: null });
    assert.match(nodeText(ui.label('작업 화면 2')), /완료/);
    assert.equal(ui.all().some(n => n.props['aria-label'] === '작업 화면 2 작업 중지'), false);
    await ui.update({ ...initial, jobs: [], activeJobIds: [], activeJobId: null });
    assert.match(nodeText(ui.label('작업 화면 2')), /직접 탐색.*요청한 AI 작업이 없습니다/s);
  } finally { ui.cleanup(); }
});

test('spaces preview refresh flights are page-local bounded and recover only on another explicit click', async () => {
  const initial = sectionFixture(), ui = await harness(initial);
  const finishes = new Map<string, (state: AppState) => void>();
  const original = window.sidework!.dispatch;
  try {
    await ui.click('작업 공간');
    window.sidework!.dispatch = command => command.type === 'tab.preview' ? new Promise(resolve => { ui.commands.push(command); finishes.set(command.tabId, resolve); }) : original(command);
    const first = ui.label('작업 화면 1 미리보기 새로고침').props.onClick as () => void;
    first(); first(); await ui.render();
    assert.equal(ui.label('작업 화면 1 미리보기 새로고침').props.disabled, true);
    assert.equal(ui.label('작업 화면 2 미리보기 새로고침').props.disabled, false);
    await ui.click('작업 화면 2 미리보기 새로고침');
    assert.deepEqual(ui.commands.filter(c => c.type === 'tab.preview').map(c => c.tabId), ['tab', 'second']);
    for (const finish of finishes.values()) finish({ ...initial, pagePreviews: [{ profileId: 'default', tabId: 'tab', revision: 0, imageDataUrl: null, error: '캡처 실패' }] });
    await ui.render(); await ui.render();
    assert.equal(ui.commands.filter(c => c.type === 'tab.preview').length, 2);
    assert.match(nodeText(ui.label('작업 화면 1')), /캡처 실패.*다시 새로고침/);
    await ui.update({ ...initial, activeProfileId: 'other' });
    assert.equal(ui.all().filter(n => n.props['data-space-tab']).length, 0);
    assert.match(ui.text(), /현재 보이는 페이지가 없습니다/);
  } finally { for (const finish of finishes.values()) finish(initial); ui.cleanup(); }
});

function nodeText(node: Node): string { return node.type === '#text' ? String(node.props.text) : node.children.map(nodeText).join(''); }
function descendants(node: Node): Node[] { return [node, ...node.children.flatMap(descendants)]; }

test('refined composer collapses advanced controls without hiding the primary request target or submit', async () => {
  const ui = await harness(sectionFixture());
  try {
    await ui.click('어시스턴트');
    const disclosure = ui.all().find(node => node.type === 'details' && node.props.className === 'composer-options');
    assert.ok(disclosure, 'advanced options belong in a native disclosure');
    assert.notEqual(disclosure.props.open, true);
    assert.match(nodeText(disclosure.children.find(node => node.type === 'summary')!), /작업 옵션/);
    const nested = descendants(disclosure);
    for (const name of ['작업 방식', '보이는 화면 일괄 실행']) assert.ok(nested.includes(ui.label(name)), name);
    assert.ok(nested.some(node => node.props.className === 'provider-activity'));
    for (const name of ['AI에게 요청', '작업 대상 화면', '선택 화면 공유 동의', '에이전트에게 맡기기', '모든 작업 중지']) assert.ok(!nested.includes(ui.label(name)), `${name} stays visible`);
    assert.equal(ui.label('작업 방식').props.value, 'dom');
    assert.equal(ui.label('선택 화면 공유 동의').props.checked, false);
    assert.equal(ui.all().some(node => node.props['aria-label'] === '첫 스크롤 동시 시작'), false);
    assert.match(ui.text(), /일반 조작은 자동 진행.*중요한 행동이나 영향이 불명확한 조작은 작업 영역에서 확인/);
    assert.equal(ui.commands.some(command => command.type === 'job.start' || command.type === 'jobs.startVisible'), false);
  } finally { ui.cleanup(); }
});

test('refined takeover exposes a readable explicit action in each busy pane without changing bounds', async () => {
  const base = controlFixture();
  const tabs = [base.tabs[0], { ...base.tabs[0], id: 'peer' }];
  const ui = await harness({ ...base, tabs, splitCount: 2, paneTabIds: ['tab', 'peer'] });
  try {
    assert.equal(nodeText(ui.label('화면 1 직접 사용')), '직접 사용');
    assert.equal(nodeText(ui.label('화면 2 직접 사용')), '직접 사용');
    assert.equal(ui.label('화면 1 직접 사용').props.className, 'takeover-button');
    assert.equal(ui.commands.filter(command => command.type === 'layout.set').at(-1)?.top, 56);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.pane-header:has\(> \.takeover-button\) > \.takeover-button\s*\{[^}]*min-width: 62px/);
    assert.match(css, /\.takeover-button:focus-visible\s*\{[^}]*outline-offset: -2px/);
    assert.match(css, /\.takeover-button:hover:not\(:disabled\)\s*\{/);
  } finally { ui.cleanup(); }
});

test('refined approval keeps a named target and equally large deliberate allow deny actions', async () => {
  const base = controlFixture();
  const job: AppState['jobs'][number] = { ...base.jobs[0], steps: 1, status: 'awaiting_approval', approval: { id: 'review-one', action: { type: 'navigate', url: 'https://example.com/next' }, digest: 'digest', context: { profileId: 'default', tabId: 'tab' }, revision: 0, expiresAt: '2099-01-01T00:00:00Z', summary: 'navigate' } };
  const ui = await harness({ ...base, jobs: [job] });
  try {
    const card = ui.label('행동 승인 요청');
    const buttons = descendants(card).filter(node => node.type === 'button');
    assert.equal(nodeText(ui.label('승인 대상')), 'https://example.com/next');
    assert.equal(nodeText(ui.label('작업 상태')), '승인 필요1단계');
    assert.deepEqual(buttons.map(node => node.props.type), ['button', 'button']);
    assert.ok(buttons.every(node => !node.props.autoFocus));
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.approval-actions\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.approval-actions > button\s*\{[^}]*min-height: 40px;[^}]*font-size: 13px/);
    assert.match(css, /\.request-message > span\s*\{[^}]*font-size: 11px/);
    assert.equal(ui.commands.some(command => command.type === 'job.approve'), false);
    (buttons[0].props.onClick as () => void)(); await ui.render();
    assert.deepEqual(ui.commands.filter(command => command.type === 'job.approve'), [{ type: 'job.approve', jobId: job.id, approvalId: 'review-one', allow: false }]);
  } finally { ui.cleanup(); }
});

test('page takeover uses exact profile and page without connecting AI and shows acknowledged ownership',async()=>{
 const initial=controlFixture(),ui=await harness(initial);try{
  await ui.click('이 화면 직접 사용');assert.deepEqual(ui.commands.filter(command=>command.type!=='layout.set'),[{type:'tab.takeControl',profileId:'default',tabId:'tab'}]);
  await ui.update({...initial,pageControls:[{profileId:'default',tabId:'tab',state:'reclaiming'}]});assert.equal(nodeText(ui.label('선택 화면 제어권 상태')),'제어권 회수 중');assert.equal(ui.label('이 화면 직접 사용').props.disabled,true);assert.equal(ui.all().some(node=>node.props['aria-label']==='선택 화면 AI 제어 상태'),false);
  await ui.update({...initial,jobs:[{...initial.jobs[0],status:'cancelled'}],activeJobId:null,activeJobIds:[],pageControls:[{profileId:'default',tabId:'tab',state:'user'}]});assert.equal(nodeText(ui.label('선택 화면 제어권 상태')),'직접 사용 중');assert.equal(ui.label('이 화면 직접 사용').props.disabled,true);
  await ui.update({...initial,pageControls:[{profileId:'default',tabId:'tab',state:'unknown'}]});assert.equal(nodeText(ui.label('선택 화면 제어권 상태')),'중지 확인 필요');assert.equal(ui.commands.some(command=>command.type==='job.start'||command.type==='agent.connect'),false);
 }finally{ui.cleanup();}
});

test('page takeover flights are page-local and preserve the peer control badge',async()=>{
 const base=controlFixture();const tabs=[{...base.tabs[0],id:'a'},{...base.tabs[0],id:'b'}],jobs=tabs.map((tab,index)=>({...base.jobs[0],id:`job-${index}`,tabId:tab.id}));
 const initial:AppState={...base,tabs,jobs,activeTabId:'a',activeJobId:jobs[0].id,activeJobIds:jobs.map(job=>job.id),splitCount:2,paneTabIds:['a','b'],controlVisuals:jobs.map(job=>({profileId:'default',tabId:job.tabId,jobId:job.id,phase:'working'}))};
 const ui=await harness(initial),pending=new Map<string,(value:AppState)=>void>();try{
  window.sidework!.dispatch=command=>{ui.commands.push(command);return command.type==='tab.takeControl'?new Promise(resolve=>pending.set(command.tabId,resolve)):Promise.resolve(initial);};
  await ui.click('화면 2 직접 사용');assert.equal(ui.label('화면 2 직접 사용').props.disabled,true);assert.notEqual(ui.label('화면 1 직접 사용').props.disabled,true);await ui.click('화면 1 직접 사용');
  assert.deepEqual(ui.commands.filter(command=>command.type==='tab.takeControl'),[{type:'tab.takeControl',profileId:'default',tabId:'b'},{type:'tab.takeControl',profileId:'default',tabId:'a'}]);
  for(const finish of pending.values())finish(initial);await ui.render();await ui.update({...initial,pageControls:[{profileId:'default',tabId:'b',state:'user'}]});assert.equal(nodeText(ui.label('화면 1 AI 제어 상태')),'AI 판단 중');assert.equal(nodeText(ui.label('화면 2 제어권 상태')),'직접 사용 중');
 }finally{for(const finish of pending.values())finish(initial);ui.cleanup();}
});

test('control chrome selected single page reports real thinking phase without pointer coordinates', async () => {
  const ui = await harness(controlFixture());
  try {
    const badge = ui.label('선택 화면 AI 제어 상태');
    assert.equal(nodeText(badge), 'AI 판단 중');
    assert.equal(badge.props['aria-live'], 'polite');
    assert.equal(badge.props['aria-atomic'], true);
    assert.equal(ui.all().some(node => node.props['data-control-pointer']), false);
    assert.ok(ui.label('화면별 AI'));
    assert.ok(ui.label('어시스턴트'));
    assert.ok(ui.label('Codex Desktop 연결'));
    assert.equal(ui.commands.filter(c => c.type === 'layout.set').at(-1)?.top, 56);
  } finally { ui.cleanup(); }
});

test('control chrome rejects stale ownership jobs profiles tabs and terminal feedback', async () => {
  const base = controlFixture();
  const ui = await harness(base);
  try {
    const patches: Partial<AppState>[] = [
      { controlVisuals: [{ ...base.controlVisuals![0], jobId: 'old-job' }] },
      { controlVisuals: [{ ...base.controlVisuals![0], profileId: 'other' }] },
      { controlVisuals: [{ ...base.controlVisuals![0], tabId: 'other' }] },
      { activeJobId: null, activeJobIds: [] },
      { activeProfileId: 'other' },
      { jobs: [{ ...base.jobs[0], profileId: 'other' }] },
      { jobs: [{ ...base.jobs[0], tabId: 'other' }] },
      ...(['completed', 'cancelled', 'failed', 'interrupted', 'unknown'] as const).map(status => ({ jobs: [{ ...base.jobs[0], status }] })),
      { controlVisuals: undefined },
    ];
    for (const patch of patches) {
      await ui.update({ ...base, ...patch });
      assert.equal(ui.all().some(node => node.props['aria-label'] === '선택 화면 AI 제어 상태'), false, JSON.stringify(patch));
      await ui.update(base);
      assert.equal(nodeText(ui.label('선택 화면 AI 제어 상태')), 'AI 판단 중');
    }
  } finally { ui.cleanup(); }
});

test('control chrome differentiates approval thinking and actual control stages without position announcements', async () => {
  const base = controlFixture();
  const ui = await harness(base);
  try {
    const phases = { working: 'AI 판단 중', awaiting_approval: '승인 대기', moving: '이동 중', clicking: '클릭 중', typing: '입력 중', scrolling: '스크롤 중' } as const;
    for (const [phase, expected] of Object.entries(phases)) {
      const status = phase === 'awaiting_approval' ? 'awaiting_approval' : 'running';
      const next = { ...base, jobs: [{ ...base.jobs[0], status }], controlVisuals: [{ ...base.controlVisuals![0], phase, x: 12, y: 34 }] } as AppState;
      await ui.update(next);
      const badge = ui.label('선택 화면 AI 제어 상태');
      assert.equal(nodeText(badge), expected);
      assert.equal(badge.props['data-control-phase'], phase);
      assert.equal(badge.props.title, ['working', 'awaiting_approval'].includes(phase) ? expected : `AI 제어 중 · ${expected}`);
      await ui.update({ ...next, controlVisuals: [{ ...next.controlVisuals![0], x: 999, y: 777 }] });
      assert.equal(nodeText(ui.label('선택 화면 AI 제어 상태')), expected);
    }
    // An approval snapshot must never claim stale pointer execution.
    await ui.update({ ...base, jobs: [{ ...base.jobs[0], status: 'awaiting_approval' }], controlVisuals: [{ ...base.controlVisuals![0], phase: 'clicking' }] });
    assert.equal(ui.all().some(node => node.props['aria-label'] === '선택 화면 AI 제어 상태'), false);
  } finally { ui.cleanup(); }
});

test('control chrome keeps two panes independent across focus approval stop and eight-pane grids', async () => {
  const base = controlFixture();
  const tabs = Array.from({ length: 8 }, (_, i) => ({ ...base.tabs[0], id: `control-${i}` }));
  const jobs = tabs.slice(0, 2).map((tab, i) => ({ ...base.jobs[0], id: `job-${i}`, tabId: tab.id, status: i === 0 ? 'running' as const : 'awaiting_approval' as const }));
  const initial: AppState = { ...base, tabs, activeTabId: tabs[0].id, splitCount: 8, paneTabIds: tabs.map(tab => tab.id), jobs, activeJobId: jobs[0].id, activeJobIds: jobs.map(job => job.id), controlVisuals: jobs.map((job, i) => ({ profileId: job.profileId, tabId: job.tabId, jobId: job.id, phase: i === 0 ? 'moving' : 'awaiting_approval' })) };
  const ui = await harness(initial);
  try {
    assert.equal(nodeText(ui.label('화면 1 AI 제어 상태')), '이동 중');
    assert.equal(nodeText(ui.label('화면 2 AI 제어 상태')), '승인 대기');
    assert.equal(ui.all().filter(node => node.props['data-control-phase']).length, 2);
    assert.equal(ui.all().some(node => node.props['aria-label'] === '선택 화면 AI 제어 상태'), false);
    for (let i = 1; i <= 8; i++) { ui.label(`화면 ${i} 주소`); ui.label(`화면 ${i} 컴퓨터 작업`); }
    await ui.update({ ...initial, activeTabId: tabs[1].id });
    assert.equal(nodeText(ui.label('화면 1 AI 제어 상태')), '이동 중');
    await ui.click('화면 1 작업 중지');
    assert.deepEqual(ui.commands.at(-1), { type: 'job.cancel', jobId: jobs[0].id });
    await ui.update({ ...initial, jobs: [{ ...jobs[0], status: 'cancelled' }, jobs[1]], activeJobIds: [jobs[1].id] });
    assert.equal(ui.all().some(node => node.props['aria-label'] === '화면 1 AI 제어 상태'), false);
    assert.equal(nodeText(ui.label('화면 2 AI 제어 상태')), '승인 대기');
    await ui.click('어시스턴트');
    assert.equal(ui.commands.filter(c => c.type === 'layout.set').at(-1)?.sidebarWidth, 380);
  } finally { ui.cleanup(); }
});

test('control chrome styles reserve compact readable blue cyan feedback without idle or reduced-motion loops', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const badge = css.match(/\.control-badge\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(badge, /linear-gradient\(110deg, #e7efff, #e3f7fa\)/);
  assert.match(badge, /color: #204b78/);
  assert.match(badge, /flex: 0 0 auto/);
  assert.match(badge, /white-space: nowrap/);
  assert.match(badge, /animation: none/);
  assert.match(badge, /transition: none/);
  assert.match(css, /\.pane-header > \.control-badge\s*\{[^}]*font-size: 10px/);
  assert.match(css, /\.pane-header:has\(> \.control-badge\) > button\s*\{[^}]*min-width: 20px/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none !important; transition: none !important/);
});

test('native submission trace renders 검색 제출 rather than pretending a button click',async()=>{
 const state=controlFixture();state.jobs[0]!.events=[{id:'submit',at:'now',kind:'action',text:'submit_search'}];
 const ui=await harness(state);
 try{
  const history=ui.all().find(node=>node.type==='button'&&node.props['aria-label']==='전체 작업 기록 열기');
  if(history){await ui.click('전체 작업 기록 열기');}
  else {const button=ui.all().find(node=>node.type==='button'&&node.children.some(child=>child.props.text==='기록'));assert(button);(button.props.onClick as ()=>void)();await ui.render();}
  const contains=(node:Node):boolean=>node.props.text==='control'||node.children.some(contains);
  const select=ui.all().find(node=>node.type==='button'&&contains(node));assert(select);
  (select.props.onClick as ()=>void)();await ui.render();
  assert.match(ui.text(),/실행 기록/);
  assert.match(ui.text(),/검색 제출/);assert.doesNotMatch(ui.text(),/submit_search/);
 }finally{ui.cleanup();}
});

// Execute actual components without launching Electron, a browser, or providers.
// Only React hook scheduling / desktop I/O are substituted; handlers and JSX are real.
type Node = { type: string; props: Record<string, unknown>; children: Node[] };
type Element = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> };
async function harness(initial = fixture()) {
  let state = initial;
  let listener: ((state: AppState) => void) | undefined;
  const commands: AppCommand[] = [];
  const events = new Map<string, (event: unknown) => void>();
  const slots = new Map<string, unknown[]>();
  let current: unknown[] = [], cursor = 0;
  let effects: (() => void)[] = [];
  const hooks = { ...React,
    useState(value: unknown) { const owner = current, index = cursor++; if (!(index in owner)) owner[index] = value; return [owner[index], (next: unknown) => { owner[index] = typeof next === 'function' ? next(owner[index]) : next; }]; },
    useRef(value: unknown) { const index = cursor++; return current[index] ??= { current: value }; },
    useCallback(fn: unknown, deps: unknown[]) { const index = cursor++; const previous = current[index] as { fn: unknown; deps: unknown[] } | undefined; if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) current[index] = { fn, deps }; return (current[index] as { fn: unknown }).fn; },
    useEffect(fn: () => void, deps: unknown[]) { const index = cursor++; const previous = current[index] as unknown[] | undefined; if (!previous || deps.some((dep, i) => dep !== previous[i])) { current[index] = deps; effects.push(fn); } },
  };
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.assign(globalThis, { window: { innerWidth: 1440, addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn), removeEventListener: (name: string) => events.delete(name), setInterval: () => 1, clearInterval: () => {}, sidework: { getState: async () => state, onState: (fn: typeof listener) => { listener = fn; return () => {}; }, dispatch: async (command: AppCommand) => { commands.push(command); return state; } } }, document: { getElementById: () => null } });
  const require = createRequire(new URL('../src/renderer/App.tsx', import.meta.url));
  // Both surfaces execute their actual component code with the same hook scheduler.
  // CSS is a bundler concern; intercept only stylesheet imports, never App handlers.
  const load = (file: string): { default: (props: Record<string, unknown>) => unknown } => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
    const module = { exports: {} as { default: (props: Record<string, unknown>) => unknown } };
    new Function('require', 'module', 'exports', code)((name: string) => name === 'react' ? hooks : name.endsWith('.css') ? {} : name === './AgentArea' ? load('../src/renderer/AgentArea.tsx') : require(name), module, module.exports);
    return module.exports;
  };
  const app = load('../src/renderer/App.tsx');
  function expand(value: unknown, path: string): Node[] {
    if (value === null || value === undefined || typeof value === 'boolean') return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => expand(item, `${path}.${index}`));
    if (typeof value !== 'object') return [{ type: '#text', props: { text: String(value) }, children: [] }];
    const element = value as Element;
    if (typeof element.type === 'function') { current = slots.get(path) ?? []; slots.set(path, current); cursor = 0; return expand(element.type(element.props), `${path}.render`); }
    return [{ type: typeof element.type === 'string' ? element.type : 'fragment', props: element.props, children: expand(element.props.children, `${path}.children`) }];
  }
  let tree: Node[] = [];
  async function render() { for (let i = 0; i < 4; i++) { effects = []; tree = expand({ type: app.default, props: {} }, 'app'); const batch = effects; effects = []; batch.forEach(fn => fn()); await Promise.resolve(); await Promise.resolve(); } }
  const all = (): Node[] => { const walk = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...walk(node.children)]); return walk(tree); };
  const label = (name: string) => { const node = all().find(node => node.props['aria-label'] === name); assert.ok(node, `missing control ${name}`); return node; };
  const text = () => all().filter(node => node.type === '#text').map(node => node.props.text).join('');
  const click = async (name: string) => { const node = label(name); assert.ok(!node.props.disabled, `disabled control ${name}`); (node.props.onClick as () => void)(); await render(); };
  await render();
  return { commands, label, text, click, all, render, events, async update(next: AppState) { state = next; listener?.(next); await render(); }, cleanup() { Object.assign(globalThis, { window: originalWindow, document: originalDocument }); } };
}

test('Codex Desktop header opens a browser-first handoff panel and checks only the official desktop', async () => {
  const base = fixture();
  const ui = await harness({ ...base, tabs: [{ ...base.tabs[0], url: 'https://example.com' }] });
  try {
    await ui.click('Codex Desktop 연결');
    assert.equal(ui.all().find(node => node.type === 'aside')?.props.hidden, false);
    assert.ok(ui.label('AI에게 요청'));
    assert.match(ui.text(), /공식 Codex Desktop/);
    await ui.click('Codex Desktop 연결 확인');
    assert.deepEqual(ui.commands.filter(c => c.type !== 'layout.set'), [{ type: 'codexDesktop.check' }]);
    const bounds = ui.commands.filter(c => c.type === 'layout.set').at(-1);
    assert.equal(bounds?.sidebarWidth, 380);
    assert.equal(bounds?.top, 56);
    assert.equal(bounds?.hideBrowser, false);
  } finally { ui.cleanup(); }
});

function desktopFixture(): AppState {
  const base = fixture({ codexDesktop: { installed: true, targetReady: true, detail: 'desktop probe', version: '26.test' } });
  return { ...base, tabs: [{ ...base.tabs[0], url: 'https://example.com/page' }] };
}
async function change(ui: Awaited<ReturnType<typeof harness>>, name: string, value: string | boolean) {
  (ui.label(name).props.onChange as (e: unknown) => void)({ target: typeof value === 'boolean' ? { checked: value } : { value } });
  await ui.render();
}

test('Codex Desktop primary fails closed unless installed packaged visible public target prompt and consent are valid', async () => {
  const initial = desktopFixture();
  const ui = await harness(initial);
  try {
    await ui.click('Codex Desktop 연결');
    assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, true);
    await change(ui, 'AI에게 요청', 'read the page');
    assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, true);
    await change(ui, 'Codex Desktop 전달 동의', true);
    assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, false); // No CLI worker required.
    const invalid: Partial<AppState>[] = [
      { browserReady: false }, { codexDesktop: undefined },
      { codexDesktop: { installed: false, targetReady: true, detail: '' } },
      { codexDesktop: { installed: true, targetReady: false, detail: '' } },
      { tabs: [{ ...initial.tabs[0], url: 'about:blank' }] },
      { tabs: [{ ...initial.tabs[0], url: 'about:newtab' }] },
      { tabs: [{ ...initial.tabs[0], url: '' }] },
      { paneTabIds: ['missing'] },
      { profiles: [{ ...initial.profiles[0], incognito: true }] },
      { profiles: [] },
    ];
    for (const patch of invalid) {
      await ui.update({ ...initial, ...patch });
      await change(ui, 'Codex Desktop 전달 동의', true);
      assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, true, JSON.stringify(patch));
      (ui.label('Codex Desktop에서 계속').props.onClick as () => void)(); await ui.render();
    }
    await ui.update(initial);
    for (const prompt of ['   ', 'x'.repeat(4001)]) {
      await change(ui, 'AI에게 요청', prompt);
      await change(ui, 'Codex Desktop 전달 동의', true);
      assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, true);
      (ui.label('Codex Desktop에서 계속').props.onClick as () => void)(); await ui.render();
    }
    await change(ui, 'AI에게 요청', 'x'.repeat(4000));
    await change(ui, 'Codex Desktop 전달 동의', true);
    assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, false);
    assert.equal(ui.commands.some(c => c.type === 'codexDesktop.handoff'), false);
    assert.match(ui.text(), /26.test/);
    assert.match(ui.text(), /전용 패키지/);
  } finally { ui.cleanup(); }
});

test('Codex Desktop consent is fresh for each document profile selected pane visible pane set and exact prompt', async () => {
  const base = desktopFixture();
  const tabs = [base.tabs[0], { ...base.tabs[0], id: 'second', url: 'https://example.com/second' }];
  const initial = { ...base, tabs, splitCount: 2 as const, paneTabIds: ['tab', 'second'] };
  const ui = await harness(initial);
  try {
    await ui.click('Codex Desktop 연결');
    await change(ui, 'AI에게 요청', 'retained draft');
    const patches: Partial<AppState>[] = [
      { tabs: [{ ...tabs[0], revision: 1 }, tabs[1]] },
      { tabs: [{ ...tabs[0], url: 'https://example.com/new' }, tabs[1]] },
      { activeTabId: 'second' },
      { activeProfileId: 'other' },
      { profiles: [{ ...base.profiles[0], incognito: true }] },
      { paneTabIds: ['second', 'tab'] },
      { splitCount: 1, paneTabIds: ['tab'] },
      { tabs: [tabs[0], { ...tabs[1], revision: 1 }] },
    ];
    for (const patch of patches) {
      await ui.update(initial);
      await change(ui, 'Codex Desktop 전달 동의', true);
      await ui.update({ ...initial, ...patch });
      assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, false, JSON.stringify(patch));
      await ui.update(initial);
      assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, false);
    }
    await change(ui, 'Codex Desktop 전달 동의', true);
    await ui.update({ ...initial, providerActivity: { running: 1, waiting: 0, limit: 1 } });
    assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, true);
    await change(ui, 'AI에게 요청', 'retained draft ');
    assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, false);
    await ui.click('어시스턴트');
    assert.equal(ui.label('AI에게 요청').props.value, 'retained draft ');
    await ui.click('Codex Desktop 연결');
    assert.equal(ui.label('AI에게 요청').props.value, 'retained draft ');
    assert.equal(ui.commands.some(c => c.type === 'codexDesktop.handoff' || c.type === 'job.start'), false);
  } finally { ui.cleanup(); }
});

test('Codex Desktop handoff sends exact strict DTO once while pending and reports only requested composer status', async () => {
  const initial = desktopFixture();
  const ui = await harness(initial);
  const original = window.sidework!.dispatch;
  let finish: (() => void) | undefined;
  window.sidework!.dispatch = command => command.type === 'codexDesktop.handoff' ? new Promise(resolve => {
    ui.commands.push(command);
    finish = () => resolve({ ...initial, codexDesktopHandoff: { requestId: 'request', status: 'requested', requestedAt: '2026-10-24T00:00:00Z', paneIndex: 2 } });
  }) : original(command);
  try {
    await ui.click('Codex Desktop 연결');
    const prompt = '  이 페이지 읽기\n원문 그대로  ';
    await change(ui, 'AI에게 요청', prompt);
    await change(ui, 'Codex Desktop 전달 동의', true);
    const submit = ui.label('Codex Desktop에서 계속').props.onClick as () => void;
    submit(); submit(); await ui.render();
    assert.equal(ui.label('Codex Desktop에서 계속').props.disabled, true);
    assert.deepEqual(ui.commands.filter(c => c.type === 'codexDesktop.handoff'), [{ type: 'codexDesktop.handoff', tabId: 'tab', expectedRevision: initial.tabs[0].revision, expectedUrl: initial.tabs[0].url, prompt, consent: true }]);
    assert.equal(ui.text().includes('새 요청 화면 열기 요청됨'), false);
    await ui.click('Codex Desktop 연결 확인');
    assert.equal(ui.commands.filter(c => c.type === 'codexDesktop.check').length, 1);
    finish?.(); await ui.render();
    assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, false);
    assert.equal(ui.label('AI에게 요청').props.value, prompt);
    const text = ui.text();
    assert.match(text, /새 요청 화면 열기 요청됨 — Codex에서 확인 후 보내세요/);
    assert.match(text,/최근 전달 기록 · 화면 2\./);
    for (const warning of [/다른 분할 화면/, /전송.*승인.*중지.*Codex/, /자동.*결과.*가져오지/, /설치.*실행.*권한/]) assert.match(text, warning);
    assert.doesNotMatch(text, /실행 완료|작업 완료|자동 실행 중/);
    assert.equal(ui.commands.some(c => c.type === 'agent.connect' || c.type === 'provider.check' || c.type === 'job.start'), false);
  } finally { finish?.(); await ui.render(); ui.cleanup(); }
});

test('Codex Desktop drafts survive legacy composer return failed handoff and edits made during pending handoff', async () => {
  const initial = desktopFixture();
  const ui = await harness(initial);
  try {
    await ui.click('Codex Desktop 연결');
    await change(ui, 'AI에게 요청', '보존할 초안');
    await ui.click('요청 작성');
    assert.equal(ui.label('AI에게 요청').props.value, '보존할 초안');
    await ui.click('Codex Desktop 연결');
    const original = window.sidework!.dispatch;
    window.sidework!.dispatch = c => c.type === 'codexDesktop.handoff' ? Promise.reject(new Error('공식 앱 전달 실패')) : original(c);
    await change(ui, 'Codex Desktop 전달 동의', true);
    await ui.click('Codex Desktop에서 계속');
    assert.match(ui.text(), /공식 앱 전달 실패/);
    assert.equal(ui.label('AI에게 요청').props.value, '보존할 초안');
    assert.equal(ui.label('Codex Desktop 전달 동의').props.checked, false);
    assert.equal(ui.text().includes('새 요청 화면 열기 요청됨'), false);
    let finish: (() => void) | undefined;
    window.sidework!.dispatch = c => c.type === 'codexDesktop.handoff' ? new Promise(resolve => { finish = () => resolve(initial); }) : original(c);
    await change(ui, 'Codex Desktop 전달 동의', true);
    await ui.click('Codex Desktop에서 계속');
    await change(ui, 'AI에게 요청', '응답 대기 중 편집');
    finish?.(); await ui.render();
    assert.equal(ui.label('AI에게 요청').props.value, '응답 대기 중 편집');
    await ui.click('사이드바 닫기');
    await ui.click('Codex Desktop 연결');
    assert.equal(ui.label('AI에게 요청').props.value, '응답 대기 중 편집');
  } finally { ui.cleanup(); }
});

test('Codex Desktop binds the displayed selected document URL and revision without rebasing or defaults', async () => {
  const base = desktopFixture();
  const second = { ...base.tabs[0], id: 'selected', title: '정확한 대상', revision: 7, url: 'https://example.com/path?q=one%20two#section' };
  const ui = await harness({ ...base, tabs: [base.tabs[0], second], activeTabId: second.id, splitCount: 2, paneTabIds: ['tab', second.id] });
  try {
    await ui.click('Codex Desktop 연결');
    await change(ui, 'AI에게 요청', ' exact prompt ');
    await change(ui, 'Codex Desktop 전달 동의', true);
    await ui.click('Codex Desktop에서 계속');
    assert.deepEqual(ui.commands.filter(c => c.type === 'codexDesktop.handoff'), [{ type: 'codexDesktop.handoff', tabId: 'selected', expectedRevision: 7, expectedUrl: second.url, prompt: ' exact prompt ', consent: true }]);
    assert.ok(ui.text().includes(second.url));
    assert.match(ui.text(), /정확한 대상/);
  } finally { ui.cleanup(); }
});

test('split selector renders exact native grid and pinned URL controls without starting inference', async () => {
  const base = fixture({ bridgeReady: true });
  const tabs = Array.from({ length: 8 }, (_, i) => ({ ...base.tabs[0], id: `pane-${i}`, url: i === 0 ? 'about:blank' : `https://example.com/${i}` }));
  const ui = await harness({ ...base, tabs, activeTabId: tabs[0].id, splitCount: 8, paneTabIds: tabs.map(tab => tab.id) });
  try {
    const grid = ui.label('분할 웹페이지');
    assert.equal(grid.props['data-testid'], 'pane-grid');
    assert.deepEqual(ui.all().filter(node => typeof node.props['data-pane-id'] === 'string').map(node => node.props['data-pane-id']), tabs.map(tab => tab.id));
    assert.deepEqual(grid.props.style, { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' });
    assert.equal(ui.all().filter(node => node.props.className === 'pane-header').length, 8);
    assert.equal(ui.commands.filter(command => command.type === 'layout.set').at(-1)?.hideBrowser, false);
    (ui.label('화면 분할').props.onChange as (e: unknown) => void)({ target: { value: '4' } }); await ui.render();
    assert.deepEqual(ui.commands.at(-1), { type: 'workspace.split', count: 4 });
    (ui.label('화면 2 주소').props.onChange as (e: unknown) => void)({ target: { value: 'https://example.com/pinned' } }); await ui.render();
    const form = ui.all().find(node => node.props['aria-label'] === '화면 2 탐색')!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await ui.render();
    assert.deepEqual(ui.commands.at(-1), { type: 'tab.navigate', tabId: 'pane-1', url: 'https://example.com/pinned' });
    assert.equal(ui.commands.some(command => command.type === 'job.start' || command.type === 'jobs.startVisible' || command.type === 'agent.connect'), false);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.pane-grid\s*\{[^}]*gap:\s*0;/);
    assert.match(css, /\.pane-header\s*\{[^}]*height:\s*32px;/);
    assert.match(css, /\.composer-area\s*\{[^}]*max-height:\s*58%;[^}]*overflow-y:\s*auto;/);
    assert.doesNotMatch(css, /\.composer-area\.is-busy textarea\s*\{[^}]*display:\s*none/);
  } finally { ui.cleanup(); }
});

test('pane computer start pins target and requires fresh explicit screen consent on every attempt', async () => {
 const base = fixture({ bridgeReady: true }); const tabs = [base.tabs[0], { ...base.tabs[0], id: 'second', url: 'https://example.com' }];
 const ui = await harness({ ...base, tabs, splitCount: 2, paneTabIds: ['tab', 'second'] });
 try {
  await ui.click('화면 2 컴퓨터 작업');
  assert.ok(ui.label('화면별 AI 작업 공간')); assert.match(ui.text(), /연결된 제공자.*전송/);
  await change(ui, '화면 2 AI 요청', 'read canvas');
  assert.equal(ui.label('화면 2 AI 시작').props.disabled, true);
  (ui.label('화면 2 AI 시작').props.onClick as () => void)(); await ui.render();
  assert.equal(ui.commands.some(c => c.type === 'agents.startSections'), false);
  await change(ui, '화면별 AI 공유 동의', true); await ui.click('화면 2 AI 시작');
  assert.deepEqual(ui.commands.filter(c => c.type === 'agents.startSections'), [{ type: 'agents.startSections', tasks: [{ tabId: 'second', expectedRevision: 0, expectedUrl: tabs[1].url, prompt: 'read canvas' }], consent: true }]);
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  assert.equal(ui.commands.some(c => c.type === 'tab.activate' || c.type === 'codexDesktop.handoff' || c.type === 'job.start'), false);
 } finally { ui.cleanup(); }
});

test('different pane jobs start independently while one pane runs and another start is pending', async () => {
 const base = fixture({ bridgeReady: true });
 const tabs = Array.from({ length: 4 }, (_, i) => ({ ...base.tabs[0], id: `p${i}`, url: `https://example.com/${i}` }));
 const running: AppState['jobs'][number] = { id: 'running', tabId: 'p0', profileId: 'default', prompt: 'first', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
 const initial = { ...base, tabs, activeTabId: 'p0', splitCount: 4 as const, paneTabIds: tabs.map(t => t.id), jobs: [running], activeJobIds: ['running'], activeJobId: 'running' };
 const ui = await harness(initial); const original = window.sidework!.dispatch; const finishes: (() => void)[] = [];
 window.sidework!.dispatch = c => c.type === 'agents.startSections' ? new Promise(resolve => { ui.commands.push(c); finishes.push(() => resolve(initial)); }) : original(c);
 try {
  await ui.click('화면 1 작업 중지'); assert.deepEqual(ui.commands.at(-1), { type: 'job.cancel', jobId: 'running' });
  for (const pane of [2, 3]) {
   await ui.click(`화면 ${pane} 컴퓨터 작업`); await change(ui, `화면 ${pane} AI 요청`, `task ${pane}`);
   await change(ui, '화면별 AI 공유 동의', true); await ui.click(`화면 ${pane} AI 시작`);
  }
  assert.deepEqual(ui.commands.filter(c => c.type === 'agents.startSections').map(c => c.tasks[0].tabId), ['p1', 'p2']);
  await change(ui, '화면 3 AI 요청', 'next pane draft'); finishes.shift()?.(); await ui.render();
  assert.equal(ui.label('화면 3 AI 요청').props.value, 'next pane draft');
  await ui.click('화면 1 컴퓨터 작업'); assert.equal(ui.label('화면 1 AI 시작').props.disabled, true);
 } finally { finishes.forEach(f => f()); await ui.render(); ui.cleanup(); }
});

test('visible batch uses explicit common prompt consent and reports provider capacity without inventing concurrency', async () => {
  const base = fixture({ bridgeReady: true });
  const tabs = Array.from({ length: 4 }, (_, i) => ({ ...base.tabs[0], id: `p${i}`, url: i === 0 ? 'about:blank' : `https://example.com/${i}` }));
  const initial = { ...base, tabs, activeTabId: 'p0', splitCount: 4 as const, paneTabIds: tabs.map(t => t.id), providerActivity: { running: 1, waiting: 6, limit: 1, reason: 'memory budget' } };
  const ui = await harness(initial);
  try {
    await ui.click('어시스턴트'); await change(ui, '작업 방식', 'computer');
    assert.match(ui.text(), /모델 실행 1 · 대기 6 · 한도 1/);
    assert.match(ui.text(), /memory budget/);
    assert.match(ui.text(), /일괄 실행.*같은 요청/);
    (ui.label('AI에게 요청').props.onChange as (e: unknown) => void)({ target: { value: 'compare visible pages' } }); await ui.render();
    assert.equal(ui.label('보이는 화면 일괄 실행').props.disabled, true);
    (ui.label('선택 화면 공유 동의').props.onChange as (e: unknown) => void)({ target: { checked: true } }); await ui.render();
    await ui.click('보이는 화면 일괄 실행');
    assert.deepEqual(ui.commands.filter(c => c.type === 'agents.startSections'), [{ type: 'agents.startSections', tasks: tabs.slice(1).map(tab => ({ tabId: tab.id, expectedRevision: tab.revision, expectedUrl: tab.url, prompt: 'compare visible pages' })), consent: true }]);
    assert.equal(ui.commands.some(c => c.type === 'jobs.startVisible'), false);
    assert.equal(ui.label('선택 화면 공유 동의').props.checked, false);
    assert.equal(ui.commands.some(c => c.type === 'job.start'), false);
    await ui.update({ ...initial, jobs: [{ id: 'active', tabId: 'p1', profileId: 'default', prompt: 'first', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 }], activeJobIds: ['active'], activeJobId: null });
    await ui.click('모든 작업 중지');
    assert.deepEqual(ui.commands.at(-1), { type: 'jobs.cancelAll' });
    assert.equal(ui.label('보이는 화면 일괄 실행').props.disabled, true);
  } finally { ui.cleanup(); }
});

test('DOM delegation keeps single-page submit separate from explicit batch consent without first-scroll coordination',async()=>{
 const base=fixture({bridgeReady:true});const tabs=[{...base.tabs[0],url:'https://example.com/a'},{...base.tabs[0],id:'b',url:'https://example.com/b'}];
 const ui=await harness({...base,tabs,splitCount:2,paneTabIds:tabs.map(t=>t.id)});
 try{
  await ui.click('어시스턴트');assert.equal(ui.label('작업 방식').props.value,'dom');
  assert.equal(ui.all().some(n=>n.props['aria-label']==='첫 스크롤 동시 시작'),false);
  (ui.label('AI에게 요청').props.onChange as (e:unknown)=>void)({target:{value:'read each official page'}});await ui.render();
  assert.equal(ui.label('선택 화면 공유 동의').props.checked,false);
  const submit=()=>{(ui.all().find(n=>n.props.className==='composer')!.props.onSubmit as (e:unknown)=>void)({preventDefault(){}});};
  assert.equal(ui.label('보이는 화면 일괄 실행').props.disabled,true);submit();await ui.render();
  assert.equal(ui.commands.some(c=>c.type==='agents.start'||c.type==='agents.startSections'||c.type==='job.start'||c.type==='jobs.startVisible'),false);
  (ui.label('선택 화면 공유 동의').props.onChange as (e:unknown)=>void)({target:{checked:true}});await ui.render();
  assert.equal(ui.all().filter(n=>n.props['aria-label']==='보이는 화면 일괄 실행').length,1);
  await ui.click('보이는 화면 일괄 실행');
  assert.deepEqual(ui.commands.filter(c=>c.type==='agents.startSections'),[{type:'agents.startSections',tasks:tabs.map(tab=>({tabId:tab.id,expectedRevision:tab.revision,expectedUrl:tab.url,prompt:'read each official page'})),consent:true}]);
  assert.equal(ui.commands.some(c=>c.type==='agents.start'||c.type==='jobs.startVisible'),false);
  assert.equal(ui.commands.some(c=>c.type==='job.start'),false);assert.equal(ui.label('선택 화면 공유 동의').props.checked,false);
  (ui.label('작업 방식').props.onChange as (e:unknown)=>void)({target:{value:'computer'}});await ui.render();
  assert.equal(ui.all().some(n=>n.props['aria-label']==='첫 스크롤 동시 시작'),false);
 }finally{ui.cleanup();}
});

test('approval review stays job-pinned across pane focus and independent pending cancellation', async () => {
  const base = fixture({ bridgeReady: true });
  const tabs = [ { ...base.tabs[0], id: 'a', url: 'https://example.com/a' }, { ...base.tabs[0], id: 'b', url: 'https://example.com/b' } ];
  const jobs = tabs.map((tab, i): AppState['jobs'][number] => ({ id: `j${i}`, tabId: tab.id, profileId: 'default', prompt: `request ${i}`, status: 'awaiting_approval', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, steps: 1, approval: { id: `approval-${i}`, action: { type: 'computer_type', value: 'NEVER DISPLAY THIS VALUE', frameId: 'frame' }, digest: 'digest', context: { profileId: 'default', tabId: tab.id }, revision: 0, expiresAt: '2099-01-01T00:00:00Z', summary: `type ${i}` } }));
  const initial = { ...base, tabs, activeTabId: 'a', splitCount: 2 as const, paneTabIds: ['a', 'b'], jobs, activeJobIds: ['j0', 'j1'], activeJobId: 'j0' };
  const ui = await harness(initial);
  const original = window.sidework!.dispatch;
  let finish: (() => void) | undefined;
  try {
    (ui.label('검토할 작업').props.onChange as (e: unknown) => void)({ target: { value: 'j1' } }); await ui.render();
    assert.equal(ui.label('검토할 작업').props.value, 'j1');
    assert.equal(ui.text().includes('NEVER DISPLAY THIS VALUE'), false);
    const approve = () => ui.all().find(node => node.type === 'button' && node.children.some(child => child.props.text === '이번 행동 허용'))!;
    assert.equal(approve().props.disabled, false);
    window.sidework!.dispatch = command => command.type === 'job.cancel' ? new Promise(resolve => { ui.commands.push(command); finish = () => resolve(initial); }) : original(command);
    await ui.click('화면 1 작업 중지');
    assert.equal(approve().props.disabled, false);
    (approve().props.onClick as () => void)(); await ui.render();
    assert.deepEqual(ui.commands.filter(c => c.type === 'job.approve'), [{ type: 'job.approve', jobId: 'j1', approvalId: 'approval-1', allow: true }]);
    assert.equal(ui.commands.some(c => c.type === 'tab.activate'), false);
    await ui.update({ ...initial, activeTabId: 'b' });
    assert.equal(ui.label('검토할 작업').props.value, 'j1');
    await ui.update({ ...initial, tabs: tabs.map(t => t.id === 'b' ? { ...t, revision: 2 } : t) });
    assert.equal(approve().props.disabled, true);
    (approve().props.onClick as () => void)(); await ui.render();
    assert.equal(ui.commands.filter(c => c.type === 'job.approve').length, 1);
  } finally { finish?.(); await ui.render(); ui.cleanup(); }
});

test('computer consent is revoked on target navigation, split changes and failed starts', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 try {
  await ui.click('화면 2 컴퓨터 작업'); await change(ui, '화면 2 AI 요청', 'fail closed');
  const consent = () => change(ui, '화면별 AI 공유 동의', true);
  await consent(); await ui.update({ ...initial, tabs: [initial.tabs[0], { ...initial.tabs[1], url: 'https://example.com/changed', revision: 5 }] });
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  await consent(); await ui.update({ ...initial, splitCount: 1, paneTabIds: ['tab'] });
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  assert.equal(ui.all().some(n => n.props['aria-label'] === '화면 2 AI 시작'), false);
  assert.equal(ui.label('입력한 화면 AI 시작').props.disabled, true);
  await ui.update(initial); await consent(); const original = window.sidework!.dispatch;
  window.sidework!.dispatch = c => c.type === 'agents.startSections' ? Promise.reject(new Error('start failed')) : original(c);
  await ui.click('화면 2 AI 시작');
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false); assert.equal(ui.label('화면 2 AI 요청').props.value, 'fail closed');
  assert.match(ui.text(), /start failed/);
 } finally { ui.cleanup(); }
});

test('in-flight visible batch locks duplicate target starts but not cancellation', async () => {
  const base = fixture({ bridgeReady: true });
  const initial = { ...base, tabs: [{ ...base.tabs[0], url: 'https://example.com' }] };
  const ui = await harness(initial);
  const original = window.sidework!.dispatch;
  let finish: (() => void) | undefined;
  try {
    await ui.click('어시스턴트');
    (ui.label('작업 방식').props.onChange as (e: unknown) => void)({ target: { value: 'computer' } }); await ui.render();
    (ui.label('AI에게 요청').props.onChange as (e: unknown) => void)({ target: { value: 'one batch' } });
    (ui.label('선택 화면 공유 동의').props.onChange as (e: unknown) => void)({ target: { checked: true } }); await ui.render();
    window.sidework!.dispatch = command => command.type === 'agents.startSections' ? new Promise(resolve => { ui.commands.push(command); finish = () => resolve(initial); }) : original(command);
    await ui.click('보이는 화면 일괄 실행');
    (ui.label('선택 화면 공유 동의').props.onChange as (e: unknown) => void)({ target: { checked: true } }); await ui.render();
    assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
    assert.equal(ui.label('보이는 화면 일괄 실행').props.disabled, true);
    (ui.all().find(node => node.props.className === 'composer')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await ui.render();
    assert.equal(ui.commands.filter(c => c.type === 'job.start').length, 0);
    assert.equal(ui.commands.filter(c => c.type === 'agents.start').length, 0);
    assert.equal(ui.commands.filter(c => c.type === 'agents.startSections').length, 1);
  } finally { finish?.(); await ui.render(); ui.cleanup(); }
});

test('single-pane computer mode pins its selected tab rather than following later global focus', async () => {
  const base = fixture({ bridgeReady: true });
  const tabs = [{ ...base.tabs[0], url: 'https://example.com/a' }, { ...base.tabs[0], id: 'other', url: 'https://example.com/b' }];
  const ui = await harness({ ...base, tabs });
  try {
    await ui.click('어시스턴트');
    (ui.label('작업 방식').props.onChange as (e: unknown) => void)({ target: { value: 'computer' } }); await ui.render();
    await ui.update({ ...base, tabs, activeTabId: 'other' });
    assert.equal(ui.label('작업 대상 화면').props.value, '');
    assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
    assert.equal(ui.commands.some(c => c.type === 'job.start'), false);
  } finally { ui.cleanup(); }
});

test('pane task header selects only that pane review and retains completed status', async () => {
 const base = fixture({ bridgeReady: true });
 const tabs = [{ ...base.tabs[0], title: 'First', url: 'https://example.com' }, { ...base.tabs[0], id: 'second', title: 'Pinned second', url: 'https://example.com/second' }];
 const completed: AppState['jobs'][number] = { id: 'done', tabId: 'second', profileId: 'default', prompt: 'completed second', status: 'completed', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: 'Done', error: null, approval: null, steps: 1 };
 const ui = await harness({ ...base, tabs, splitCount: 2, paneTabIds: ['tab', 'second'], jobs: [completed] });
 try {
  assert.match(ui.label('화면 2 상태').props.title as string, /완료/);
  assert.equal(ui.all().some(n => n.props['aria-label'] === '화면 2 작업 중지'), false);
  await ui.click('화면 2 컴퓨터 작업');
  const card = ui.label('화면 2 AI 작업'); const flatten = (node: Node): string => node.type === '#text' ? String(node.props.text) : node.children.map(flatten).join('');
  assert.match(flatten(card), /Pinned second/); assert.match(flatten(card), /completed second/); assert.match(flatten(card), /Done/);
  assert.doesNotMatch(flatten(ui.label('화면 1 AI 작업')), /completed second|Done/);
  await ui.click('화면 1 컴퓨터 작업'); assert.ok(ui.label('화면 1 AI 요청')); assert.match(flatten(ui.label('화면 2 AI 작업')), /Done/);
 } finally { ui.cleanup(); }
});

test('all frozen pane counts preserve browser chrome and native header geometry', async () => {
  const base = fixture();
  const tabs = Array.from({ length: 8 }, (_, i) => ({ ...base.tabs[0], id: `p${i}` }));
  const ui = await harness({ ...base, tabs, activeTabId: 'p0' });
  try {
    for (const count of [1, 2, 4, 8] as const) {
      await ui.update({ ...base, tabs, activeTabId: 'p0', splitCount: count, paneTabIds: tabs.slice(0, count).map(t => t.id) });
      assert.equal(ui.label('화면 분할').props.value, count);
      assert.equal(ui.all().filter(node => node.props.className === 'pane-header').length, count === 1 ? 0 : count);
      assert.equal(ui.commands.filter(c => c.type === 'layout.set').at(-1)?.top, 56);
      if (count > 1) {
        assert.deepEqual(ui.label('분할 웹페이지').props.style, { gridTemplateColumns: `repeat(${Math.min(count, 4)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(count / Math.min(count, 4))}, minmax(0, 1fr))` });
        assert.ok(ui.label(`화면 ${count} 새 주소`));
      }
    }
    assert.equal(ui.commands.some(c => c.type === 'job.start' || c.type === 'jobs.startVisible' || c.type === 'agent.connect'), false);
  } finally { ui.cleanup(); }
});

test('pending starts reserve the eighth logical slot before another pane can submit', async () => {
  const base = fixture({ bridgeReady: true });
  const tabs = Array.from({ length: 9 }, (_, i) => ({ ...base.tabs[0], id: `p${i}`, url: `https://example.com/${i}` }));
  const jobs = tabs.slice(2).map((tab, i): AppState['jobs'][number] => ({ id: `j${i}`, tabId: tab.id, profileId: 'default', prompt: 'active', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 }));
  const initial = { ...base, tabs, activeTabId: 'p0', splitCount: 2 as const, paneTabIds: ['p0', 'p1'], jobs, activeJobIds: jobs.map(j => j.id) };
  const ui = await harness(initial);
  const original = window.sidework!.dispatch;
  let finish: (() => void) | undefined;
  try {
    await ui.click('어시스턴트'); await change(ui, '작업 방식', 'computer'); await change(ui, '작업 대상 화면', 'p0');
    (ui.label('AI에게 요청').props.onChange as (e: unknown) => void)({ target: { value: 'eighth' } });
    (ui.label('선택 화면 공유 동의').props.onChange as (e: unknown) => void)({ target: { checked: true } }); await ui.render();
    window.sidework!.dispatch = command => command.type === 'agents.start' ? new Promise(resolve => { ui.commands.push(command); finish = () => resolve(initial); }) : original(command);
    (ui.all().find(node => node.props.className === 'composer')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await ui.render();
    await change(ui, '작업 대상 화면', 'p1');
    (ui.label('선택 화면 공유 동의').props.onChange as (e: unknown) => void)({ target: { checked: true } }); await ui.render();
    assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
    (ui.all().find(node => node.props.className === 'composer')!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await ui.render();
    assert.equal(ui.commands.filter(c => c.type === 'agents.start').length, 1);
  } finally { finish?.(); await ui.render(); ui.cleanup(); }
});

test('pane URL drafts survive frequent job snapshots and both URL inputs respect IME', async () => {
  const base = fixture();
  const tabs = [base.tabs[0], { ...base.tabs[0], id: 'second', url: 'https://example.com' }];
  const initial = { ...base, tabs, splitCount: 2 as const, paneTabIds: ['tab', 'second'] };
  const ui = await harness(initial);
  try {
    (ui.label('화면 2 주소').props.onChange as (e: unknown) => void)({ target: { value: '작성 중인 주소 초안' } }); await ui.render();
    for (let i = 0; i < 8; i++) await ui.update({ ...initial, tabs: tabs.map(tab => ({ ...tab, revision: i })), providerActivity: { running: i % 2, waiting: 1, limit: 1 } });
    assert.equal(ui.label('화면 2 주소').props.value, '작성 중인 주소 초안');
    for (const name of ['화면 2 주소', '화면 1 새 주소']) {
      let prevented = false;
      const key = ui.label(name).props.onKeyDown as (e: unknown) => void;
      assert.equal(typeof key, 'function');
      key({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    }
    assert.equal(ui.commands.some(c => c.type === 'tab.navigate' || c.type === 'job.start' || c.type === 'jobs.startVisible'), false);
  } finally { ui.cleanup(); }
});

test('recently closed restore is browser-owned, count-gated, and leaves drafts on cancelled close', async () => {
  const ui = await harness(fixture({ closedTabCount: 0 }));
  try {
    assert.equal(ui.label('닫은 탭 다시 열기').props.disabled, true);
    await ui.update(fixture({ closedTabCount: 2 }));
    await ui.click('닫은 탭 다시 열기');
    assert.equal(ui.commands.filter(command => command.type === 'tab.restore').length, 1);
    assert.equal(ui.commands.some(command => command.type === 'agent.connect'), false);
    await ui.click('어시스턴트');
    (ui.label('AI에게 요청').props.onChange as (event: unknown) => void)({ target: { value: '한글 초안' } });
    (ui.label('주소 또는 검색어').props.onChange as (event: unknown) => void)({ target: { value: '주소 초안' } });
    await ui.render();
    await ui.click('새 탭 닫기'); // Parent reports unchanged state for cancellation.
    assert.equal(ui.label('AI에게 요청').props.value, '한글 초안');
    assert.equal(ui.label('주소 또는 검색어').props.value, '주소 초안');
  } finally { ui.cleanup(); }
});

test('disconnected AI preserves editable drafts but blocks Enter, submit, settings, and memory writes', async () => {
  const ui = await harness();
  try {
    await ui.click('어시스턴트');
    const change = ui.label('AI에게 요청').props.onChange as (event: unknown) => void;
    change({ target: { value: '초안 보존' } }); await ui.render();
    assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
    const key = ui.label('AI에게 요청').props.onKeyDown as (event: unknown) => void;
    key({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} });
    await ui.render();
    assert.equal(ui.commands.some(command => command.type === 'job.start'), false);
    await ui.click('설정');
    assert.equal(ui.all().find(node => node.props.id === 'model')?.props.disabled, true);
    assert.equal(ui.label('개인 메모리 사용').props.disabled, true);
    const forms = ui.all().filter(node => node.type === 'form' && node.props.onSubmit);
    for (const form of forms.filter(node => node.props.className !== 'address-form')) await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
    assert.equal(ui.commands.some(command => command.type === 'settings.update' || command.type === 'memory.add'), false);
    await ui.update(fixture({ agentConnecting: true }));
    assert.match(ui.text(), /AI 연결 중/);
    await ui.update(fixture({ error: 'worker failed' }));
    assert.match(ui.text(), /AI 연결 안 됨/);
    const connectCount = ui.commands.filter(command => command.type === 'agent.connect').length;
    await ui.render(); await ui.render();
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, connectCount);
    await ui.click('어시스턴트');
    assert.equal(ui.label('AI에게 요청').props.value, '초안 보존');
    const connected = desktopFixture();
    await ui.update({ ...connected, bridgeReady: true });
    (ui.label('선택 화면 공유 동의').props.onChange as (event: unknown) => void)({ target: { checked: true } }); await ui.render();
    assert.equal(ui.label('에이전트에게 맡기기').props.disabled, false);
    const ime = ui.label('AI에게 요청').props.onKeyDown as (event: unknown) => void;
    ime({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true, keyCode: 229 }, preventDefault() {} });
    assert.equal(ui.commands.some(command => command.type === 'job.start'), false);
    ime({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() {} });
    await ui.render();
    assert.equal(ui.commands.filter(command => command.type === 'agents.start').length, 1);
  } finally { ui.cleanup(); }
});

test('resource diagnostics refresh only on click and label real samples and measurement limits', async () => {
  const ui = await harness();
  try {
    await ui.click('설정');
    assert.match(ui.text(), /아직 측정하지 않았습니다/);
    assert.equal(ui.commands.some(command => command.type === 'diagnostics.refresh'), false);
    await ui.click('리소스 새로고침');
    assert.equal(ui.commands.filter(command => command.type === 'diagnostics.refresh').length, 1);
    await ui.update(fixture({ diagnostics: { sampledAt: '2026-10-23T01:00:00Z', processes: [{ pid: 42, role: 'Browser', workingSetKB: 2048, peakWorkingSetKB: 4096, cpuPercent: 2.5 }], tabs: 3, liveTabs: 1, dormantTabs: 2, processUptimeAtBrowserReadyMs: 120, processUptimeAtAgentReadyMs: null, caveat: 'source caveat' } }));
    const content = ui.text();
    for (const expected of ['2.0 MiB', '라이브 1', '대기 2', '프로세스 가동 시간', '120 ms', '미측정', '고유 물리 RAM이 아닙니다', '외부 모델 CLI', '콜드 스타트', 'source caveat', '42', '2.5%', 'Sidework test']) assert.ok(content.includes(expected), `missing ${expected}`);
    await ui.render();
    assert.equal(ui.commands.filter(command => command.type === 'diagnostics.refresh').length, 1);
    assert.equal(ui.commands.some(command => command.type === 'job.start' || command.type === 'provider.check'), false);
  } finally { ui.cleanup(); }
});

test('slow AI initialization never blocks browser-owned profile controls', async () => {
  const ui = await harness();
  const bridge = window.sidework!;
  const original = bridge.dispatch;
  let finish: (() => void) | undefined;
  bridge.dispatch = command => command.type === 'agent.connect' ? new Promise(resolve => { ui.commands.push(command); finish = () => resolve(fixture()); }) : original(command);
  try {
    await ui.click('어시스턴트');
    await ui.update(fixture({ agentConnecting: true }));
    await ui.click('프로필 관리');
    const profile = ui.all().find(node => node.props['data-testid'] === 'profile-default');
    assert.equal(profile?.props.disabled, false);
    assert.equal(ui.label('새 탭').props.disabled, false);
    await ui.click('새 탭');
  } finally { finish?.(); await ui.render(); ui.cleanup(); }
});

test('browser startup gates keyboard new-tab and all native tab controls without starting AI', async () => {
  const ui = await harness(fixture({ browserReady: false, bridgeReady: true }));
  try {
    assert.equal(ui.label('새 탭 닫기').props.disabled, true);
    assert.equal(ui.all().find(node => node.props.role === 'tab')?.props.disabled, true);
    ui.events.get('keydown')?.({ key: 't', metaKey: true, preventDefault() {} });
    await ui.render();
    assert.equal(ui.commands.some(command => command.type === 'tab.new'), false);
  } finally { ui.cleanup(); }
});

test('keyboard and request composer openings connect lazily; hiding preserves drafts and new approvals reopen', async () => {
  const ui = await harness(fixture({ bridgeReady: true }));
  try {
    ui.events.get('keydown')?.({ key: 'j', metaKey: true, preventDefault() {} }); await ui.render();
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, 1);
    (ui.label('AI에게 요청').props.onChange as (event: unknown) => void)({ target: { value: 'keep me' } }); await ui.render();
    await ui.click('사이드바 닫기');
    await ui.click('프로필 관리');
    await ui.click('요청 작성');
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, 2);
    (ui.label('AI에게 요청').props.onChange as (event: unknown) => void)({ target: { value: 'approval draft' } }); await ui.render();
    await ui.click('사이드바 닫기');
    await ui.update(fixture({ bridgeReady: true, activeJobId: 'job', jobs: [{ id: 'job', prompt: 'Review', profileId: 'default', tabId: 'tab', status: 'awaiting_approval', createdAt: '2026-10-23T01:00:00Z', updatedAt: '2026-10-23T01:00:00Z', events: [], artifacts: [], answer: null, error: null, steps: 1, approval: { id: 'approval', action: { type: 'navigate', url: 'https://example.com' }, digest: 'digest', context: { profileId: 'default', tabId: 'tab' }, revision: 0, expiresAt: '2099-01-01T00:00:00Z', summary: 'navigate' } }] }));
    assert.equal(ui.all().find(node => node.type === 'aside')?.props.hidden, false);
    assert.ok(ui.label('행동 승인 요청'));
    assert.equal(ui.label('AI에게 요청').props.value, 'approval draft');
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, 2);
  } finally { ui.cleanup(); }
});

test('real browser controls remain usable without AI; opening only AI panels requests connection', async () => {
  const ui = await harness();
  try {
    assert.equal(ui.label('새 탭').props.disabled, false);
    assert.equal(ui.label('주소 또는 검색어').props.disabled, false);
    await ui.click('새 탭');
    await ui.click('프로필 관리');
    assert.equal(ui.commands.some(command => command.type === 'agent.connect'), false);
    await ui.click('어시스턴트');
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, 1);
    await ui.click('사이드바 닫기');
    await ui.click('작업 기록');
    await ui.click('설정');
    assert.equal(ui.commands.filter(command => command.type === 'agent.connect').length, 3);
    assert.equal(ui.commands.some(command => command.type === 'job.start' || command.type === 'diagnostics.refresh'), false);
  } finally { ui.cleanup(); }
});


test('resolved AppState.error is a failed delegation and preserves the exact draft', async () => {
  const initial = { ...desktopFixture(), bridgeReady: true };
  const ui = await harness(initial);
  try {
    await ui.click('어시스턴트');
    await change(ui, 'AI에게 요청', '보존할 요청');
    const original = window.sidework!.dispatch;
    window.sidework!.dispatch = command => command.type === 'agents.start' ? Promise.resolve({ ...initial, error: 'resolved rejection' }) : original(command);
    await change(ui, '선택 화면 공유 동의', true);
    (ui.all().find(node => node.props.className === 'composer')!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await ui.render();
    assert.equal(ui.label('AI에게 요청').props.value, '보존할 요청');
    assert.match(ui.text(), /resolved rejection/);
  } finally { ui.cleanup(); }
});


test('downloads optional empty panel preserves browser bounds and never connects AI', async () => {
 const ui = await harness(desktopFixture());
 try {
  assert.equal(ui.label('다운로드').props['aria-expanded'], false);
  await ui.click('다운로드');
  assert.equal(ui.label('다운로드').props['aria-expanded'], true);
  assert.equal(ui.all().find(n => n.type === 'aside')?.props.hidden, false);
  assert.match(ui.text(), /이번 세션 다운로드/);
  assert.match(ui.text(), /이번 세션에 다운로드한 파일이 없습니다/);
  const bounds = ui.commands.filter(c => c.type === 'layout.set').at(-1);
  assert.equal(bounds?.top, 56); assert.equal(bounds?.sidebarWidth, 380); assert.equal(bounds?.hideBrowser, false);
  await ui.click('다운로드');
  assert.equal(ui.all().find(n => n.type === 'aside')?.props.hidden, true);
  assert.equal(ui.commands.filter(c => c.type === 'layout.set').at(-1)?.sidebarWidth, 0);
  assert.equal(ui.commands.some(c => c.type !== 'layout.set'), false);
 } finally { ui.cleanup(); }
});

function downloadFixture(patch: Partial<NonNullable<AppState['downloads']>[number]> = {}): NonNullable<AppState['downloads']>[number] {
 return { id: 'download', profileId: 'default', tabId: 'tab', filename: 'report.pdf', sourceOrigin: 'https://example.com', state: 'progressing', receivedBytes: 512, totalBytes: null, startedAt: '', error: null, ...patch };
}

test('downloads active row shows actual bytes unknown total and strict browser-owned cancellation', async () => {
 const ui = await harness(desktopFixture());
 try {
  await ui.update({ ...desktopFixture(), downloads: [downloadFixture()] }); await ui.click('다운로드');
  const row = ui.label('report.pdf'); assert.match(nodeText(row), /진행 중/); assert.match(nodeText(row), /512 B/); assert.match(nodeText(row), /전체 크기 알 수 없음/); assert.doesNotMatch(nodeText(row), /%/);
  assert.equal(ui.all().some(n => n.props['aria-label'] === '폴더에서 보기'), false);
  await ui.click('다운로드 취소');
  assert.deepEqual(ui.commands.filter(c => c.type !== 'layout.set'), [{ type: 'downloads.cancel', downloadId: 'download' }]);
 } finally { ui.cleanup(); }
});

test('downloads terminal rows report native outcomes and reveal only completed files',async()=>{
 const ui=await harness({...desktopFixture(),downloads:[downloadFixture({state:'completed'})]});
 try{
  await ui.click('다운로드');assert.match(nodeText(ui.label('report.pdf')),/완료/);assert.equal(ui.all().some(node=>node.props['aria-label']==='다운로드 취소'),false);
  await ui.click('폴더에서 보기');assert.deepEqual(ui.commands.filter(c=>c.type==='downloads.reveal'),[{type:'downloads.reveal',downloadId:'download'}]);
  for(const [state,label] of [['cancelled','취소됨'],['interrupted','중단됨'],['blocked','차단됨']] as const){
   await ui.update({...desktopFixture(),downloads:[downloadFixture({state,error:'이 다운로드를 처리하지 못했습니다.'})]});assert.match(nodeText(ui.label('report.pdf')),new RegExp(label));assert.match(nodeText(ui.label('report.pdf')),/이 다운로드를 처리하지 못했습니다/);
   assert.equal(ui.all().some(node=>['다운로드 취소','폴더에서 보기'].includes(String(node.props['aria-label']))),false);
  }
 }finally{ui.cleanup();}
});

test('downloads only render rows belonging to the current profile',async()=>{
 const downloads=[downloadFixture(),downloadFixture({id:'other-download',profileId:'other',filename:'private-other.pdf'})];const ui=await harness({...desktopFixture(),downloads});
 try{await ui.click('다운로드');assert.equal(ui.all().some(node=>node.props['aria-label']==='private-other.pdf'),false);assert(ui.label('report.pdf'));
  await ui.update({...desktopFixture(),activeProfileId:'other',downloads});assert.equal(ui.all().some(node=>node.props['aria-label']==='report.pdf'),false);assert(ui.label('private-other.pdf'));
  await ui.update({...desktopFixture(),activeProfileId:'empty-profile',downloads});assert.match(ui.text(),/이번 세션에 다운로드한 파일이 없습니다/);
 }finally{ui.cleanup();}
});

test('downloads pending actions stay row-local and cannot double-dispatch',async()=>{
 const initial={...desktopFixture(),downloads:[downloadFixture(),downloadFixture({id:'second-download',filename:'second.pdf'})]};const ui=await harness(initial);
 const pending=new Map<string,(state:AppState)=>void>();
 try{
  await ui.click('다운로드');window.sidework!.dispatch=command=>{ui.commands.push(command);return command.type==='downloads.cancel'?new Promise<AppState>(resolve=>pending.set(command.downloadId,resolve)):Promise.resolve(initial);};
  const action=(filename:string):Node=>{const nodes=(node:Node):Node[]=>[node,...node.children.flatMap(nodes)];return nodes(ui.label(filename)).find(node=>node.props['aria-label']==='다운로드 취소')!;};
  (action('report.pdf').props.onClick as()=>void)();await ui.render();assert.equal(action('report.pdf').props.disabled,true);assert.notEqual(action('second.pdf').props.disabled,true);
  (action('report.pdf').props.onClick as()=>void)();(action('second.pdf').props.onClick as()=>void)();await ui.render();assert.equal(action('second.pdf').props.disabled,true);
  assert.deepEqual(ui.commands.filter(c=>c.type==='downloads.cancel'),[{type:'downloads.cancel',downloadId:'download'},{type:'downloads.cancel',downloadId:'second-download'}]);
  for(const finish of pending.values())finish(initial);await ui.render();assert.equal(action('report.pdf').props.disabled,false);assert.equal(action('second.pdf').props.disabled,false);
 }finally{for(const finish of pending.values())finish(initial);ui.cleanup();}
});

test('downloads resolved bridge errors remain visible without clearing the assistant draft',async()=>{
 const initial={...desktopFixture(),downloads:[downloadFixture({state:'completed'})]};const ui=await harness(initial);
 try{
  await change(ui,'AI에게 요청','keep this exact draft');await ui.click('다운로드');window.sidework!.dispatch=async command=>{ui.commands.push(command);return {...initial,error:'저장한 파일을 확인하지 못했습니다.'};};
  await ui.click('폴더에서 보기');assert.match(ui.text(),/저장한 파일을 확인하지 못했습니다/);assert.equal(ui.commands.some(command=>command.type==='agent.connect'),false);await ui.click('어시스턴트');assert.equal(ui.label('AI에게 요청').props.value,'keep this exact draft');
 }finally{ui.cleanup();}
});

test('downloads long filenames have bounded wrapping and a compact nonbulleted list',()=>{
 const css=readFileSync(new URL('../src/renderer/styles.css',import.meta.url),'utf8');assert.match(css,/\.download-info\s*\{[^}]*min-width:\s*0/);assert.match(css,/\.download-info\s*\{[^}]*overflow-wrap:\s*anywhere/);assert.match(css,/\.download-list\s*\{[^}]*list-style:\s*none/);
});

test('downloads known sizes use exact received and total bytes without fabricated percentages', async () => {
 const ui = await harness({ ...desktopFixture(), downloads: [downloadFixture({ totalBytes: 2048 })] });
 try { await ui.click('다운로드'); assert.match(nodeText(ui.label('report.pdf')), /512 B \/ 2048 B/); assert.doesNotMatch(nodeText(ui.label('report.pdf')), /알 수 없음|%/);
 await ui.update({ ...desktopFixture(), downloads: [downloadFixture({ totalBytes: 0 })] }); assert.match(nodeText(ui.label('report.pdf')), /전체 크기 알 수 없음/);
 } finally { ui.cleanup(); }
});

function sectionFixture(): AppState {
  const base = fixture({ bridgeReady: true, providerActivity: { running: 1, waiting: 3, limit: 2 } });
  return { ...base, splitCount: 2, paneTabIds: ['tab', 'second'], tabs: [{ ...base.tabs[0], url: 'https://example.com/a' }, { ...base.tabs[0], id: 'second', title: 'Second', url: 'https://example.com/b', revision: 4 }] };
}

test('section workspace opens internally and retains distinct profile-tab drafts beside browser', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 try {
  await ui.click('화면별 AI');
  assert.equal(ui.all().find(n => n.type === 'aside')?.props.hidden, false);
  assert.equal(ui.commands.filter(c => c.type === 'agent.connect').length, 1);
  await change(ui, '화면 1 AI 요청', 'first exact draft ');
  await change(ui, '화면 2 AI 요청', 'second draft');
  await ui.click('사이드바 닫기'); await ui.click('화면 2 컴퓨터 작업');
  assert.equal(ui.label('화면 1 AI 요청').props.value, 'first exact draft ');
  assert.equal(ui.label('화면 2 AI 요청').props.value, 'second draft');
  await ui.update({ ...initial, activeProfileId: 'other', profiles: [...initial.profiles, { id: 'other', name: 'Other', incognito: false }], tabs: initial.tabs.map(t => ({ ...t, profileId: 'other' })) });
  assert.equal(ui.label('화면 1 AI 요청').props.value, '');
  await change(ui, '화면 1 AI 요청', 'other profile');
  await ui.update(initial);
  assert.equal(ui.label('화면 1 AI 요청').props.value, 'first exact draft ');
  assert.equal(ui.label('화면 2 AI 요청').props.value, 'second draft');
  assert.match(ui.text(), /모델 실행 1 · 대기 3 · 한도 2/);
  assert.match(ui.text(), /데스크톱.*공유하지/);
  const bounds = ui.commands.filter(c => c.type === 'layout.set').at(-1);
  assert.equal(bounds?.sidebarWidth, 380); assert.equal(bounds?.hideBrowser, false);
  assert.equal(ui.commands.some(c => c.type === 'codexDesktop.handoff' || c.type === 'job.start'), false);
 } finally { ui.cleanup(); }
});


test('section consent binds exact drafts documents panes privacy and sends one strict batch retaining drafts on failure', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 try {
  await ui.click('화면별 AI');
  await change(ui, '화면 1 AI 요청', '  first\n exact ');
  await change(ui, '화면 2 AI 요청', 'second');
  assert.equal(ui.label('입력한 화면 AI 시작').props.disabled, true);
  const consent = () => change(ui, '화면별 AI 공유 동의', true);
  await consent();
  await ui.update({ ...initial, providerActivity: { running: 2, waiting: 0, limit: 2 } });
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, true);
  await change(ui, '화면 1 AI 요청', '  first\n exact  ');
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  for (const patch of [
    { tabs: [{ ...initial.tabs[0], revision: 1 }, initial.tabs[1]] },
    { tabs: [{ ...initial.tabs[0], url: 'https://example.com/new' }, initial.tabs[1]] },
    { paneTabIds: ['second', 'tab'] }, { splitCount: 1 as const, paneTabIds: ['tab'] },
    { profiles: [{ ...initial.profiles[0], incognito: true }] }, { activeProfileId: 'other' },
  ]) {
   await ui.update(initial); await consent(); await ui.update({ ...initial, ...patch });
   assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false, JSON.stringify(patch));
   await ui.update(initial); assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  }
  await consent(); await ui.click('입력한 화면 AI 시작');
  assert.deepEqual(ui.commands.filter(c => c.type === 'agents.startSections'), [{ type: 'agents.startSections', tasks: initial.tabs.map((t, i) => ({ tabId: t.id, expectedRevision: t.revision, expectedUrl: t.url, prompt: i === 0 ? '  first\n exact  ' : 'second' })), consent: true }]);
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  assert.equal(ui.label('화면 1 AI 요청').props.value, '  first\n exact  ');
  const original = window.sidework!.dispatch;
  window.sidework!.dispatch = c => c.type === 'agents.startSections' ? Promise.resolve({ ...initial, error: 'sections rejected' }) : original(c);
  await consent(); await ui.click('화면 2 AI 시작');
  assert.match(ui.text(), /sections rejected/);
  assert.equal(ui.label('화면 2 AI 요청').props.value, 'second');
  assert.equal(ui.label('화면별 AI 공유 동의').props.checked, false);
  assert.equal(ui.commands.some(c => c.type === 'codexDesktop.handoff' || c.type === 'job.start' || c.type === 'jobs.startVisible'), false);
 } finally { ui.cleanup(); }
});


test('section starts reject invalid public documents provider profile prompts and eight-slot capacity', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 try {
  await ui.click('화면별 AI'); await change(ui, '화면 1 AI 요청', 'valid');
  const invalid: Partial<AppState>[] = [
   { browserReady: false }, { bridgeReady: false },
   { providerStatus: { ...initial.providerStatus, authenticated: false } },
   { providerStatus: { ...initial.providerStatus, installed: false } },
   { profiles: [] }, { profiles: [{ ...initial.profiles[0], incognito: true }] },
   ...['', 'about:blank', 'file:///secret', 'data:text/plain,private', 'https://user:pass@example.com', 'http://localhost', 'http://127.0.0.1', 'http://192.168.1.1', 'http://10.0.0.1', 'http://[::1]', 'https://intranet.local', 'not a URL'].map(url => ({ tabs: [{ ...initial.tabs[0], url }, initial.tabs[1]] })),
   { tabs: [{ ...initial.tabs[0], isLoading: true }, initial.tabs[1]] },
   { tabs: [{ ...initial.tabs[0], lifecycle: 'dormant' as const }, initial.tabs[1]] },
   { tabs: [{ ...initial.tabs[0], revision: -1 }, initial.tabs[1]] },
   { paneTabIds: ['tab', 'tab'] },
  ];
  for (const patch of invalid) {
   await ui.update({ ...initial, ...patch }); await change(ui, '화면별 AI 공유 동의', true);
   assert.equal(ui.label('입력한 화면 AI 시작').props.disabled, true, JSON.stringify(patch));
   (ui.label('입력한 화면 AI 시작').props.onClick as () => void)(); await ui.render();
  }
  await ui.update(initial);
  for (const value of ['   ', 'x'.repeat(8001)]) {
   await change(ui, '화면 1 AI 요청', value); await change(ui, '화면별 AI 공유 동의', true);
   assert.equal(ui.label('화면 1 AI 시작').props.disabled, true);
  }
  await change(ui, '화면 1 AI 요청', 'x'.repeat(8000)); await change(ui, '화면별 AI 공유 동의', true);
  assert.equal(ui.label('화면 1 AI 시작').props.disabled, false);
  const jobs = Array.from({ length: 8 }, (_, i): AppState['jobs'][number] => ({ id: `capacity-${i}`, tabId: `hidden-${i}`, profileId: 'other', prompt: 'busy', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 }));
  await ui.update({ ...initial, jobs, activeJobIds: jobs.map(j => j.id) }); await change(ui, '화면별 AI 공유 동의', true);
  assert.equal(ui.label('입력한 화면 AI 시작').props.disabled, true);
  assert.equal(ui.commands.some(c => c.type === 'agents.startSections'), false);
 } finally { ui.cleanup(); }
});


test('section pending starts block duplicates reserve slots but allow a different pane while pending', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 const original = window.sidework!.dispatch; const finishes: (() => void)[] = [];
 window.sidework!.dispatch = c => c.type === 'agents.startSections' ? new Promise(resolve => { ui.commands.push(c); finishes.push(() => resolve(initial)); }) : original(c);
 try {
  await ui.click('화면별 AI'); await change(ui, '화면 1 AI 요청', 'one'); await change(ui, '화면 2 AI 요청', 'two');
  await change(ui, '화면별 AI 공유 동의', true);
  const stale = ui.label('화면 1 AI 시작').props.onClick as () => void; stale(); stale(); await ui.render();
  await change(ui, '화면별 AI 공유 동의', true);
  assert.equal(ui.label('화면 1 AI 시작').props.disabled, true);
  assert.equal(ui.label('화면 2 AI 시작').props.disabled, false);
  await ui.click('화면 2 AI 시작');
  assert.deepEqual(ui.commands.filter(c => c.type === 'agents.startSections').map(c => c.tasks.map(t => t.tabId)), [['tab'], ['second']]);
  finishes.splice(0).forEach(f => f()); await ui.render();
  const jobs = Array.from({ length: 7 }, (_, i): AppState['jobs'][number] => ({ id: `j${i}`, tabId: `hidden${i}`, profileId: 'default', prompt: 'running', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 }));
  const capacity = { ...initial, jobs, activeJobIds: jobs.map(j => j.id) };
  await ui.update(capacity); await change(ui, '화면별 AI 공유 동의', true);
  assert.equal(ui.label('입력한 화면 AI 시작').props.disabled, true);
  await ui.click('화면 1 AI 시작');
  await change(ui, '화면별 AI 공유 동의', true);
  assert.equal(ui.label('화면 2 AI 시작').props.disabled, true);
  (ui.label('화면 2 AI 시작').props.onClick as () => void)(); await ui.render();
  assert.equal(ui.commands.filter(c => c.type === 'agents.startSections').length, 3);
  await change(ui, '화면 1 AI 요청', 'edited while pending');
  finishes.splice(0).forEach(f => f()); await ui.render();
  assert.equal(ui.label('화면 1 AI 요청').props.value, 'edited while pending');
 } finally { finishes.forEach(f => f()); await ui.render(); ui.cleanup(); }
});


test('section job cards keep independent approval stop progress and results without blanket approval', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 const jobs = initial.tabs.map((tab, i): AppState['jobs'][number] => ({ id: `section-${i}`, tabId: tab.id, profileId: tab.profileId, prompt: `request ${i}`, status: 'awaiting_approval', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', events: [{ id: `event${i}`, at: '', kind: 'thought', text: `progress ${i}` }], artifacts: [], answer: null, error: null, steps: i + 1, computerUse: true, approval: { id: `approve${i}`, action: { type: 'computer_type', value: 'SECRET INPUT', frameId: 'frame' }, digest: 'digest', context: { profileId: tab.profileId, tabId: tab.id }, revision: tab.revision, expiresAt: '2099-01-01T00:00:00Z', summary: 'input' } }));
 const next = { ...initial, jobs, activeJobIds: jobs.map(j => j.id) };
 const original = window.sidework!.dispatch; let finish: (() => void) | undefined;
 try {
  await ui.click('화면별 AI'); await ui.update(next);
  assert.ok(ui.label('화면 1 AI 요청')); // New approvals must not steal the workspace.
  assert.match(ui.text(), /progress 0/); assert.match(ui.text(), /progress 1/);
  assert.equal(ui.text().includes('SECRET INPUT'), false);
  assert.equal(ui.commands.some(c => c.type === 'job.approve'), false);
  window.sidework!.dispatch = c => c.type === 'job.cancel' ? new Promise(resolve => { ui.commands.push(c); finish = () => resolve(next); }) : original(c);
  await ui.click('화면 1 AI 중지');
  const approvals = () => ui.all().filter(n => n.type === 'button' && n.children.some(child => child.props.text === '이번 행동 허용'));
  assert.equal(approvals().length, 2); assert.equal(approvals()[1].props.disabled, false);
  (approvals()[1].props.onClick as () => void)(); await ui.render();
  assert.deepEqual(ui.commands.filter(c => c.type === 'job.approve'), [{ type: 'job.approve', jobId: 'section-1', approvalId: 'approve1', allow: true }]);
  assert.equal(ui.label('모든 화면 AI 중지').props.disabled, false);
  await ui.click('모든 화면 AI 중지'); assert.deepEqual(ui.commands.at(-1), { type: 'jobs.cancelAll' });
  finish?.(); await ui.render();
  await ui.update({ ...next, tabs: [initial.tabs[0], { ...initial.tabs[1], revision: 5 }] });
  assert.equal(approvals()[1].props.disabled, true);
  await ui.update({ ...initial, jobs: [{ ...jobs[0], id: 'older', status: 'completed', answer: 'old answer', approval: null }, { ...jobs[0], id: 'newest', updatedAt: '2026-10-24T00:00:01Z', status: 'completed', answer: 'new answer', approval: null }] });
  assert.match(ui.text(), /new answer/); assert.equal(ui.text().includes('old answer'), false);
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.section-ai-card\s*\{/); assert.match(css, /\.section-ai-url\s*\{[^}]*overflow-wrap:\s*anywhere/);
 } finally { finish?.(); await ui.render(); ui.cleanup(); }
});


test('section URL consent refuses credential query and fragment URLs before transmission', async () => {
 const initial = sectionFixture(); const ui = await harness(initial);
 try {
  await ui.click('화면별 AI'); await change(ui, '화면 1 AI 요청', 'read');
  for (const url of ['https://example.com/?access_token=secret', 'https://example.com/?code=secret', 'https://example.com/?state=secret', 'https://example.com/#session=secret', 'https://example.com/#api_key%20=secret', 'https://example.com/#%invalid', 'https://example.com/' + 'x'.repeat(4096)]) {
   await ui.update({ ...initial, tabs: [{ ...initial.tabs[0], url }, initial.tabs[1]] }); await change(ui, '화면별 AI 공유 동의', true);
   assert.equal(ui.label('화면 1 AI 시작').props.disabled, true, url);
   (ui.label('화면 1 AI 시작').props.onClick as () => void)(); await ui.render();
  }
  assert.equal(ui.commands.some(c => c.type === 'agents.startSections'), false);
 } finally { ui.cleanup(); }
});


test('section pending targets cannot be duplicated through the preserved legacy assistant', async () => {
 const initial = sectionFixture(); const ui = await harness(initial); const original = window.sidework!.dispatch;
 let finish: (() => void) | undefined;
 window.sidework!.dispatch = c => c.type === 'agents.startSections' ? new Promise(resolve => { ui.commands.push(c); finish = () => resolve(initial); }) : original(c);
 try {
  await ui.click('화면별 AI'); await change(ui, '화면 1 AI 요청', 'section pending'); await change(ui, '화면별 AI 공유 동의', true); await ui.click('화면 1 AI 시작');
  await ui.click('어시스턴트'); await change(ui, 'AI에게 요청', 'legacy draft');
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
  (ui.all().find(n => n.props.className === 'composer')!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); await ui.render();
  await change(ui, '선택 화면 공유 동의', true);
  assert.equal(ui.label('보이는 화면 일괄 실행').props.disabled, true);
  (ui.label('보이는 화면 일괄 실행').props.onClick as () => void)(); await ui.render();
  assert.equal(ui.commands.some(c => c.type === 'job.start' || c.type === 'jobs.startVisible'), false);
  assert.equal(ui.commands.filter(c => c.type === 'agents.startSections').length, 1);
  assert.equal(ui.commands.some(c => c.type === 'agents.start'), false);
  await change(ui, '작업 대상 화면', 'second');
  assert.equal(ui.label('선택 화면 공유 동의').props.checked, false);
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled, true);
  await change(ui, '선택 화면 공유 동의', true);
  assert.equal(ui.label('에이전트에게 맡기기').props.disabled, false);
  assert.equal(ui.label('AI에게 요청').props.value, 'legacy draft');
  await ui.click('화면별 AI'); assert.equal(ui.label('화면 1 AI 요청').props.value, 'section pending');
 } finally { finish?.(); await ui.render(); ui.cleanup(); }
});
