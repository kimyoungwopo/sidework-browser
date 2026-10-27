import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserPort, Observation, Planner, CoreSnapshot, BrowserAction } from '../src/contract.ts';

const observation: Observation = { profileId: 'p', tabId: 't', revision: 1, url: 'https://example.test/', title: 'Test', text: 'Public text', elements: [{ ref: 'r', tag: 'button', role: 'button', name: 'Go', inputType: '', sensitive: false }], capturedAt: 'now' };
async function fixture(planner: Planner, browser?: BrowserPort) {
  const root = await mkdtemp(join(tmpdir(), 'sidework-runtime-'));
  const { AgentRuntime } = await import('../src/core/runtime.ts');
  const calls: BrowserAction[] = [];
  const port: BrowserPort = browser ?? { observe: async () => structuredClone(observation), execute: async (action) => { calls.push(action); return { context: { profileId: 'p', tabId: 't' }, message: 'Done' }; } };
  const runtime = new AgentRuntime({ store: new RuntimeStore(root), browser: port, planner, onChange: () => undefined });
  await runtime.initialize();
  return { runtime, calls, root, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function until(read: () => CoreSnapshot, predicate: (state: CoreSnapshot) => boolean) {
  for (let i = 0; i < 200; i++) { const state = read(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Runtime did not reach expected state');
}
const start = { prompt: 'Read this page', profileId: 'p', tabId: 't' };

test('main-stamped task epoch survives creation and observations carry exact job identity',async()=>{
 const options:Parameters<BrowserPort['observe']>[1][]=[];
 const f=await fixture({next:async()=>({thought:'done',action:{type:'finish',text:'done'}})},{observe:async(_context,scope)=>{options.push(scope);return structuredClone(observation);},execute:async()=>{throw new Error('not used');}});
 try{
  const id=await f.runtime.start({...start,executionEpoch:3});const done=await until(()=>f.runtime.snapshot(),s=>s.activeJobId===null);
  assert.equal(done.jobs[0]!.executionEpoch,3);assert.equal(done.jobs[0]!.status,'completed');assert(options.length>0);assert(options.every(scope=>scope?.jobId===id));
  for(const executionEpoch of [-1,0.5,Number.NaN,Number.MAX_SAFE_INTEGER+1])await assert.rejects(f.runtime.start({...start,executionEpoch}));
 }finally{await f.close();}
});

test('runtime rejects malformed planner actions including extra keys before execution', async () => {
  const invalid: unknown[] = [
    { thought: 'Bad', action: { type: 'finish', text: 'x', script: 'evil' } },
    { thought: 'Bad', action: { type: 'navigate', url: 'javascript:alert(1)' } },
    { thought: 'Bad', action: { type: 'finish', text: 42 } },
    { thought: 'Bad', action: { type: 'scroll', direction: 'sideways' } },
    { thought: 'Bad', action: { type: 'click', ref: 'r' }, extra: true },
  ];
  for (const plan of invalid) {
    const f = await fixture({ next: async () => plan as Awaited<ReturnType<Planner['next']>> });
    try {
      await f.runtime.start(start);
      const state = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
      assert.equal(state.jobs[0]!.status, 'failed');
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('guard binds each mutation to one digest/revision approval and observes the result', async () => {
  let plans = 0;
  const f = await fixture({ next: async () => ++plans <= 2 ? { thought: 'Click Go', action: { type: 'click', ref: 'r' } } : { thought: 'Finished', action: { type: 'finish', text: 'Done after two clicks' } } });
  try {
    const id = await f.runtime.start(start);
    const state = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.status === 'awaiting_approval');
    const approval = state.jobs[0]!.approval!;
    assert.match(approval.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(approval.context, { profileId: 'p', tabId: 't' });
    assert.equal(approval.revision, 1);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.runtime.approve({ jobId: id, approvalId: 'wrong', allow: true }));
    await f.runtime.approve({ jobId: id, approvalId: approval.id, allow: true });
    const next = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null && s.jobs[0]?.approval?.id !== approval.id);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.runtime.approve({ jobId: id, approvalId: approval.id, allow: true }));
    await f.runtime.approve({ jobId: id, approvalId: next.jobs[0]!.approval!.id, allow: true });
    const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(done.jobs[0]!.status, 'completed');
    assert.equal(f.calls.length, 2);
    assert.equal(done.jobs[0]!.steps, 3);
    assert.ok(done.jobs[0]!.events.some(event => event.kind === 'observation'));
  } finally { await f.close(); }
});

test('approval rejects changed revision, URL, target, profile, expiry and denial without executing', async (t) => {
  for (const change of ['revision', 'url', 'target', 'profile', 'expiry', 'deny']) {
    const current = structuredClone(observation);
    let executions = 0;
    const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) }, {
      observe: async () => structuredClone(current),
      execute: async () => { executions++; return { context: { profileId: 'p', tabId: 't' }, message: 'Done' }; },
    });
    try {
      const id = await f.runtime.start(start);
      const state = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.status === 'awaiting_approval');
      const approval = state.jobs[0]!.approval!;
      if (change === 'revision') current.revision++;
      if (change === 'url') current.url = 'https://different.test/';
      if (change === 'target') current.elements[0]!.name = 'Different button';
      if (change === 'profile') current.profileId = 'other';
      if (change === 'expiry') t.mock.method(Date, 'now', () => Date.parse(approval.expiresAt) + 1);
      if (change === 'deny') await f.runtime.approve({ jobId: id, approvalId: approval.id, allow: false });
      else await assert.rejects(f.runtime.approve({ jobId: id, approvalId: approval.id, allow: true }), /approval|context|expired|target/i);
      const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
      assert.equal(done.jobs[0]!.status, 'failed');
      assert.equal(executions, 0);
    } finally { t.mock.restoreAll(); await f.close(); }
  }
});

test('settings persist safely, read-only blocks mutations, and memory is opt-in per planner call', async () => {
  const seen: string[][] = [];
  const f = await fixture({ next: async input => { seen.push(input.memory.map(entry => entry.text)); return { thought: 'Try click', action: { type: 'click', ref: 'r' } }; } });
  try {
    await f.runtime.addMemory('User-approved note');
    await f.runtime.updateSettings({ permissionMode: 'read-only', maxSteps: 2 });
    for (const enabled of [false, true, false]) {
      await f.runtime.updateSettings({ memoryEnabled: enabled });
      await f.runtime.start(start);
      const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
      assert.equal(done.jobs[0]!.status, 'failed');
      assert.equal(done.jobs[0]!.approval, null);
    }
    assert.deepEqual(seen, [[], ['User-approved note'], []]);
    assert.equal(f.calls.length, 0);
    for (const patch of [{ maxSteps: 0 }, { maxSteps: 21 }, { maxSteps: 1.2 }, { confirmMutations: false }, { provider: 'other' }, { unknown: true }]) {
      await assert.rejects(f.runtime.updateSettings(patch as Parameters<typeof f.runtime.updateSettings>[0]));
    }
    assert.equal(f.runtime.snapshot().settings.confirmMutations, true);
    const entry = f.runtime.snapshot().memory[0]!;
    await f.runtime.removeMemory(entry.id);
    assert.deepEqual((await new RuntimeStore(f.root).load()).memory, []);
    assert.equal((await new RuntimeStore(f.root).load()).settings.permissionMode, 'read-only');
  } finally { await f.close(); }
});

test('cancel aborts planner promptly and late model completion cannot replace terminal state', async () => {
  let release: ((value: { thought: string; action: { type: 'finish'; text: string } }) => void) | undefined;
  let signal: AbortSignal | undefined;
  const f = await fixture({ next: async input => { signal = input.signal; return new Promise(resolve => { release = resolve; }); } });
  try {
    const id = await f.runtime.start(start);
    await until(() => f.runtime.snapshot(), () => signal !== undefined);
    await f.runtime.cancel(id);
    assert.equal(signal!.aborted, true);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'cancelled');
    release!({ thought: 'Late', action: { type: 'finish', text: 'Must not win' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.runtime.snapshot().jobs[0]!.answer, null);
    assert.equal(f.runtime.snapshot().activeJobId, null);
  } finally { release?.({ thought: 'Cleanup', action: { type: 'finish', text: 'Cleanup' } }); await f.close(); }
});

test('cancellation unblocks approval and never executes its action', async () => {
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) });
  try {
    const id = await f.runtime.start(start);
    const waiting = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    await f.runtime.cancel(id);
    await assert.rejects(f.runtime.approve({ jobId: id, approvalId: waiting.jobs[0]!.approval!.id, allow: true }));
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'cancelled');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('mutation execution or post-observation failure is unknown and never retried', async () => {
  for (const stage of ['execute', 'after']) {
    let executions = 0;
    let plans = 0;
    const f = await fixture({ next: async () => { plans++; return { thought: 'Click', action: { type: 'click', ref: 'r' } }; } }, {
      observe: async () => { if (stage === 'after' && executions) throw new Error('secret transport error'); return structuredClone(observation); },
      execute: async () => { executions++; if (stage === 'execute') throw new Error('secret transport error'); return { context: { profileId: 'p', tabId: 't' }, message: 'done' }; },
    });
    try {
      const id = await f.runtime.start(start);
      const state = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
      await f.runtime.approve({ jobId: id, approvalId: state.jobs[0]!.approval!.id, allow: true });
      const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
      assert.equal(done.jobs[0]!.status, 'unknown');
      assert.equal(executions, 1);
      assert.equal(plans, 1);
      assert.ok(!JSON.stringify(done).includes('secret transport error'));
    } finally { await f.close(); }
  }
});

test('cancelling during mutation records unknown and ignores late browser completion', async () => {
  let release: (() => void) | undefined;
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) }, {
    observe: async () => structuredClone(observation),
    execute: async () => { await new Promise<void>(resolve => { release = resolve; }); return { context: { profileId: 'p', tabId: 't' }, message: 'late' }; },
  });
  try {
    const id = await f.runtime.start(start);
    const pending = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    await f.runtime.approve({ jobId: id, approvalId: pending.jobs[0]!.approval!.id, allow: true });
    await until(() => f.runtime.snapshot(), () => release !== undefined);
    const cancelling = f.runtime.cancel(id);
    // Release only after a bounded wait, so an unabortable implementation fails instead of hanging.
    const timeout = setTimeout(() => release?.(), 100);
    await cancelling;
    clearTimeout(timeout);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'unknown');
    release!();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'unknown');
  } finally { release?.(); await f.close(); }
});

