import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/desktop/security.ts';
import * as taskHelpers from '../src/desktop/tasks.ts';
import type { AppCommand, BrowserState, BridgeCommand, Job } from '../src/contract.ts';

test('section tasks accept different exact requests with document-bound consent', () => {
  const command = { type: 'jobs.startSections', consent: true, tasks: [
    { tabId: 'one', expectedRevision: 4, expectedUrl: 'https://example.com/', prompt: '  read the first screen  ' },
    { tabId: 'two', expectedRevision: 7, expectedUrl: 'https://example.org/', prompt: 'click the green button' },
  ] };
  assert.deepEqual(parseCommand(command), command);
});

const sectionState = (): BrowserState => ({
  profiles: [{ id: 'default', name: '기본', incognito: false }], activeProfileId: 'default', activeTabId: 'one', splitCount: 2, paneTabIds: ['one', 'two'],
  tabs: ['one', 'two'].map((id, index) => ({ id, profileId: 'default', title: id, url: `https://example.${index ? 'org' : 'com'}/`, revision: index + 4, isLoading: false, canGoBack: false, canGoForward: false, ownership: 'user' })),
});
function sectionCommand(state = sectionState()): Extract<AppCommand, { type: 'jobs.startSections' }> {
  return { type: 'jobs.startSections', consent: true, tasks: state.tabs.map((tab, index) => ({ tabId: tab.id, expectedUrl: tab.url, expectedRevision: tab.revision, prompt: `  screen ${index + 1} only  ` })) };
}
test('section batch derives isolated computer tasks with exact initial document claims', () => {
  assert.equal(typeof taskHelpers.sectionBatchInputs, 'function');
  const state = sectionState(), command = sectionCommand(state);
  const inputs = taskHelpers.sectionBatchInputs(state, [], command);
  assert.deepEqual(inputs, state.tabs.map((tab, index) => ({ prompt: command.tasks[index].prompt, profileId: 'default', tabId: tab.id, computerUse: true, shareScreen: true, initialDocument: { url: tab.url, revision: tab.revision } })));
});

test('section consent refuses a changed or still-loading document instead of rebasing', () => {
  for (const patch of [{ revision: 99 }, { url: 'https://example.com/changed' }, { isLoading: true }]) {
    const state = sectionState(), command = sectionCommand(state);
    Object.assign(state.tabs[1], patch);
    assert.throws(() => taskHelpers.sectionBatchInputs(state, [], command), /페이지|문서/);
  }
});

function activeJob(tabId: string): Job {
  return { id: `job-${tabId}`, tabId, profileId: 'default', prompt: 'already active', status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
}
test('section batch refuses occupied targets and capacity overflow as a whole', () => {
  assert.throws(() => taskHelpers.sectionBatchInputs(sectionState(), [activeJob('one')], sectionCommand()), /진행|작업/);
  const jobs = Array.from({ length: 7 }, (_, i) => activeJob(`other-${i}`));
  assert.throws(() => taskHelpers.sectionBatchInputs(sectionState(), jobs, sectionCommand()), /작업/);
});

test('section sharing rejects credential-bearing URLs before any model work', () => {
  for (const url of ['https://user:pass@example.com/', 'https://example.com/?token=private', 'https://example.com/#password=private']) {
    const state = sectionState(); state.tabs[0].url = url;
    assert.throws(() => taskHelpers.sectionBatchInputs(state, [], sectionCommand(state)));
  }
});

test('section strict parser and target checks retain fail-closed boundaries', () => {
  const command = sectionCommand();
  for (const patch of [{ consent: false }, { tasks: [] }, { tasks: Array(9).fill(command.tasks[0]) }, { tasks: [command.tasks[0], command.tasks[0]] }, { path: '/tmp' }]) assert.throws(() => parseCommand({ ...command, ...patch }));
  for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 1.1 }, { expectedRevision: NaN }, { expectedUrl: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(8001) }, { computerUse: false }, { appPath: '/arbitrary' }]) assert.throws(() => parseCommand({ ...command, tasks: [{ ...command.tasks[0], ...patch }] }));
  const state = sectionState();
  assert.throws(() => taskHelpers.sectionBatchInputs({ ...state, paneTabIds: ['one'] }, [], command));
  assert.throws(() => taskHelpers.sectionBatchInputs({ ...state, profiles: [{ ...state.profiles[0], incognito: true }] }, [], command));
  assert.throws(() => taskHelpers.sectionBatchInputs({ ...state, activeProfileId: 'other' }, [], command));
});

test('section parent dispatch posts exactly one independent batch and sends nothing on stale consent', async () => {
  assert.equal(typeof taskHelpers.startSectionJobs, 'function');
  const messages: BridgeCommand[] = [], state = sectionState();
  const send = async (message: BridgeCommand) => { messages.push(message); };
  await taskHelpers.startSectionJobs(state, [], sectionCommand(state), send);
  assert.deepEqual(messages, [{ type: 'startBatch', inputs: taskHelpers.sectionBatchInputs(state, [], sectionCommand(state)) }]);
  const stale = sectionCommand(state); stale.tasks[1].expectedRevision++;
  await assert.rejects(taskHelpers.startSectionJobs(state, [], stale, send));
  assert.equal(messages.length, 1);
});
