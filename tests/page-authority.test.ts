import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserContext, BrowserState, BrowserTab, Job, TaskInput } from '../src/contract.js';
import { PageAuthority } from '../src/desktop/page-authority.js';

const a: BrowserContext = { profileId: 'p', tabId: 'a' };
const b: BrowserContext = { profileId: 'p', tabId: 'b' };
const input = (context = a): TaskInput => ({ ...context, prompt: 'work', initialDocument: { url: 'https://example.test', revision: 1 } });
const tab = (context: BrowserContext, ownership: BrowserTab['ownership'] = 'agent'): BrowserTab => ({ id: context.tabId, profileId: context.profileId, title: '', url: 'https://example.test', isLoading: false, canGoBack: false, canGoForward: false, ownership, revision: 1 });
const state = (): BrowserState => ({ profiles: [{ id: 'p', name: 'P', incognito: false }], activeProfileId: 'p', activeTabId: 'a', tabs: [tab(a), tab(b)], paneTabIds: ['a', 'b'] });
function job(authority: PageAuthority, id = 'j', context = a, patch: Partial<Job> = {}): Job {
  return { ...authority.bindInput(input(context)), id, status: 'running', createdAt: '', updatedAt: '', events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0, ...patch };
}

test('takeover accepts an explicitly hosted agent page and revokes only its task',()=>{
 const authority=new PageAuthority(),first=job(authority,'first'),peer=job(authority,'peer',b);
 const hosted={...state(),activeTabId:'b',paneTabIds:['b'],agentPaneTabIds:['a'],tabs:[{...tab(a,'user'),agentAreaId:'area-a'},tab(b)]};
 authority.assertRequest([first,peer],a,'first','execute');
 const receipt=authority.takeControl(hosted,[first,peer],a);
 assert.deepEqual(receipt.jobIds,['first']);
 assert.throws(()=>authority.assertRequest([first,peer],a,'first','observe'));
 authority.assertRequest([first,peer],b,'peer','execute');
});

test('bindInput stamps epoch zero and deeply clones input without mutating it', () => {
  const authority = new PageAuthority();
  const source = input();
  const bound = authority.bindInput(source);
  assert.equal(bound.executionEpoch, 0);
  assert.notEqual(bound, source);
  assert.notEqual(bound.initialDocument, source.initialDocument);
  assert.equal(source.executionEpoch, undefined);
});

test('request authority requires one active matching identity, valid epoch and allowed origin', () => {
  const authority = new PageAuthority();
  const running = job(authority);
  authority.assertRequest([running], a, 'j', 'execute');
  authority.assertRequest([{ ...running, status: 'awaiting_approval' }], a, 'j', 'observe');
  for (const status of ['queued', 'completed', 'cancelled', 'failed', 'interrupted', 'unknown'] as const) {
    assert.throws(() => authority.assertRequest([{ ...running, status }], a, 'j', 'observe'));
  }
  assert.throws(() => authority.assertRequest([{ ...running, status: 'awaiting_approval' }], a, 'j', 'execute'));
  assert.throws(() => authority.assertRequest([running], a, '', 'observe'));
  assert.throws(() => authority.assertRequest([running], a, 'missing', 'observe'));
  assert.throws(() => authority.assertRequest([running, running], a, 'j', 'observe'));
  assert.throws(() => authority.assertRequest([running], b, 'j', 'observe'));
  assert.throws(() => authority.assertRequest([running], { ...a, profileId: 'other' }, 'j', 'observe'));
  for (const executionEpoch of [undefined, -1, 0.5, NaN, Infinity, 1]) {
    assert.throws(() => authority.assertRequest([{ ...running, executionEpoch }], a, 'j', 'observe'));
  }
  assert.throws(() => authority.assertRequest([{ ...running, tabId: '' }], a, 'j', 'observe'));
  assert.throws(() => authority.bindInput(input({ profileId: '', tabId: 'a' })));
});

test('takeover synchronously revokes same-origin jobs once and rejects late unseen stale starts, not peers', () => {
  const authority = new PageAuthority();
  const first = job(authority, 'first');
  const second = job(authority, 'second');
  const peer = job(authority, 'peer', b);
  const late = job(authority, 'late');
  authority.assertRequest([first], a, 'first', 'observe');
  const taken = authority.takeControl(state(), [first, second, peer], a);
  assert.deepEqual(taken.jobIds, ['first', 'second']);
  assert.throws(() => authority.bindInput(input()));
  for (const stale of [first, second, late]) assert.throws(() => authority.assertRequest([stale], a, stale.id, 'observe'));
  authority.assertRequest([peer], b, 'peer', 'execute');
  authority.completeTakeControl(a, taken.generation, true);
  const fresh = job(authority, 'fresh');
  assert.equal(fresh.executionEpoch, 1);
  assert.throws(() => authority.assertRequest([late], a, 'late', 'execute'));
  authority.assertRequest([fresh], a, 'fresh', 'execute');
  const empty = new PageAuthority();
  const unseen = job(empty, 'unseen');
  empty.takeControl(state(), [], a);
  assert.throws(() => empty.assertRequest([unseen], a, unseen.id, 'observe'));
});

