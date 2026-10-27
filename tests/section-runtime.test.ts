import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserPort, CoreSnapshot, ExecutionContext, Observation, Planner, PlanStep, TaskInput } from '../src/contract.ts';

const input = (tabId: string): TaskInput => ({ prompt: `Read ${tabId}`, profileId: 'p', tabId });
const finish: PlanStep = { thought: 'Done', action: { type: 'finish', text: 'Done' } };
const scroll: PlanStep = { thought: 'Read further', action: { type: 'scroll', direction: 'down' } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const observed = (context: { profileId: string; tabId: string }): Observation => ({ ...context, revision: 1, url: 'https://example.test/', title: 'Public', text: 'Public', elements: [{ ref: 'r', tag: 'button', role: 'button', name: 'Go', inputType: '', sensitive: false }], capturedAt: 'now' });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 3)); }
  assert.fail('Expected runtime state not reached');
}
async function fixture(planner: Planner, options: { browser?: BrowserPort; onChange?: (state: CoreSnapshot) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'section-runtime-'));
  const calls: ExecutionContext[] = [];
  const reads: string[] = [];
  const store = new RuntimeStore(root);
  const runtime = new AgentRuntime({ store, planner, browser: options.browser ?? {
    observe: async context => { reads.push(context.tabId); return observed(context); },
    execute: async (_action, context) => { calls.push(context); return { context, message: 'Done' }; },
  }, onChange: options.onChange ?? (() => undefined) });
  await runtime.initialize();
  return { runtime, store, calls, reads, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('peer completes four fresh read actions while another job remains inside planning', async () => {
  const held = deferred<PlanStep>(), counts = new Map<string, number>();
  const f = await fixture({ next: async request => {
    const tab=request.observation.tabId;
    if(tab==='a')return held.promise;
    const count=(counts.get(tab)??0)+1;counts.set(tab,count);
    return count<=4?scroll:finish;
  }});
  try {
    const [a,b]=await f.runtime.startBatch([input('a'),input('b')]);
    await until(()=>f.runtime.snapshot().jobs.find(job=>job.id===b)?.status==='completed');
    const snapshot=f.runtime.snapshot();
    assert.equal(snapshot.jobs.find(job=>job.id===a)?.status,'running');
    assert.equal(snapshot.jobs.find(job=>job.id===a)?.steps,0);
    assert.deepEqual(f.calls.map(call=>call.tabId),['b','b','b','b']);
    assert(f.reads.filter(tab=>tab==='b').length>=4*3+1,'Each peer step needs fresh pre/post observations');
    await f.runtime.cancel(a!);
  }finally{held.resolve(finish);await f.close();}
});

test('peer completes four fresh read actions without resolving another job approval', async () => {
  const counts=new Map<string,number>();
  const f=await fixture({next:async request=>{
    if(request.observation.tabId==='a')return {thought:'User approval is required',action:{type:'click',ref:'r'}};
    const count=(counts.get('b')??0)+1;counts.set('b',count);return count<=4?scroll:finish;
  }});
  try{
    const [a,b]=await f.runtime.startBatch([input('a'),input('b')]);
    await until(()=>f.runtime.snapshot().jobs.find(job=>job.id===a)?.status==='awaiting_approval'&&f.runtime.snapshot().jobs.find(job=>job.id===b)?.status==='completed');
    const approval=f.runtime.snapshot().jobs.find(job=>job.id===a)!.approval!;
    assert(approval);assert.deepEqual(f.calls.map(call=>call.tabId),['b','b','b','b']);
    assert(f.reads.filter(tab=>tab==='b').length>=4*3+1);
    await f.runtime.cancel(a!);
    await assert.rejects(f.runtime.approve({jobId:a!,approvalId:approval.id,allow:true}));
  }finally{await f.close();}
});

test('safe failure diagnostics identify invalid screenshot input without exposing provider text', async () => {
  const f = await fixture({ next: async () => { throw new Error('Invalid screen PNG image/frame bounds.'); } });
  try {
    await f.runtime.start(input('diagnostic'));
    await until(() => !f.runtime.snapshot().activeJobId);
    const events = f.runtime.snapshot().jobs[0].events;
    assert(events.some(event => event.kind === 'error' && event.text.includes('plan:invalid-screen-frame')));
    assert(events.some(event => event.kind === 'error' && /runtime\.ts:\d+:\d+/.test(event.text)));
  } finally { await f.close(); }
});

test('persisted document bindings validate strictly and restart interrupts instead of resuming', async () => {
  const f = await fixture({ next: async () => new Promise<PlanStep>(() => undefined) });
  try {
    await f.runtime.startBatch([{ ...input('a'), initialDocument: { url: 'https://example.test/', revision: 1 } }]);
    const saved = await f.store.load();
    const recovered = new AgentRuntime({ store: f.store, planner: { next: async () => { assert.fail('No model restart'); } }, browser: {
      observe: async () => { assert.fail('No browser restart'); }, execute: async () => { assert.fail('No execution restart'); },
    }, onChange: () => undefined });
    await recovered.initialize();
    assert.equal(recovered.snapshot().jobs[0]!.status, 'interrupted');
    assert.deepEqual(recovered.snapshot().jobs[0]!.initialDocument, { url: 'https://example.test/', revision: 1 });
    await recovered.shutdown();
    for (const invalid of [null, [], { url: 'https://example.test/', revision: 1, extra: true }, { url: 'https://example.test/', revision: -1 }, { url: 'https://example.test/', revision: Number.MAX_SAFE_INTEGER + 1 }, { url: 10, revision: 1 }]) {
      const corrupt = structuredClone(saved);
      corrupt.jobs[0]!.initialDocument = invalid as unknown as TaskInput['initialDocument'];
      await f.store.save(corrupt);
      await assert.rejects(f.store.load(), /safely/);
    }
  } finally { await f.close(); }
});

test('array-shaped tasks are rejected before preregistration even when named fields look valid', async () => {
  const f = await fixture({ next: async () => finish });
  try {
    const before = f.runtime.snapshot();
    await assert.rejects(f.runtime.startBatch([input('valid'), Object.assign([], input('array'))]));
    assert.deepEqual(f.runtime.snapshot(), before);
    assert.deepEqual(f.reads, []);
  } finally { await f.close(); }
});

test('first-document consent is consumed once and later navigation uses ordinary revision leases', async () => {
  let revision = 1;
  let url = 'https://example.test/';
  const plans: Observation[] = [];
  const executions: ExecutionContext[] = [];
  const f = await fixture({ next: async request => {
    plans.push(request.observation);
    return plans.length === 1 ? { thought: 'Read next public page', action: { type: 'navigate', url: 'https://example.test/next' } } : finish;
  } }, { browser: {
    observe: async context => ({ ...observed(context), revision, url }),
    execute: async (action, context) => {
      executions.push(context);
      assert.equal(action.type, 'navigate');
      revision = 2; url = 'https://example.test/next';
      return { context, message: 'Navigated' };
    },
  } });
  try {
    const [id] = await f.runtime.startBatch([{ ...input('a'), computerUse: true, shareScreen: true, initialDocument: { url, revision } }]);
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs.find(j => j.id === id)!.status, 'completed');
    assert.deepEqual(plans.map(p => [p.url, p.revision]), [['https://example.test/', 1], ['https://example.test/next', 2]]);
    assert.equal(executions[0]!.expectedRevision, 1);
    assert.equal(executions.length, 1);
  } finally { await f.close(); }
});

