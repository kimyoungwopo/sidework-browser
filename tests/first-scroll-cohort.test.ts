import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserPort, CoreSnapshot, ExecutionContext, Planner, PlanStep, TaskInput } from '../src/contract.ts';

const input = (tabId: string): TaskInput => ({ prompt: 'Read', profileId: 'p', tabId, computerUse: false });
const finish: PlanStep = { thought: 'Done', action: { type: 'finish', text: 'Done' } };
const scroll: PlanStep = { thought: 'Scroll', action: { type: 'scroll', direction: 'down' } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Expected runtime state not reached');
}
async function spinUntil(predicate: () => boolean) {
  for (let i = 0; i < 20_000; i++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.fail('Expected runtime state not reached with mocked timers');
}
async function fixture(planner: Planner, options: { browser?: BrowserPort; syncTimeoutMs?: number; onChange?: (snapshot: CoreSnapshot) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'first-scroll-'));
  const calls: ExecutionContext[] = [];
  const browser: BrowserPort = options.browser ?? {
    observe: async context => ({ ...context, revision: 1, url: 'https://example.test/', title: 'Test', text: 'Public', elements: [], capturedAt: 'now' }),
    execute: async (_action, context) => { calls.push(context); return { context, message: 'done' }; },
  };
  const store = new RuntimeStore(root);
  const runtime = new AgentRuntime({ store, browser, planner, onChange: options.onChange ?? (() => undefined), syncTimeoutMs: options.syncTimeoutMs ?? 500 });
  await runtime.initialize();
  return { runtime, store, calls, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('first scroll waits for all real plans, overlaps execute promises and leaves later actions independent', async () => {
  const secondPlan = deferred<PlanStep>();
  const motion = deferred<void>();
  const plans: { tab: string; sync: boolean | undefined; jobs: number }[] = [];
  const counts = new Map<string, number>();
  const executing: ExecutionContext[] = [];
  let active = 0, peak = 0;
  const f = await fixture({ next: async request => {
    plans.push({ tab: request.observation.tabId, sync: request.synchronizeFirstScroll, jobs: runtime.snapshot().jobs.length });
    const n = (counts.get(request.observation.tabId) ?? 0) + 1; counts.set(request.observation.tabId, n);
    if (n === 1 && request.observation.tabId === 'b') return secondPlan.promise;
    return n <= 2 ? scroll : finish;
  } }, { browser: {
    observe: async context => ({ ...context, revision: 1, url: 'https://example.test/', title: 'Test', text: 'Public', elements: [], capturedAt: 'now' }),
    execute: async (_action, context) => {
      executing.push(context); active++; peak = Math.max(peak, active);
      if (context.smoothScroll) await motion.promise;
      active--; return { context, message: 'done' };
    },
  } });
  const runtime:AgentRuntime = f.runtime;
  try {
    await runtime.startTogether([input('a'), input('b')]);
    await until(() => plans.length === 2);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(executing.length, 0, 'prepared scroll must not run before peer plan');
    assert.deepEqual(plans.map(p => p.sync), [true, true]);
    assert.ok(plans.every(p => p.jobs === 2), 'all members registered before any planner');
    secondPlan.resolve(scroll);
    await until(() => executing.length === 2);
    assert.equal(peak, 2, 'browser execute promises must actually overlap');
    assert.ok(executing.every(context => context.smoothScroll === true));
    motion.resolve();
    await until(() => !runtime.snapshot().activeJobId);
    assert.equal(executing.length, 4);
    assert.ok(executing.slice(2).every(context => context.smoothScroll === undefined));
    assert.ok(plans.slice(2).every(plan => plan.sync === undefined));
    assert.ok(runtime.snapshot().jobs.every(job => job.status === 'completed' && job.events.some(e => e.kind === 'status' && /released/i.test(e.text))));
  } finally { secondPlan.resolve(finish); motion.resolve(); await f.close(); }
});

test('cohort deadline fails waiting and stalled planning members without executing or retrying', async t => {
  const stalled = deferred<PlanStep>();
  const signals: AbortSignal[] = [];
  const f = await fixture({ next: async request => {
    signals.push(request.signal);
    return request.observation.tabId === 'b' ? stalled.promise : scroll;
  } }, { syncTimeoutMs: 80 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await f.runtime.startTogether([input('a'), input('b')]);
    await spinUntil(() => signals.length === 2 && f.runtime.snapshot().jobs.some(job => job.events.some(e => /prepared/.test(e.text))));
    t.mock.timers.tick(79);
    assert.equal(f.calls.length, 0);
    assert.equal(f.runtime.snapshot().activeJobIds!.length, 2);
    t.mock.timers.tick(1);
    await spinUntil(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.calls.length, 0);
    assert.ok(f.runtime.snapshot().jobs.every(job => job.status === 'failed' && job.events.some(e => /timed out/i.test(e.text))));
    assert.ok(signals.every(signal => signal.aborted));
    assert.ok(!f.runtime.snapshot().jobs.some(job => job.events.some(e => /released/i.test(e.text))));
    stalled.resolve(scroll);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    assert.equal(signals.length, 2);
  } finally { t.mock.timers.reset(); stalled.resolve(finish); await f.close(); }
});

test('synchronized marker persists strictly and restart interrupts without restoring cohort', async () => {
  const f = await fixture({ next: async () => new Promise<PlanStep>(() => undefined) });
  try {
    await f.runtime.startTogether([input('a'), input('b')]);
    const saved = await f.store.load();
    assert.ok(saved.jobs.every(job => job.synchronizedScroll === true));
    const recovered = new AgentRuntime({ store: f.store, planner: { next: async () => { assert.fail('No resume'); } }, browser: { observe: async () => { assert.fail('No observe'); }, execute: async () => { assert.fail('No execute'); } }, onChange: () => undefined });
    await recovered.initialize();
    assert.ok(recovered.snapshot().jobs.every(job => job.status === 'interrupted' && job.synchronizedScroll));
    await recovered.shutdown();
    saved.jobs[0]!.synchronizedScroll = 'yes' as unknown as boolean;
    await f.store.save(saved);
    await assert.rejects(f.store.load(), /safely/);
  } finally { await f.close(); }
});

test('storage failure aborts cohort without a release claim or leftover deadline', async () => {
  const second = deferred<PlanStep>();
  const f = await fixture({ next: async request => request.observation.tabId === 'a' ? scroll : second.promise }, { syncTimeoutMs: 120 });
  try {
    await f.runtime.startTogether([input('a'), input('b')]);
    await until(() => f.runtime.snapshot().jobs.some(j => j.tabId === 'a' && j.events.some(e => /prepared/.test(e.text))));
    // Drain first member's preparation publication so it really is waiting.
    await f.store.load();
    const save = f.store.save.bind(f.store);
    f.store.save = async state => {
      if (state.jobs.some(j => j.tabId === 'b' && j.events.some(e => /prepared/.test(e.text)))) throw new Error('private persistence path');
      await save(state);
    };
    second.resolve(scroll);
    await until(() => !f.runtime.snapshot().activeJobId);
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(f.calls.length, 0);
    assert.ok(f.runtime.snapshot().jobs.every(job => job.status === 'failed'));
    assert.ok(!f.runtime.snapshot().jobs.some(job => job.events.some(e => /released|timed out/.test(e.text))), 'storage failure must dispose, not release or keep timeout');
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('private persistence path'));
  } finally { second.resolve(finish); await f.close(); }
});

test('non-scroll first plans, finish and planner errors withdraw without blocking remaining scrolls', async () => {
  for (const departure of ['observe', 'finish', 'error'] as const) {
    const seen = new Map<string, number>();
    const f = await fixture({ next: async request => {
      const tab = request.observation.tabId;
      const n = (seen.get(tab) ?? 0) + 1; seen.set(tab, n);
      if (n > 1) return finish;
      if (tab === 'b') {
        if (departure === 'error') throw new Error('private model failure');
        return departure === 'finish' ? finish : { thought: 'Read', action: { type: 'observe' } };
      }
      return scroll;
    } });
    try {
      await f.runtime.startTogether([input('a'), input('b')]);
      await until(() => !f.runtime.snapshot().activeJobId);
      const jobs = f.runtime.snapshot().jobs;
      assert.equal(jobs.find(j => j.tabId === 'a')!.status, 'completed');
      assert.ok(jobs.find(j => j.tabId === 'a')!.events.some(e => /released: 1\/2/.test(e.text)));
      assert.ok(jobs.find(j => j.tabId === 'b')!.events.some(e => /Withdrawn/.test(e.text)));
      assert.equal(f.calls.filter(call => call.smoothScroll).length, 1);
      assert.ok(f.calls.filter(call => call.tabId === 'b').every(call => !call.smoothScroll));
      assert.ok(!JSON.stringify(jobs).includes('private model failure'));
    } finally { await f.close(); }
  }
});

test('cancelling a waiting member is prompt, independent and never releases its held plan', async () => {
  const late = deferred<PlanStep>();
  const counts = new Map<string, number>();
  const f = await fixture({ next: async request => {
    const tab = request.observation.tabId;
    const n = (counts.get(tab) ?? 0) + 1; counts.set(tab, n);
    return n > 1 ? finish : tab === 'b' ? late.promise : scroll;
  } });
  try {
    const ids = await f.runtime.startTogether([input('a'), input('b')]);
    await until(() => f.runtime.snapshot().jobs.some(j => j.tabId === 'a' && j.events.some(e => /prepared/.test(e.text))));
    await f.runtime.cancel(ids[0]!);
    assert.equal(f.runtime.snapshot().jobs.find(j => j.tabId === 'a')!.status, 'cancelled');
    assert.equal(f.runtime.snapshot().jobs.find(j => j.tabId === 'b')!.status, 'running');
    assert.equal(f.calls.length, 0);
    late.resolve(scroll);
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.deepEqual(f.calls.map(call => call.tabId), ['b']);
    assert.equal(f.calls[0]!.smoothScroll, true);
    assert.ok(f.runtime.snapshot().jobs.find(j => j.tabId === 'b')!.events.some(e => /released: 1\/2/.test(e.text)));
  } finally { late.resolve(finish); await f.close(); }
});

test('fresh observations after rendezvous keep original revisions without rebasing stale plans', async () => {
  const peer = deferred<PlanStep>();
  let revision = 1;
  const calls: ExecutionContext[] = [];
  const counts = new Map<string, number>();
  const f = await fixture({ next: async request => {
    const tab = request.observation.tabId;
    const n = (counts.get(tab) ?? 0) + 1; counts.set(tab, n);
    return n > 1 ? finish : tab === 'b' ? peer.promise : scroll;
  } }, { browser: {
    observe: async context => ({ ...context, revision: context.tabId === 'a' ? revision : 1, url: 'https://example.test/', title: 'Test', text: 'Public', elements: [], capturedAt: 'now' }),
    execute: async (_action, context) => { calls.push(context); return { context, message: 'done' }; },
  } });
  try {
    await f.runtime.startTogether([input('a'), input('b')]);
    await until(() => f.runtime.snapshot().jobs.some(j => j.tabId === 'a' && j.events.some(e => /prepared/.test(e.text))));
    revision = 2; peer.resolve(scroll);
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs.find(j => j.tabId === 'a')!.status, 'failed');
    assert.deepEqual(calls.map(call => call.tabId), ['b']);
    assert.equal(calls[0]!.expectedRevision, 1);
    assert.equal(counts.get('a'), 1, 'stale first plan is not retried');
    assert(f.runtime.snapshot().jobs.find(j=>j.tabId==='a')!.events.some(e=>e.kind==='status'&&e.text==='실행 전 페이지가 변경되어 오래된 계획을 차단했습니다. 자동 재실행하지 않았습니다.'));
  } finally { peer.resolve(finish); await f.close(); }
});

test('ordinary jobs and a second cohort execute while another cohort waits; model slots are released', async () => {
  const stalled = deferred<PlanStep>();
  const counts = new Map<string, number>();
  // A one-slot planner serializes actual planning, not the held prepared plans.
  let slot: Promise<unknown> = Promise.resolve();
  let active = 0, peak = 0;
  const f = await fixture({ next: request => {
    const plan = slot.then(async () => {
      active++; peak = Math.max(peak, active);
      try {
        const tab = request.observation.tabId;
        const n = (counts.get(tab) ?? 0) + 1; counts.set(tab, n);
        return n > 1 ? finish : scroll;
      } finally { active--; }
    });
    slot = plan;
    // Simulate a delayed response outside the scarce planner-process lease.
    return request.observation.tabId === 'b' ? stalled.promise : plan;
  } });
  try {
    const first = await f.runtime.startTogether([input('a'), input('b')]);
    await until(() => counts.has('b'));
    await f.runtime.start(input('ordinary'));
    await f.runtime.startTogether([input('c'), input('d'), input('e'), input('f')]);
    await until(() => f.calls.length === 5);
    assert.equal(peak, 1);
    assert.ok(f.calls.some(call => call.tabId === 'ordinary' && call.smoothScroll === undefined));
    assert.equal(f.calls.filter(call => call.smoothScroll).length, 4);
    assert.ok(f.runtime.snapshot().jobs.filter(j => first.includes(j.id)).every(j => j.status === 'running'));
    await f.runtime.cancel(first[1]!);
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.calls.filter(call => call.tabId === 'a').length, 1);
  } finally { stalled.resolve(finish); await f.close(); }
});