test('restart interrupts all unfinished jobs, clears approvals and never auto-resumes', async () => {
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) });
  try {
    const id = await f.runtime.start(start);
    const persisted = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    await f.runtime.cancel(id);
    persisted.jobs = ['queued', 'running', 'awaiting_approval'].map((status, index) => ({ ...structuredClone(persisted.jobs[0]!), id: `recover-${index}`, status: status as 'queued' | 'running' | 'awaiting_approval' }));
    await new RuntimeStore(f.root).save(persisted);
    const { AgentRuntime } = await import('../src/core/runtime.ts');
    const recovered = new AgentRuntime({ store: new RuntimeStore(f.root), planner: { next: async () => { assert.fail('No auto-resume'); } }, browser: { observe: async () => { assert.fail('No browser access during recovery'); }, execute: async () => { assert.fail('No execution'); } }, onChange: () => undefined });
    await recovered.initialize();
    assert.equal(recovered.snapshot().activeJobId, null);
    assert.ok(recovered.snapshot().jobs.every(job => job.status === 'interrupted' && job.approval === null && job.answer === null));
    assert.deepEqual(await new RuntimeStore(f.root).load(), recovered.snapshot());
    await recovered.shutdown();
  } finally { await f.close(); }
});

test('event logs are bounded and sanitized, including fill values echoed in thought/observation', async () => {
  let plans = 0;
  const secret = 'never-log-this-value';
  const f = await fixture({ next: async () => ++plans === 1 ? { thought: `Fill ${secret} token=supersecret\u001b[31m ${'x'.repeat(4000)}`, action: { type: 'fill', ref: 'r', value: secret } } : { thought: 'Done', action: { type: 'finish', text: 'Finished' } } }, {
    observe: async () => ({ ...structuredClone(observation), text: `${secret} password=hunter2 ${'z'.repeat(5000)}` }),
    execute: async () => ({ context: { profileId: 'p', tabId: 't' }, message: secret }),
  });
  try {
    const id = await f.runtime.start(start);
    const waiting = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    assert.ok(!waiting.jobs[0]!.approval!.summary.includes(secret));
    await f.runtime.approve({ jobId: id, approvalId: waiting.jobs[0]!.approval!.id, allow: true });
    const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    const events = done.jobs[0]!.events;
    assert.ok(events.every(event => event.text.length <= 1000));
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.ok(!JSON.stringify(events).includes('supersecret'));
    assert.ok(!JSON.stringify(events).includes('hunter2'));
    assert.ok(events.every(event => !event.text.includes('\u001b')));
  } finally { await f.close(); }
});

