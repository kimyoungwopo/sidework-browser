import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLayout, shouldSubmitComposer } from '../src/renderer/behavior.ts';
import * as behavior from '../src/renderer/behavior.ts';
import { DEFAULT_SETTINGS, type AppState } from '../src/contract.ts';

function fixture(patch: Partial<AppState> = {}): AppState {
  return { profiles: [{ id: 'default', name: '기본', incognito: false }], activeProfileId: 'default', tabs: [{ id: 'tab', profileId: 'default', title: '새 탭', url: 'about:blank', isLoading: false, canGoBack: false, canGoForward: false, ownership: 'user', revision: 0 }], activeTabId: 'tab', jobs: [], activeJobId: null, settings: DEFAULT_SETTINGS, memory: [], providerStatus: { installed: true, authenticated: true, liveVerified: false, detail: '' }, browserReady: true, bridgeReady: false, agentConnecting: false, error: null, appVersion: 'test', ...patch };
}

test('browser readiness is independent from AI, while submit and AI settings require the worker', () => {
  assert.equal(typeof behavior.readiness, 'function');
  assert.deepEqual(behavior.readiness(fixture()), { browser: true, agent: false, submit: false });
  assert.deepEqual(behavior.readiness(fixture({ bridgeReady: true })), { browser: true, agent: true, submit: true });
  assert.equal(behavior.readiness(fixture({ bridgeReady: true, providerStatus: { installed: false, authenticated: false, liveVerified: true, detail: '' } })).submit, false);
  assert.deepEqual(behavior.readiness(null), { browser: false, agent: false, submit: false });
});

test('only explicit AI panel opening requests connection; status separates runtime and historical verification', () => {
  assert.equal(typeof behavior.panelConnectionCommand, 'function');
  for (const panel of ['assistant', 'history', 'settings'] as const) assert.deepEqual(behavior.panelConnectionCommand(panel), { type: 'agent.connect' });
  assert.equal(behavior.panelConnectionCommand('profiles'), null);
  assert.equal(behavior.agentStatus(fixture({ agentConnecting: true })), 'AI 연결 중');
  assert.equal(behavior.agentStatus(fixture({ providerStatus: { installed: true, authenticated: true, liveVerified: true, detail: '' } })), 'AI 연결 안 됨');
  assert.equal(behavior.agentStatus(fixture({ bridgeReady: true })), 'Codex · 로그인됨');
});

test('resource summaries preserve shared-memory and process-uptime limits without invented samples', () => {
  assert.equal(typeof behavior.resourceSummary, 'function');
  assert.equal(behavior.resourceSummary(undefined), null);
  const summary = behavior.resourceSummary({ sampledAt: '2026-10-23T01:00:00Z', processes: [{ pid: 42, role: 'Browser', workingSetKB: 2048, peakWorkingSetKB: 4096, cpuPercent: 2.5 }, { pid: 43, role: 'Tab', workingSetKB: 1024, peakWorkingSetKB: 2048, cpuPercent: 0 }], tabs: 3, liveTabs: 1, dormantTabs: 2, processUptimeAtBrowserReadyMs: 120, processUptimeAtAgentReadyMs: null, caveat: 'source caveat' });
  assert.ok(summary);
  assert.equal(summary.processCount, 2);
  assert.equal(summary.workingSetMiB, '3.0');
  assert.equal(summary.browserCheckpoint, '120 ms');
  assert.equal(summary.agentCheckpoint, '미측정');
});

test('Aside-led layout reserves the unified left navigation and keeps optional right panels bounded', () => {
  assert.deepEqual(browserLayout(1440, 'https://example.com'), { type: 'layout.set', left: 228, top: 56, bottom: 0, sidebarWidth: 0, hideBrowser: false });
  assert.deepEqual(browserLayout(1100, 'about:blank', true), { type: 'layout.set', left: 228, top: 56, bottom: 0, sidebarWidth: 360, hideBrowser: true });
  assert.equal(browserLayout(1440, 'https://example.com', true).sidebarWidth, 380);
  assert.equal(browserLayout(1100, 'https://example.com/about:blank').hideBrowser, false);
  assert.equal(browserLayout(1100, 'about:newtab').hideBrowser, true);
});

test('composer Enter respects Korean IME and Shift line breaks', () => {
  assert.equal(shouldSubmitComposer('Enter', false, false, 13), true);
  assert.equal(shouldSubmitComposer('Enter', false, true, 13), false);
  assert.equal(shouldSubmitComposer('Enter', false, false, 229), false);
  assert.equal(shouldSubmitComposer('Enter', true, false, 13), false);
  assert.equal(shouldSubmitComposer('a', false, false, 65), false);
});