test('batch prevalidation is all-or-none across malformed tasks, profiles, duplicates, capacity and active conflicts', async () => {
  let plans = 0;
  let publications = 0;
  const f = await fixture({ next: async () => { plans++; return new Promise<PlanStep>(() => undefined); } }, { onChange: () => { publications++; } });
  try {
    const existing = await f.runtime.start(input('existing'));
    await until(() => plans === 1);
    const before = f.runtime.snapshot();
    const published = publications;
    const reads = f.reads.length;
    const invalid: unknown[] = [null, {}, [], Array.from({ length: 9 }, (_, i) => input(String(i))), [input('a'), input('a')], [input('a'), input('existing')], [input('a'), { ...input('b'), profileId: 'other' }], [input('a'), { ...input('b'), prompt: '' }], [input('a'), { ...input('b'), prompt: 'x'.repeat(16001) }], [input('a'), { ...input('b'), tabId: '' }], [input('a'), { ...input('b'), computerUse: true }], [input('a'), { ...input('b'), shareScreen: 'yes' }], [input('a'), { ...input('b'), synchronizedScroll: true }], [input('a'), { ...input('b'), initialDocument: { url: 'https://example.test/', revision: 1, hidden: true } }], Array.from({ length: 8 }, (_, i) => input(String(i)))];
    for (const batch of invalid) {
      await assert.rejects(f.runtime.startBatch(batch as TaskInput[]));
      assert.deepEqual(f.runtime.snapshot(), before);
      assert.equal(publications, published);
      assert.equal(f.reads.length, reads);
      assert.equal(plans, 1);
    }
    const ids = await f.runtime.startBatch(Array.from({ length: 7 }, (_, i) => input(String(i))));
    assert.equal(ids.length, 7);
    assert.equal(f.runtime.snapshot().activeJobIds!.length, 8);
    assert.ok(f.runtime.snapshot().activeJobIds!.includes(existing));
    await assert.rejects(f.runtime.startBatch([input('overflow')]), /limit/);
    await f.runtime.cancelAll();
    assert.ok(f.runtime.snapshot().jobs.every(j => j.status === 'cancelled'));
    await f.runtime.shutdown();
    await assert.rejects(f.runtime.startBatch([input('closed')]), /closed/);
  } finally { await f.close(); }
});

