import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, validateSnapshot } from '../src/core/validation.ts';
import { DEFAULT_SETTINGS } from '../src/contract.ts';

test('read_page validates only an exact host action with a safe integer screen budget of 1..8', () => {
  for (const maxScreens of [1, 4, 8]) {
    const plan = { thought: 'Read the long document', action: { type: 'read_page', maxScreens } };
    assert.deepEqual(validatePlan(plan), plan);
  }
  for (const maxScreens of [undefined, null, '2', NaN, Infinity, -Infinity, 0, -1, 9, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validatePlan({ thought: 'Read', action: { type: 'read_page', maxScreens } }));
  }
  for (const extra of [{ direction: 'down' }, { url: null }, { approved: true }, { ref: 'e1' }, { frameId: 'f' }]) {
    assert.throws(() => validatePlan({ thought: 'Read', action: { type: 'read_page', maxScreens: 2, ...extra } }));
  }
  assert.throws(() => validatePlan({ thought: 'Read', action: { type: 'read_page' } }));
});

test('host-only read_page is never restored as a pending browser approval', () => {
  const snapshot = {
    jobs: [{ id: 'j', prompt: 'Read', profileId: 'p', tabId: 't', status: 'awaiting_approval', createdAt: 'x', updatedAt: 'x', events: [], artifacts: [], answer: null, error: null, steps: 0,
      approval: { id: 'a', action: { type: 'scroll', direction: 'down' }, digest: 'a'.repeat(64), context: { profileId: 'p', tabId: 't' }, revision: 1, expiresAt: '2026-10-25T00:00:00Z', summary: 'Scroll' },
    }], activeJobId: 'j', settings: DEFAULT_SETTINGS, memory: [],
  };
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  const approval = snapshot.jobs[0]!.approval;
  assert.throws(() => validateSnapshot({ ...snapshot, jobs: [{ ...snapshot.jobs[0], approval: { ...approval, action: { type: 'read_page', maxScreens: 2 } } }] }), /approval/i);
});
