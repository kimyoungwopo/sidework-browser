import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserPort, BrowserContext, ExecutionContext, Observation, Planner, PlannerInput, PlanStep } from '../src/contract.ts';

const finish: PlanStep = { thought: 'Collected actual sections', action: { type: 'finish', text: 'Evidence received' } };
const read: PlanStep = { thought: 'Collect this long document', action: { type: 'read_page', maxScreens: 4 } };
const task = (tabId: string) => ({ prompt: 'Read the document and report the observed sections', profileId: 'p', tabId });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 3)); }
  assert.fail('Expected reading runtime state not reached');
}
function observed(context: BrowserContext, index: number): Observation {
  return { ...context, revision: index + 1, url: `https://example.test/${context.tabId}`, title: 'Long document', text: 'Initial bounded summary', elements: [{ ref: 'r1', tag: 'button', role: 'button', name: 'Review', inputType: '', sensitive: false }], capturedAt: 'now', readingViewport: { documentId: `document-${context.tabId}`, scrollY: index * 600, height: 600, scrollHeight: 2400, text: `Observed section ${index + 1}` } };
}
async function fixture(planner: Planner, browser: BrowserPort) {
  const root = await mkdtemp(join(tmpdir(), 'reading-runtime-'));
  const runtime = new AgentRuntime({ store: new RuntimeStore(root), planner, browser, onChange: () => undefined });
  await runtime.initialize();
  return { runtime, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('one read plan collects four fresh sections and returns evidence in only the next model turn', async () => {
  let index = 0;
  const plans: PlannerInput[] = [], calls: ExecutionContext[] = [];
  const f = await fixture({ next: async request => { plans.push({ ...request, observation: structuredClone(request.observation), ...(request.pageReading ? { pageReading: structuredClone(request.pageReading) } : {}) }); return plans.length === 1 ? read : finish; } }, {
    observe: async context => observed(context, index),
    execute: async (action, context) => { assert.deepEqual(action, { type: 'scroll', direction: 'down' }); assert.equal(context.expectedRevision, index + 1); calls.push(context); index++; return { context, message: 'Scrolled actual test document' }; },
  });
  try {
    await f.runtime.start(task('a')); await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'completed');
    assert.equal(plans.length, 2, 'No per-scroll planner round trips');
    assert.equal(calls.length, 3);
    assert.deepEqual(plans[1]!.pageReading, { profileId: 'p', tabId: 'a', url: 'https://example.test/a', documentId: 'document-a', sections: [0, 1, 2, 3].map(i => ({ scrollY: i * 600, text: `Observed section ${i + 1}` })), complete: true, stopReason: 'bottom' });
    assert(f.runtime.snapshot().jobs[0]!.events.some(event => event.text.includes('본문 수집 4/4')));
  } finally { await f.close(); }
});

test('separately approved navigation discards collection from the previous document', async () => {
  let index = 0, navigated = false, turns = 0;
  const f = await fixture({ next: async request => {
    turns++;
    if (turns === 1) return read;
    if (turns === 2) return { thought: 'Ask for a distinct navigation approval', action: { type: 'navigate', url: 'https://example.test/next' } };
    assert.equal(request.pageReading, undefined, 'Old document evidence must not be forwarded');
    return finish;
  } }, {
    observe: async context => ({ ...observed(context, index), ...(navigated ? { url: 'https://example.test/next', readingViewport: { ...observed(context, 0).readingViewport!, documentId: 'new-document' } } : {}) }),
    execute: async (action, context) => { if (action.type === 'scroll') index++; else { assert.equal(action.type, 'navigate'); navigated = true; } return { context, message: 'Performed' }; },
  });
  try {
    const id = await f.runtime.start(task('a'));
    await until(() => f.runtime.snapshot().jobs[0]!.status === 'awaiting_approval');
    const approval = f.runtime.snapshot().jobs[0]!.approval!;
    assert.equal(navigated, false);
    await f.runtime.approve({ jobId: id, approvalId: approval.id, allow: true });
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'completed');
    assert.equal(turns, 3);
  } finally { await f.close(); }
});


test('approval-held peer does not block a multi-screen read-only collection', async () => {
  const indices = new Map<string, number>(), planCounts = new Map<string, number>(), calls: string[] = [];
  const f = await fixture({ next: async request => {
    const tab = request.observation.tabId;
    planCounts.set(tab, (planCounts.get(tab) ?? 0) + 1);
    if (tab === 'a') return { thought: 'Wait for a real human approval', action: { type: 'click', ref: 'r1' } };
    return request.pageReading ? finish : read;
  } }, {
    observe: async context => observed(context, indices.get(context.tabId) ?? 0),
    execute: async (action, context) => { assert.equal(action.type, 'scroll'); calls.push(context.tabId); indices.set(context.tabId, (indices.get(context.tabId) ?? 0) + 1); return { context, message: 'Scrolled' }; },
  });
  try {
    const [a, b] = await f.runtime.startBatch([task('a'), task('b')]);
    await until(() => f.runtime.snapshot().jobs.find(job => job.id === b)?.status === 'completed');
    assert.equal(f.runtime.snapshot().jobs.find(job => job.id === a)?.status, 'awaiting_approval');
    assert.deepEqual(calls, ['b', 'b', 'b']);
    assert.equal(planCounts.get('b'), 2);
    const ticket = f.runtime.snapshot().jobs.find(job => job.id === a)!.approval!.id;
    await f.runtime.cancel(a!);
    await assert.rejects(f.runtime.approve({ jobId: a!, approvalId: ticket, allow: true }));
    assert.equal(f.runtime.snapshot().jobs.find(job => job.id === b)?.status, 'completed');
  } finally { await f.close(); }
});

