import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexPlanner, createPlannerProcessRunner } from '../src/provider/codex.ts';
import { DEFAULT_SETTINGS } from '../src/contract.ts';
import type { PlannerInput } from '../src/contract.ts';
import type { GoalPlan, GoalPlannerInput } from '../src/goal-contract.ts';
const browser = { title: 'Research', prompt: 'Read sources and cite actual findings', url: 'https://example.com/search?q=design', allowedOrigins: ['https://example.com'], blocker: null };
const blocked = { title: 'Generate image', prompt: 'Generate an original image', url: null, allowedOrigins: [], blocker: 'No image generation capability is available.' };
const plan: GoalPlan = { title: 'Research and illustration', tasks: [browser, blocked] };
const events = (value: unknown) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } });
const input = (): GoalPlannerInput => ({ prompt: 'Research a topic and generate an illustration', settings: { ...DEFAULT_SETTINGS }, signal: new AbortController().signal });
const module = () => import('../src/provider/goal-plan.ts');

test('strict parser preserves independent browser research and explicit unsupported-tool blocker', async () => {
  const { parseGoalPlanOutput } = await module();
  assert.deepEqual(parseGoalPlanOutput(JSON.stringify(plan)), plan);
});
test('strict plan shape rejects unknown, missing, empty and oversized fields', async () => {
  const { parseGoalPlanOutput: parse } = await module();
  const bad = [null, [], {}, { ...plan, answer: 'invented' }, { ...plan, tasks: [] }, { ...plan, tasks: Array(5).fill(browser) }, { ...plan, title: '' }, { ...plan, title: 'x'.repeat(201) }, { ...plan, tasks: [{ ...browser, extra: true }] }, { ...plan, tasks: [{ ...browser, prompt: '' }] }, { ...plan, tasks: [{ ...browser, prompt: 'x'.repeat(8001) }] }, { ...plan, tasks: [{ ...browser, url: 'https://example.com/' + 'x'.repeat(4096) }] }, { ...plan, tasks: [{ ...browser, blocker: 'x' }] }, { ...plan, tasks: [{ ...blocked, blocker: '' }] }, { ...plan, tasks: [{ ...blocked, allowedOrigins: ['https://example.com'] }] }, { ...plan, tasks: [{ ...blocked, blocker: 'x'.repeat(2001) }] }];
  for (const value of bad) assert.throws(() => parse(JSON.stringify(value)), JSON.stringify(value).slice(0, 180));
  assert.throws(() => parse('```json\n{}\n```'));
});
test('parser rejects unsafe public URL hostnames, credentials, controls and sensitive query', async () => {
  const { validateGoalURL } = await module();
  const urls = ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/', 'http://a.localhost/', 'http://x.local/', 'http://x.internal/', 'http://x.lan/', 'http://intranet/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'https://user:pass@example.com/', 'https://example.com/\npath', 'https://example.com/%0a', 'https://example.com/?access_token=secret', 'https://example.com/?API-Key=x', 'https://example.com/#password=x'];
  for (const url of urls) assert.throws(() => validateGoalURL(url), url);
});
test('starting URLs reject consequential GET endpoints, including encoded paths', async () => {
  const { parseGoalPlanOutput: parse } = await module();
  for (const path of ['/delete?id=123', '/api/remove-item?id=2', '/account/logout', '/pay', '/checkout', '/orders/submit', '/%64elete', '/%2564elete', '/?action=delete']) {
    assert.throws(() => parse(JSON.stringify({ title: 'Unsafe', tasks: [{ ...browser, url: 'https://example.com' + path }] })), path);
  }
  assert.equal(parse(JSON.stringify({ title: 'Read', tasks: [{ ...browser, url: 'https://example.com/docs/payment-security' }] })).tasks.length, 1);
});