test('computer batch approval and cancellation never block another prompt or leak its screen bytes', async () => {
  for (const cancelFirst of [false, true]) {
    const release = deferred<PlanStep>();
    const signals = new Map<string, AbortSignal>();
    const counts = new Map<string, number>();
    const bytes = 'SCREEN-BYTES-NEVER-PERSIST';
    const calls: string[] = [];
    const f = await fixture({ next: async request => {
      signals.set(request.observation.tabId, request.signal);
      const n = (counts.get(request.observation.tabId) ?? 0) + 1; counts.set(request.observation.tabId, n);
      assert.equal(request.computerUse, true);
      assert.equal(request.synchronizeFirstScroll, undefined);
      if (request.observation.tabId === 'a') return { thought: 'Needs explicit approval', action: { type: 'computer_type', value: 'private-filled-value', frameId: 'frame' } };
      return n === 1 ? release.promise : { thought: bytes, action: { type: 'finish', text: `Finished ${bytes}` } };
    } }, { browser: {
      observe: async (context, options) => {
        assert.ok(options?.jobId);assert.equal(f.runtime.snapshot().jobs.find(job=>job.id===options.jobId)?.tabId,context.tabId);
        assert.deepEqual(options, {jobId:options.jobId, computerUse: true, shareScreen: true });
        return { ...observed(context), text: bytes, screen: { frameId: 'frame', width: 100, height: 100, viewportWidth: 100, viewportHeight: 100, pngBase64: bytes, safeLinks: [] } };
      },
      execute: async (_action, context) => { calls.push(context.tabId); return { context, message: 'Done' }; },
    } });
    try {
      const [a, b] = await f.runtime.startBatch(['a', 'b'].map(tab => ({ ...input(tab), computerUse: true, shareScreen: true, initialDocument: { url: 'https://example.test/', revision: 1 } })));
      await until(() => f.runtime.snapshot().jobs.find(j => j.id === a)?.status === 'awaiting_approval' && signals.has('b'));
      const approval = f.runtime.snapshot().jobs.find(j => j.id === a)!.approval!;
      if (cancelFirst) await f.runtime.cancel(a!);
      release.resolve(scroll);
      await until(() => f.runtime.snapshot().jobs.find(j => j.id === b)?.status === 'completed');
      assert.equal(signals.get('b')!.aborted, false);
      if (!cancelFirst) {
        assert.equal(f.runtime.snapshot().jobs.find(j => j.id === a)!.status, 'awaiting_approval');
        await f.runtime.cancel(a!);
      }
      await assert.rejects(f.runtime.approve({ jobId: a!, approvalId: approval.id, allow: true }));
      assert.equal(signals.get('a')!.aborted, true);
      assert.deepEqual(calls, ['b']);
      assert.equal(f.runtime.snapshot().jobs.find(j => j.id === a)!.status, 'cancelled');
      const persisted = JSON.stringify(await f.store.load());
      assert.ok(!persisted.includes(bytes));
      assert.ok(!persisted.includes('private-filled-value'));
    } finally { release.resolve(finish); await f.close(); }
  }
});