test('cancelling a read in flight prevents later scrolls and leaves its peer completed', async () => {
  const indices = new Map<string, number>(), calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ next: async request => request.pageReading ? finish : read }, {
    observe: async context => observed(context, indices.get(context.tabId) ?? 0),
    execute: async (_action, context) => { calls.push(context.tabId); if (context.tabId === 'a') await held; indices.set(context.tabId, (indices.get(context.tabId) ?? 0) + 1); return { context, message: 'Scrolled' }; },
  });
  try {
    const [a, b] = await f.runtime.startBatch([task('a'), task('b')]);
    await until(() => calls.includes('a') && f.runtime.snapshot().jobs.find(job => job.id === b)?.status === 'completed');
    await f.runtime.cancel(a!); release();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.runtime.snapshot().jobs.find(job => job.id === a)?.status, 'cancelled');
    assert.equal(calls.filter(tab => tab === 'a').length, 1);
    assert.equal(calls.filter(tab => tab === 'b').length, 3);
  } finally { release(); await f.close(); }
});

test('same-URL document replacement stops collection without replay or cross-document evidence', async () => {
  let index = 0, plans = 0;
  const f = await fixture({ next: async () => { plans++; return read; } }, {
    observe: async context => { const result = observed(context, index); if (index) result.readingViewport!.documentId = 'replacement-at-same-url'; return result; },
    execute: async (_action, context) => { index++; return { context, message: 'Scrolled before replacement' }; },
  });
  try {
    await f.runtime.start(task('a')); await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
    assert.equal(index, 1); assert.equal(plans, 1);
  } finally { await f.close(); }
});

test('screen bound returns honest partial evidence instead of a complete-document claim', async () => {
  let index = 0, turns = 0;
  const f = await fixture({ next: async request => {
    turns++; if (turns === 1) return { thought: 'Read at most two screens', action: { type: 'read_page', maxScreens: 2 } };
    assert.equal(request.pageReading!.complete, false); assert.equal(request.pageReading!.stopReason, 'limit'); assert.equal(request.pageReading!.sections.length, 2);
    return finish;
  } }, {
    observe: async context => observed(context, index),
    execute: async (_action, context) => { index++; return { context, message: 'Scrolled' }; },
  });
  try { await f.runtime.start(task('a')); await until(() => !f.runtime.snapshot().activeJobId); assert.equal(f.runtime.snapshot().jobs[0]!.status, 'completed'); assert.equal(index, 1); }
  finally { await f.close(); }
});

test('maxSteps remains a hard action budget inside a read macro', async () => {
  let index = 0, plans = 0;
  const f = await fixture({ next: async () => { plans++; return { thought: 'Bounded reading', action: { type: 'read_page', maxScreens: 8 } }; } }, {
    observe: async context => observed(context, index),
    execute: async (_action, context) => { index++; return { context, message: 'Scrolled' }; },
  });
  try {
    await f.runtime.updateSettings({ maxSteps: 3 }); await f.runtime.start(task('a')); await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(index, 2); assert.equal(plans, 1); assert.equal(f.runtime.snapshot().jobs[0]!.steps, 3); assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
  } finally { await f.close(); }
});

for (const kind of ['missing', 'non-finite', 'too-short', 'empty', 'no-progress', 'wrong-target'] as const) {
  test(`read collection fails closed for ${kind} and does not retry`, async () => {
    let calls = 0, plans = 0;
    const f = await fixture({ next: async () => { plans++; return read; } }, {
      observe: async context => {
        const result = observed(context, 0);
        if (kind === 'missing') delete result.readingViewport;
        if (kind === 'non-finite') result.readingViewport!.scrollY = NaN;
        if (kind === 'too-short') result.readingViewport!.height = 599;
        if (kind === 'empty') result.readingViewport!.text = '';
        return result;
      },
      execute: async (_action, context) => { calls++; return { context: kind === 'wrong-target' ? { profileId: 'foreign', tabId: 'foreign' } : context, message: 'No verified progress' }; },
    });
    try {
      await f.runtime.start(task('a')); await until(() => !f.runtime.snapshot().activeJobId);
      assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed'); assert.equal(plans, 1);
      assert.equal(calls, ['wrong-target', 'no-progress'].includes(kind) ? 1 : 0);
    } finally { await f.close(); }
  });
}