test('origins are bounded exact public origins and include starting URL origin', async () => {
  const { parseGoalPlanOutput: parse } = await module();
  for (const allowedOrigins of [[], ['https://other.com'], ['https://example.com/'], ['https://example.com/path'], ['https://example.com?x=1'], ['https://EXAMPLE.com'], ['https://example.com', 'http://10.0.0.1'], Array(9).fill('https://example.com'), ['https://example.com', 'https://example.com']]) {
    assert.throws(() => parse(JSON.stringify({ ...plan, tasks: [{ ...browser, allowedOrigins }] })));
  }
  assert.deepEqual(parse(JSON.stringify({ ...plan, tasks: [{ ...browser, allowedOrigins: ['https://example.com', 'https://other.com:8443'] }] })).tasks[0].allowedOrigins, ['https://example.com', 'https://other.com:8443']);
});
test('goal schema is strict with bounded task variants and all required fields', async () => {
  const { GOAL_PLAN_SCHEMA: schema } = await module();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['title', 'tasks']);
  assert.equal(schema.properties.tasks.minItems, 1); assert.equal(schema.properties.tasks.maxItems, 4);
  for (const branch of schema.properties.tasks.items.anyOf) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(new Set(branch.required), new Set(['title', 'prompt', 'url', 'allowedOrigins', 'blocker']));
    assert.equal(branch.properties.allowedOrigins.maxItems <= 8, true);
  }
});
test('planGoal validates input before invoking model, without truncation or extra capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-input-')); let calls = 0;
  const planner = new CodexPlanner({ binary: 'fixture', workDir: dir, runner: async () => { calls++; return events(plan); } });
  try {
    for (const value of [{ ...input(), prompt: '' }, { ...input(), prompt: 'x'.repeat(8001) }, { ...input(), observation: {} }, { ...input(), settings: { ...DEFAULT_SETTINGS, provider: 'other' } }, { ...input(), settings: { ...DEFAULT_SETTINGS, confirmMutations: false } }]) await assert.rejects(() => planner.planGoal(value as GoalPlannerInput));
    assert.equal(calls, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('planGoal uses isolated no-tools flags and actual schema response, not keyword splitting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-cli-')); let verified = 0; let requestDir = '';
  const planner = new CodexPlanner({ binary: 'fixture', workDir: dir, onLiveVerified: () => verified++, runner: async request => {
    requestDir = request.cwd;
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--output-schema', 'read-only', 'web_search="disabled"', 'approval_policy="never"', 'shell_tool', 'unified_exec', 'browser_use', 'plugins', 'hooks', 'image_generation', 'skip_host_skill_discovery']) assert(request.args.includes(flag), flag);
    assert(!request.args.includes('--image')); assert.equal(request.args.at(-1), '-');
    const schema = JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema') + 1]!, 'utf8'));
    assert.equal(schema.properties.tasks.maxItems, 4);
    assert.match(request.input, /genuinely distinct/i); assert.match(request.input, /image.*file.*blocked/i);
    assert.match(request.input, /independent browser.*continue/i); assert.match(request.input, /cannot approve/i);
    assert.match(request.input, /no.*filesystem.*media.*shell/i);
    assert(!request.input.includes('observation')); assert(request.input.includes('Unrelated opaque request'));
    return events(plan);
  } });
  try {
    assert.deepEqual(await planner.planGoal({ ...input(), prompt: 'Unrelated opaque request' }), plan);
    assert.equal(verified, 1); await assert.rejects(() => readdir(requestDir)); assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('invalid response, tool events and abort never mark provider live and always clean up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-reject-')); let verified = 0;
  try {
    for (const output of [events({ ...plan, tasks: [] }), JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'x' } }) + '\n' + events(plan)]) {
      const planner = new CodexPlanner({ binary: 'fixture', workDir: dir, onLiveVerified: () => verified++, runner: async () => output });
      await assert.rejects(() => planner.planGoal(input())); assert.deepEqual(await readdir(dir), []);
    }
    const controller = new AbortController();
    const planner = new CodexPlanner({ binary: 'fixture', workDir: dir, onLiveVerified: () => verified++, runner: async () => { controller.abort(); return events(plan); } });
    await assert.rejects(() => planner.planGoal({ ...input(), signal: controller.signal }));
    assert.equal(verified, 0); assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('goal and next share one gate; aborting a queued goal does not invoke runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-gate-')); let release!: () => void; let started!: () => void; let calls = 0; let queued!: () => void;
  const running = new Promise<void>(resolve => started = resolve); const waiting = new Promise<void>(resolve => queued = resolve);
  const planner = new CodexPlanner({ binary: 'fixture', workDir: dir, maxProcesses: 1, onActivity: activity => { if (activity.waiting) queued(); }, runner: async () => { calls++; started(); await new Promise<void>(resolve => release = resolve); return events({ thought: 'done', action: { type: 'finish', text: 'done' } }); } });
  const next: PlannerInput = { ...input(), observation: { profileId: 'p', tabId: 't', revision: 1, url: 'https://example.com', title: '', text: '', elements: [], capturedAt: '' }, history: [], memory: [] };
  try {
    const first = planner.next(next); await running;
    const controller = new AbortController(); const second = planner.planGoal({ ...input(), signal: controller.signal });
    await waiting; controller.abort(); await assert.rejects(second); assert.equal(calls, 1);
    release(); await first; assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('goal abort uses existing real process cleanup and releases request directory after close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-abort-')); const controller = new AbortController();
  const runner = createPlannerProcessRunner({ killGraceMs: 50 }); let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const planner = new CodexPlanner({ binary: process.execPath, workDir: dir, runner: request => {
    const result = runner({ ...request, args: ['-e', 'setInterval(()=>{},1000)'] }); started(); return result;
  } });
  try { const pending = planner.planGoal({ ...input(), signal: controller.signal }); await ready; controller.abort(); await assert.rejects(pending, /취소/); assert.deepEqual(await readdir(dir), []); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