test('batch capacity and existing-tab conflicts are prevalidated without altering ordinary jobs', async () => {
  const f = await fixture({ next: async () => new Promise<PlanStep>(() => undefined) });
  try {
    const original = await f.runtime.start(input('ordinary'));
    await assert.rejects(f.runtime.startTogether([input('a'), input('ordinary')]), /duplicate/);
    await assert.rejects(f.runtime.startTogether(Array.from({ length: 8 }, (_, i) => input(String(i)))), /limit/);
    assert.deepEqual(f.runtime.snapshot().jobs.map(j => j.id), [original]);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'running');
    await f.runtime.startTogether(Array.from({ length: 7 }, (_, i) => input(String(i))));
    assert.equal(f.runtime.snapshot().activeJobIds!.length, 8);
    await assert.rejects(f.runtime.start(input('overflow')), /limit/);
    await f.runtime.cancelAll();
    assert.ok(f.runtime.snapshot().jobs.every(j => j.status === 'cancelled'));
    await assert.rejects(f.runtime.startTogether([input('0'), input('1')]).then(() => f.runtime.shutdown()).then(() => f.runtime.startTogether([input('a'), input('b')])), /closed/);
  } finally { await f.close(); }
});

test('startup notification failure rolls back and persists only new group without touching an existing job', async () => {
  let rejectStartup = true;
  const f = await fixture({ next: async () => new Promise<PlanStep>(() => undefined) }, { onChange: state => {
    if (rejectStartup && state.jobs.some(job => job.synchronizedScroll)) { rejectStartup = false; throw new Error('startup callback failed'); }
  } });
  try {
    const existing = await f.runtime.start(input('ordinary'));
    await assert.rejects(f.runtime.startTogether([input('a'), input('b')]));
    assert.deepEqual(f.runtime.snapshot().jobs.map(job => job.id), [existing]);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'running');
    assert.deepEqual((await f.store.load()).jobs.map(job => job.id), [existing], 'rollback must be persisted too');
    await f.runtime.startTogether([input('a'), input('b')]);
    assert.equal(f.runtime.snapshot().activeJobIds!.length, 3);
  } finally { await f.close(); }
});