test('caller cannot rebase first-document consent while single or legacy group startup is publishing', async () => {
  for (const mode of ['single', 'together'] as const) {
    let plans = 0;
    const f = await fixture({ next: async () => { plans++; return finish; } });
    const saved = deferred<void>();
    const entered = deferred<void>();
    const original = f.store.save.bind(f.store);
    let hold = true;
    f.store.save = async snapshot => { if (hold) { hold = false; entered.resolve(); await saved.promise; } await original(snapshot); };
    try {
      const task = { ...input('a'), initialDocument: { url: 'https://not-consented.test/', revision: 2 } };
      const starting = mode === 'single' ? f.runtime.start(task) : f.runtime.startTogether([task, { ...input('b'), initialDocument: { url: 'https://not-consented.test/', revision: 2 } }]);
      await entered.promise;
      task.initialDocument.url = 'https://example.test/'; task.initialDocument.revision = 1;
      saved.resolve(); await starting;
      await until(() => !f.runtime.snapshot().activeJobId);
      assert.equal(plans, 0);
      assert.ok(f.runtime.snapshot().jobs.every(j => j.status === 'failed' && j.initialDocument?.revision === 2));
    } finally { saved.resolve(); await f.close(); }
  }
});

test('first observation must match consent before planner sees any changed document', async () => {
  for (const mode of ['single', 'batch'] as const) for (const change of ['url', 'revision', 'both'] as const) {
    let plans = 0;
    const f = await fixture({ next: async () => { plans++; return finish; } }, { browser: {
      observe: async context => ({ ...observed(context), url: change === 'revision' ? 'https://example.test/' : 'https://changed.test/', revision: change === 'url' ? 1 : 2, text: 'MUST-NOT-TRANSMIT-DOCUMENT' }),
      execute: async () => { assert.fail('No execution after consent mismatch'); },
    } });
    try {
      const task = { ...input('a'), computerUse: true, shareScreen: true, initialDocument: { url: 'https://example.test/', revision: 1 } };
      const id = mode === 'single' ? await f.runtime.start(task) : (await f.runtime.startBatch([task]))[0]!;
      await until(() => !f.runtime.snapshot().activeJobId);
      assert.equal(plans, 0, `${mode}/${change}: changed document cannot reach planner`);
      const job = f.runtime.snapshot().jobs.find(j => j.id === id)!;
      assert.equal(job.status, 'failed');
      assert.equal(job.steps, 0);
      assert.equal(job.approval, null);
      assert.ok(!JSON.stringify(job).includes('MUST-NOT-TRANSMIT-DOCUMENT'));
    } finally { await f.close(); }
  }
});