test('pending approval automatically expires without user interaction', async t => {
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await f.runtime.start(start);
    for (let i = 0; i < 1000 && !f.runtime.snapshot().jobs[0]?.approval; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'awaiting_approval');
    t.mock.timers.tick(60_001);
    for (let i = 0; i < 1000 && f.runtime.snapshot().activeJobId !== null; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
    assert.equal(f.runtime.snapshot().jobs[0]!.approval, null);
    assert.equal(f.calls.length, 0);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('read actions obey step limit, retain screenshots and fail safely on execution error', async () => {
  let calls = 0;
  const artifact = { id: 'shot', kind: 'screenshot' as const, name: 'Page', path: 'jobs/test/artifacts/page.png', createdAt: 'now' };
  const f = await fixture({ next: async () => ({ thought: 'Capture', action: { type: 'screenshot' } }) }, {
    observe: async () => structuredClone(observation),
    execute: async () => { calls++; return { context: { profileId: 'p', tabId: 't' }, message: 'Captured', artifact }; },
  });
  try {
    await f.runtime.updateSettings({ maxSteps: 2, permissionMode: 'read-only' });
    await f.runtime.start(start);
    const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(done.jobs[0]!.status, 'failed');
    assert.equal(done.jobs[0]!.steps, 2);
    assert.equal(calls, 2);
    assert.equal(done.jobs[0]!.artifacts.length, 2);
    assert.equal(done.jobs[0]!.answer, null);
  } finally { await f.close(); }
  const broken = await fixture({ next: async () => ({ thought: 'Read scroll', action: { type: 'scroll', direction: 'down' } }) }, {
    observe: async () => structuredClone(observation), execute: async () => { throw new Error('sensitive internal path /Users/private'); },
  });
  try {
    await broken.runtime.start(start);
    const done = await until(() => broken.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(done.jobs[0]!.status, 'failed');
    assert.ok(!JSON.stringify(done).includes('/Users/private'));
  } finally { await broken.close(); }
});

test('switching to read-only while approval is pending cannot execute a mutation', async () => {
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) });
  try {
    const id = await f.runtime.start(start);
    const waiting = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    await f.runtime.updateSettings({ permissionMode: 'read-only' });
    await assert.rejects(f.runtime.approve({ jobId: id, approvalId: waiting.jobs[0]!.approval!.id, allow: true }));
    await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('cancel unblocks an approval being revalidated against a stalled browser', async () => {
  let reads = 0;
  let release: ((value: Observation) => void) | undefined;
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) }, {
    observe: async () => ++reads === 2 ? new Promise(resolve => { release = resolve; }) : structuredClone(observation),
    execute: async () => { assert.fail('Cancelled mutation must not execute'); },
  });
  try {
    const id = await f.runtime.start(start);
    const waiting = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    const approving = f.runtime.approve({ jobId: id, approvalId: waiting.jobs[0]!.approval!.id, allow: true });
    const handledApproval = approving.catch(() => undefined);
    await until(() => f.runtime.snapshot(), () => release !== undefined);
    const timeout = setTimeout(() => release?.(structuredClone(observation)), 100);
    await f.runtime.cancel(id);
    clearTimeout(timeout);
    release?.(structuredClone(observation));
    await handledApproval;
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'cancelled');
    await assert.rejects(approving);
  } finally { release?.(structuredClone(observation)); await f.close(); }
});

