import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import type { MainToWorker, WorkerToMain } from '../src/contract';
import { DEFAULT_SETTINGS } from '../src/contract';
import type { GoalPlan, GoalPlannerInput } from '../src/goal-contract';
import { GoalPlanning } from '../src/core/goal-planning';

const result: GoalPlan = { title: 'Research', tasks: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('plans from a prompt and settings without a browser observation', async () => {
  let input: GoalPlannerInput | undefined;
  const planning = new GoalPlanning({ planGoal: async value => { input = value; return result; } }, () => DEFAULT_SETTINGS);
  assert.deepEqual(await planning.plan('goal-a', 'Research browsers'), result);
  assert.equal(input?.prompt, 'Research browsers');
  assert.deepEqual(input?.settings, DEFAULT_SETTINGS);
  assert.equal(input?.signal.aborted, false);
  assert.equal('observation' in input!, false);
});

test('rejects invalid input, duplicate active IDs, and a third request without invoking the planner', async () => {
  const held = deferred<GoalPlan>();
  let calls = 0;
  const planning = new GoalPlanning({ planGoal: async input => { calls++; return ['A', 'B'].includes(input.prompt) ? held.promise : result; } }, () => DEFAULT_SETTINGS);
  for (const id of ['', ' ', null, undefined, 42, ' goal']) {
    await assert.rejects(planning.plan(id as string, 'Valid prompt'), /goal.*id/i);
  }
  for (const prompt of ['', ' ', null, undefined, 42]) {
    await assert.rejects(planning.plan('valid', prompt as string), /prompt/i);
  }
  const a = planning.plan('a', 'A');
  await assert.rejects(planning.plan('a', 'Duplicate'), /duplicate/i);
  const b = planning.plan('b', 'B');
  await assert.rejects(planning.plan('c', 'C'), /limit|concurrent/i);
  held.resolve(result);
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.deepEqual(await planning.plan('a', 'Retry'), result);
});

test('cancel aborts and drains only A while B finishes independently; late A is rejected', async () => {
  const a = deferred<GoalPlan>();
  const b = deferred<GoalPlan>();
  const inputs: GoalPlannerInput[] = [];
  const planning = new GoalPlanning({ planGoal: input => { inputs.push(input); return input.prompt === 'A' ? a.promise : b.promise; } }, () => DEFAULT_SETTINGS);
  const first = planning.plan('a', 'A');
  const rejected = assert.rejects(first, /cancel|abort/i);
  const second = planning.plan('b', 'B');
  await tick();
  await planning.cancel('unknown');
  assert.equal(inputs[0].signal.aborted, false);
  assert.equal(inputs[1].signal.aborted, false);
  let drained = false;
  const cancelled = planning.cancel('a').then(() => { drained = true; });
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(inputs[1].signal.aborted, false);
  await tick();
  assert.equal(drained, false);
  await assert.rejects(planning.plan('c', 'C'), /limit|concurrent/i);
  b.resolve(result);
  assert.deepEqual(await second, result);
  assert.equal(drained, false);
  a.resolve(result); // Deliberately uncooperative fake is explicitly released.
  await Promise.all([cancelled, rejected]);
  assert.equal(drained, true);
});

test('immediate cancellation prevents planner invocation', async () => {
  let calls = 0;
  const planning = new GoalPlanning({ planGoal: async () => { calls++; return result; } }, () => DEFAULT_SETTINGS);
  const pending = planning.plan('a', 'A');
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await planning.cancel('a');
  await rejected;
  assert.equal(calls, 0);
});

test('cancellation after model output arrives but before publication rejects the plan', async () => {
  const held = deferred<GoalPlan>();
  const planning = new GoalPlanning({ planGoal: () => held.promise }, () => DEFAULT_SETTINGS);
  const pending = planning.plan('a', 'A');
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await tick();
  held.resolve(result);
  await planning.cancel('a');
  await rejected;
});

test('cancellation at the publication microtask boundary cannot publish a late plan', async () => {
  const held = deferred<GoalPlan>();
  const planning = new GoalPlanning({ planGoal: () => held.promise }, () => DEFAULT_SETTINGS);
  const pending = planning.plan('a', 'A');
  await tick();
  held.resolve(result);
  // The provider continuation can run first; cancellation still owns an active ID.
  const cancelled = Promise.resolve().then(() => planning.cancel('a'));
  await assert.rejects(pending, /cancel|abort/i);
  await cancelled;
});

test('settings are cloned at admission before async model execution', async () => {
  const settings = { ...DEFAULT_SETTINGS, model: 'original' };
  const held = deferred<GoalPlan>();
  let captured: GoalPlannerInput | undefined;
  const planning = new GoalPlanning({ planGoal: input => { captured = input; return held.promise; } }, () => settings);
  const pending = planning.plan('a', 'A');
  settings.model = 'changed-before-start';
  await tick();
  settings.maxSteps = 99;
  assert.equal(captured?.settings.model, 'original');
  assert.equal(captured?.settings.maxSteps, DEFAULT_SETTINGS.maxSteps);
  assert.notEqual(captured?.settings, settings);
  held.resolve(result);
  await pending;
});

test('shutdown aborts all goals, drains cleanup, and permanently rejects admission', async () => {
  const held = [deferred<GoalPlan>(), deferred<GoalPlan>()];
  const inputs: GoalPlannerInput[] = [];
  const planning = new GoalPlanning({ planGoal: input => { inputs.push(input); return held[inputs.length - 1].promise; } }, () => DEFAULT_SETTINGS);
  const a = assert.rejects(planning.plan('a', 'A'), /cancel|abort/i);
  const b = assert.rejects(planning.plan('b', 'B'), /cancel|abort/i);
  await tick();
  let drained = false;
  const shutdown = planning.shutdown().then(() => { drained = true; });
  assert.ok(inputs.every(input => input.signal.aborted));
  await assert.rejects(planning.plan('c', 'C'), /shut|closed/i);
  await tick();
  assert.equal(drained, false);
  held[0].reject(new Error('Provider cleanup complete'));
  held[1].resolve(result);
  await Promise.all([a, b, shutdown]);
  assert.equal(drained, true);
  await planning.shutdown();
  await planning.cancel('unknown');
  await assert.rejects(planning.plan('d', 'D'), /shut|closed/i);
});

function workerHarness() {
  const sent: WorkerToMain[] = [];
  const port = Object.assign(new EventEmitter(), { postMessage: (message: WorkerToMain) => sent.push(message) });
  const inputs: GoalPlannerInput[] = [];
  const held = [deferred<GoalPlan>(), deferred<GoalPlan>()];
  const runtimeDrain = deferred<void>();
  let plannerCount = 0, runtimePlanner: unknown, runtimeShutdown = false, exits = 0, starts = 0;
  class FakePlanner {
    constructor() { plannerCount++; }
    planGoal(input: GoalPlannerInput) { inputs.push(input); return held[inputs.length - 1].promise; }
  }
  class FakeRuntime {
    constructor(options: { planner: unknown }) { runtimePlanner = options.planner; }
    async initialize() {}
    snapshot() { return { settings: DEFAULT_SETTINGS }; }
    async start() { starts++; return 'existing-job'; }
    async shutdown() { runtimeShutdown = true; await runtimeDrain.promise; }
  }
  const source = readFileSync(new URL('../src/bridge/worker.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, {
    exports: {}, process: { parentPort: port, exit: () => { exits++; } },
    require: (name: string) => {
      if (name === '../core/runtime') return { AgentRuntime: FakeRuntime };
      if (name === '../core/store') return { RuntimeStore: class {} };
      if (name === '../core/goal-planning') return { GoalPlanning };
      if (name === '../provider/codex') return { CodexPlanner: FakePlanner };
      if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') };
      if (name === 'node:crypto') return { randomUUID: () => 'request-id' };
      throw new Error(`Unexpected worker import: ${name}`);
    }, setTimeout, clearTimeout, structuredClone, console,
  });
  return { sent, inputs, held, runtimeDrain, send: (message: MainToWorker) => port.emit('message', { data: message }),
    state: () => ({ plannerCount, runtimePlanner, runtimeShutdown, exits, starts }) };
}

test('worker shares its planner, routes plan/cancel independently, and drains runtime plus planning on shutdown', async () => {
  const h = workerHarness();
  h.send({ kind: 'init', dataRoot: '/unused-fake', codexPath: null });
  await tick();
  assert.equal(h.state().plannerCount, 1);
  assert.ok(h.state().runtimePlanner);
  assert.ok(h.sent.some(message => message.kind === 'ready'));
  h.send({ kind: 'command', id: 'legacy', command: { type: 'start', input: { prompt: 'Legacy', profileId: 'p', tabId: 't' } } });
  h.send({ kind: 'command', id: 'plan-a', command: { type: 'goal.plan', goalId: 'a', prompt: 'A' } });
  h.send({ kind: 'command', id: 'plan-b', command: { type: 'goal.plan', goalId: 'b', prompt: 'B' } });
  await tick();
  assert.equal(h.inputs.length, 2);
  assert.equal(h.state().starts, 1);
  assert.equal(h.sent.some(message => message.kind === 'browser.request'), false);
  h.send({ kind: 'command', id: 'cancel-a', command: { type: 'goal.cancelPlan', goalId: 'a' } });
  await tick();
  assert.equal(h.inputs[0].signal.aborted, true);
  assert.equal(h.inputs[1].signal.aborted, false);
  assert.equal(h.sent.some(message => message.kind === 'response' && message.id === 'cancel-a'), false);
  h.held[0].resolve(result);
  await tick();
  assert.ok(h.sent.some(message => message.kind === 'response' && message.id === 'plan-a' && !message.ok));
  assert.ok(h.sent.some(message => message.kind === 'response' && message.id === 'cancel-a' && message.ok));
  h.send({ kind: 'shutdown' });
  assert.equal(h.inputs[1].signal.aborted, true);
  assert.equal(h.state().runtimeShutdown, true);
  h.runtimeDrain.resolve();
  await tick();
  assert.equal(h.state().exits, 0);
  h.held[1].resolve(result);
  await tick();
  assert.equal(h.state().exits, 1);
  assert.ok(h.sent.some(message => message.kind === 'response' && message.id === 'plan-b' && !message.ok));
});

test('worker shutdown before initialization exits cleanly', async () => {
  const h = workerHarness();
  h.send({ kind: 'shutdown' });
  await tick();
  assert.equal(h.state().exits, 1);
});