test('initial document is strictly validated, copied and persisted without breaking legacy tasks', async () => {
  const f = await fixture({ next: async () => finish });
  try {
    const task = { ...input('a'), initialDocument: { url: 'https://example.test/', revision: 1 } };
    const ids = await f.runtime.startBatch([task]);
    task.initialDocument.revision = 999;
    await until(() => !f.runtime.snapshot().activeJobId);
    assert.equal(f.runtime.snapshot().jobs.find(j => j.id === ids[0])!.status, 'completed');
    assert.deepEqual((await f.store.load()).jobs[0]!.initialDocument, { url: 'https://example.test/', revision: 1 });
    const before = f.runtime.snapshot();
    for (const initialDocument of [undefined, null, {}, { url: 'https://example.test/', revision: 1, extra: true }, { url: 4, revision: 1 }, { url: '', revision: 1 }, { url: 'https://example.test/', revision: -1 }, { url: 'https://example.test/', revision: 1.5 }, { url: 'https://example.test/', revision: Infinity }, { url: 'https://example.test/', revision: NaN }, { url: 'https://example.test/', revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(f.runtime.startBatch([input('valid'), { ...input('invalid'), initialDocument } as unknown as TaskInput]));
      assert.deepEqual(f.runtime.snapshot(), before);
    }
    const legacy = await f.runtime.start(input('legacy'));
    await until(() => f.runtime.snapshot().jobs.find(j => j.id === legacy)?.status === 'completed');
  } finally { await f.close(); }
});

test('batch initialization failure rolls back only new members before any browser or planner work', async () => {
  for (const failure of ['notification', 'storage']) {
    let rejectStartup = false;
    let plans = 0;
    const notifications: CoreSnapshot[] = [];
    const f = await fixture({ next: async () => { plans++; return new Promise<PlanStep>(() => undefined); } }, { onChange: state => {
      notifications.push(state);
      if (rejectStartup && state.jobs.length > 1) { rejectStartup = false; throw new Error('startup notification failed'); }
    } });
    try {
      const existing = await f.runtime.start(input('existing'));
      await until(() => plans === 1);
      const reads = f.reads.length;
      if (failure === 'notification') rejectStartup = true;
      else f.store.save = async () => { throw new Error('private storage path'); };
      await assert.rejects(f.runtime.startBatch([input('a'), input('b')]));
      assert.deepEqual(f.runtime.snapshot().jobs.map(j => j.id), [existing]);
      assert.equal(plans, 1);
      assert.equal(f.reads.length, reads);
      assert.deepEqual(notifications.at(-1)!.jobs.map(j => j.id), [existing]);
      if (failure === 'notification') {
        assert.equal(f.runtime.snapshot().jobs[0]!.status, 'running');
        assert.deepEqual((await f.store.load()).jobs.map(j => j.id), [existing]);
        await f.runtime.startBatch([input('a')]);
      } else {
        assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
        assert.equal(f.runtime.snapshot().activeJobId, null);
        await assert.rejects(f.runtime.startBatch([input('later')]), /closed/);
        assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('private storage path'));
      }
    } finally { await f.close(); }
  }
});

test('independent batch preregisters distinct prompts and progresses without peer rendezvous', async () => {
  const stalled = deferred<PlanStep>();
  const seen: { prompt: string; jobs: number; sync: boolean | undefined; signal: AbortSignal }[] = [];
  const counts = new Map<string, number>();
  const f = await fixture({ next: async request => {
    seen.push({ prompt: request.prompt, jobs: f.runtime.snapshot().activeJobIds!.length, sync: request.synchronizeFirstScroll, signal: request.signal });
    const n = (counts.get(request.observation.tabId) ?? 0) + 1; counts.set(request.observation.tabId, n);
    return request.observation.tabId === 'b' ? stalled.promise : n === 1 ? scroll : finish;
  } });
  try {
    const ids = await f.runtime.startBatch([input('a'), input('b')]);
    assert.equal(ids.length, 2);
    await until(() => f.runtime.snapshot().jobs.find(j => j.id === ids[0])?.status === 'completed');
    assert.deepEqual(new Set(seen.map(s => s.prompt)), new Set(['Read a', 'Read b']));
    assert.ok(seen.slice(0, 2).every(s => s.jobs === 2 && s.sync === undefined));
    assert.deepEqual(f.calls.map(c => c.tabId), ['a']);
    assert.equal(f.calls[0]!.smoothScroll, undefined);
    assert.ok(f.runtime.snapshot().jobs.every(j => j.synchronizedScroll === undefined));
    assert.equal(f.runtime.snapshot().jobs.find(j => j.id === ids[1])!.status, 'running');
    assert.notEqual(seen[0]!.signal, seen[1]!.signal);
    await f.runtime.cancel(ids[1]!);
    stalled.resolve(finish);
    assert.equal(f.runtime.snapshot().jobs.find(j => j.id === ids[1])!.status, 'cancelled');
  } finally { stalled.resolve(finish); await f.close(); }
});