test('takeover validates active-profile visible owned pages before mutating authority', () => {
  const authority = new PageAuthority();
  const running = job(authority);
  const invalidStates: BrowserState[] = [
    { ...state(), activeProfileId: 'other' },
    { ...state(), tabs: [] },
    { ...state(), paneTabIds: ['b'] },
    { ...state(), tabs: [{...tab(a, 'user'),profileId:'other'}, tab(b)] },
    { ...state(), tabs: [{ ...tab(a), lifecycle: 'dormant' }] },
  ];
  for (const invalid of invalidStates) assert.throws(() => authority.takeControl(invalid, [running], a));
  authority.assertRequest([running], a, 'j', 'execute');
});

test('markers are generation-safe, cloned, extant/profile filtered and clear only on running fresh requests', () => {
  const authority = new PageAuthority();
  const first = authority.takeControl(state(), [], a);
  const second = authority.takeControl(state(), [], a);
  authority.completeTakeControl(a, first.generation, true);
  assert.equal(authority.getState(state())[0].state, 'reclaiming');
  authority.completeTakeControl(a, second.generation, false);
  assert.equal(authority.getState(state())[0].state, 'unknown');
  authority.completeTakeControl(a, second.generation, true);
  assert.equal(authority.getState(state())[0].state, 'unknown');
  const third = authority.takeControl(state(), [], a);
  authority.completeTakeControl(a, third.generation, true);
  const fresh = job(authority, 'fresh');
  const exposed = authority.getState(state());
  assert.deepEqual(exposed, [{ ...a, state: 'user' }]);
  exposed[0].tabId = 'corrupted';
  assert.equal(authority.getState(state())[0].tabId, 'a');
  assert.deepEqual(authority.getState({ ...state(), activeProfileId: 'other' }), []);
  assert.deepEqual(authority.getState({ ...state(), tabs: [] }), []);
  authority.assertRequest([{ ...fresh, status: 'awaiting_approval' }], a, 'fresh', 'observe');
  assert.equal(authority.getState(state())[0].state, 'user');
  authority.assertRequest([fresh], a, 'fresh', 'observe');
  assert.deepEqual(authority.getState(state()), []);
});

test('only registered owned DOM open_tab results extend pages; takeover revokes every bound origin once', () => {
  const authority = new PageAuthority();
  const first = job(authority, 'one');
  const second = job(authority, 'two');
  const peer = job(authority, 'peer', { profileId: 'p', tabId: 'c' });
  const action = { type: 'open_tab', url: 'https://example.test' } as const;
  const result = { context: b, message: 'opened' };
  authority.registerResult([first], a, first.id, { type: 'observe' }, { context: a, message: '' }, state());
  for (const running of [first, second]) {
    authority.registerResult([running], a, running.id, action, result, state());
    authority.assertRequest([running], b, running.id, 'execute');
  }
  const taken = authority.takeControl(state(), [first, second, peer], b);
  assert.deepEqual(taken.jobIds, ['one', 'two']);
  for (const running of [first, second]) {
    assert.throws(() => authority.assertRequest([running], a, running.id, 'observe'));
    assert.throws(() => authority.registerResult([running], b, running.id, action, result, state()));
  }
  assert.equal(authority.bindInput(input()).executionEpoch, 1);
  authority.assertRequest([peer], { profileId: 'p', tabId: 'c' }, peer.id, 'execute');
  authority.completeTakeControl(b, taken.generation, true);
  assert.equal(authority.bindInput(input(b)).executionEpoch, 1);
});

test('registerResult rejects computer open_tab, unowned/missing/foreign targets and arbitrary retargets without granting pages', () => {
  const authority = new PageAuthority();
  const running = job(authority);
  const action = { type: 'open_tab', url: 'https://example.test' } as const;
  const result = { context: b, message: '' };
  assert.throws(() => authority.registerResult([{ ...running, computerUse: true }], a, 'j', action, result, state()));
  assert.throws(() => authority.registerResult([{ ...running, computerUse: true }], a, 'j', action, { ...result, context: a }, state()));
  for (const invalid of [
    { ...state(), tabs: [tab(a), tab(b, 'user')] },
    { ...state(), tabs: [tab(a)] },
    { ...state(), activeProfileId: 'foreign' },
    { ...state(), tabs: [tab(a), { ...tab(b), lifecycle: 'dormant' as const }] },
  ]) assert.throws(() => authority.registerResult([running], a, 'j', action, result, invalid));
  assert.throws(() => authority.registerResult([running], a, 'j', { type: 'observe' }, result, state()));
  assert.throws(() => authority.registerResult([running], a, 'j', action, { ...result, context: { ...b, profileId: 'other' } }, state()));
  assert.throws(() => authority.assertRequest([running], b, 'j', 'observe'));
});