test('runtime refuses wrong-context observations and sensitive or missing fill targets before approval', async () => {
  for (const scenario of ['wrong-context', 'sensitive', 'missing']) {
    const current = structuredClone(observation);
    if (scenario === 'wrong-context') current.tabId = 'other';
    if (scenario === 'sensitive') current.elements[0]!.sensitive = true;
    if (scenario === 'missing') current.elements = [];
    const f = await fixture({ next: async () => ({ thought: 'Fill', action: { type: 'fill', ref: 'r', value: 'private-value' } }) }, {
      observe: async () => current,
      execute: async () => { assert.fail('Unsafe target must not execute'); },
    });
    try {
      await f.runtime.start(start);
      const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
      assert.equal(done.jobs[0]!.status, 'failed');
      assert.equal(done.jobs[0]!.approval, null);
    } finally { await f.close(); }
  }
});

test('runtime validates start input before adding a job and cannot restart after shutdown', async () => {
  const f = await fixture({ next: async () => ({ thought: 'Done', action: { type: 'finish', text: 'Done' } }) });
  try {
    for (const input of [{ ...start, prompt: '' }, { ...start, profileId: '' }, { ...start, tabId: '' }, { ...start, prompt: 'x'.repeat(16001) }]) await assert.rejects(f.runtime.start(input));
    assert.equal(f.runtime.snapshot().jobs.length, 0);
    await f.runtime.shutdown();
    await assert.rejects(f.runtime.start(start), /closed|shutdown/i);
  } finally { await f.close(); }
});