test('initial group storage failure rolls back all new members and preserves fail-closed handling of existing runs', async () => {
  let plans = 0;
  const notifications: CoreSnapshot[] = [];
  const f = await fixture({ next: async () => { plans++; return new Promise<PlanStep>(() => undefined); } }, { onChange: state => notifications.push(state) });
  try {
    const existing = await f.runtime.start(input('ordinary'));
    await until(() => plans === 1);
    f.store.save = async () => { throw new Error('private storage error'); };
    await assert.rejects(f.runtime.startTogether([input('a'), input('b')]), /could not be saved/);
    assert.deepEqual(f.runtime.snapshot().jobs.map(job => job.id), [existing]);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.equal(plans, 1);
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('private storage error'));
    assert.deepEqual(notifications.at(-1)!.jobs.map(job => job.id), [existing], 'rollback must be visible even when disk cannot save');
    await assert.rejects(f.runtime.start(input('later')), /closed/);
  } finally { await f.close(); }
});

test('startTogether validates entire strict batch before creating any jobs', async () => {
  let plans = 0;
  const f = await fixture({ next: async () => { plans++; return finish; } });
  try {
    const invalid = [[], [input('a')], Array.from({ length: 9 }, (_, i) => input(String(i))), [input('a'), input('a')], [input('a'), { ...input('b'), profileId: 'other' }], [input('a'), { ...input('b'), prompt: '' }], [input('a'), { ...input('b'), computerUse: true, shareScreen: true }], [input('a'), { ...input('b'), synchronizedScroll: true }], [input('a'), { ...input('b'), shareScreen: 'yes' }]];
    for (const batch of invalid) await assert.rejects(f.runtime.startTogether(batch as TaskInput[]));
    assert.equal(plans, 0);
    assert.equal(f.runtime.snapshot().jobs.length, 0);
    const ids = await f.runtime.startTogether([input('a'), input('b')]);
    assert.equal(ids.length, 2);
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.ok(f.runtime.snapshot().jobs.every(job => job.synchronizedScroll === true));
  } finally { await f.close(); }
});