test('approval expiry is checked again immediately before execution', async t => {
  let reads = 0;
  let executions = 0;
  let expiresAt = 0;
  const f = await fixture({ next: async () => ({ thought: 'Click', action: { type: 'click', ref: 'r' } }) }, {
    observe: async () => { if (++reads === 3) t.mock.method(Date, 'now', () => expiresAt + 1); return structuredClone(observation); },
    execute: async () => { executions++; return { context: { profileId: 'p', tabId: 't' }, message: 'done' }; },
  });
  try {
    const id = await f.runtime.start(start);
    const waiting = await until(() => f.runtime.snapshot(), s => s.jobs[0]?.approval !== null);
    expiresAt = Date.parse(waiting.jobs[0]!.approval!.expiresAt);
    await f.runtime.approve({ jobId: id, approvalId: waiting.jobs[0]!.approval!.id, allow: true });
    const done = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(executions, 0);
    assert.equal(done.jobs[0]!.status, 'failed');
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('failed initial persistence stops execution, clears busy state and returns a user-safe error', async () => {
  let plans = 0;
  const f = await fixture({ next: async () => { plans++; return { thought: 'Done', action: { type: 'finish', text: 'Done' } }; } });
  try {
    await rm(f.root, { recursive: true });
    await writeFile(f.root, 'block directory writes');
    await assert.rejects(f.runtime.start(start), error => error instanceof Error && !error.message.includes(f.root));
    assert.equal(plans, 0);
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
  } finally { await f.close(); }
});

test('terminal persistence failure is contained and cannot leave a success claim or unhandled rejection', async () => {
  let release: ((value: { thought: string; action: { type: 'finish'; text: string } }) => void) | undefined;
  const f = await fixture({ next: async () => new Promise(resolve => { release = resolve; }) });
  try {
    await f.runtime.start(start);
    await until(() => f.runtime.snapshot(), () => release !== undefined);
    await rm(f.root, { recursive: true });
    await writeFile(f.root, 'block directory writes');
    release!({ thought: 'Done', action: { type: 'finish', text: 'Cannot persist this' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.runtime.snapshot().jobs[0]!.status, 'failed');
    assert.equal(f.runtime.snapshot().jobs[0]!.answer, null);
    assert.equal(f.runtime.snapshot().activeJobId, null);
    assert.ok(!f.runtime.snapshot().jobs[0]!.error!.includes(f.root));
    await assert.rejects(f.runtime.start(start), /closed/i);
  } finally { await f.close(); }
});

test('runtime returns a job ID without waiting, enforces busy gate and finishes explicitly', async () => {
  let resolvePlan: ((value: { thought: string; action: { type: 'finish'; text: string } }) => void) | undefined;
  const f = await fixture({ next: () => new Promise(resolve => { resolvePlan = resolve; }) });
  try {
    const id = await f.runtime.start(start);
    await until(() => f.runtime.snapshot(), () => resolvePlan !== undefined);
    await assert.rejects(f.runtime.start(start), /busy/i);
    assert.equal(f.runtime.snapshot().jobs.length, 1);
    resolvePlan!({ thought: 'Read page', action: { type: 'finish', text: 'Observed answer' } });
    const state = await until(() => f.runtime.snapshot(), s => s.activeJobId === null);
    assert.equal(state.jobs[0]!.id, id);
    assert.equal(state.jobs[0]!.answer, 'Observed answer');
    assert.equal(state.jobs[0]!.error, null);
    state.jobs[0]!.answer = 'tampered';
    assert.equal(f.runtime.snapshot().jobs[0]!.answer, 'Observed answer');
  } finally { await f.close(); }
});
