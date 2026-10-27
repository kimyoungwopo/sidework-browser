import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_SCHEMA, parsePlanOutput } from '../src/provider/codex.ts';

test('generation schema requires the correct nonnull typing field and forbids finish-text substitution', () => {
  const action = PLAN_SCHEMA.properties.action;
  assert(Array.isArray(action.anyOf), 'Flat nullable schema permits semantically invalid typing plans');
  const typing = action.anyOf.find(branch => branch.properties.type.enum.includes('computer_type'));
  assert(typing);
  assert.deepEqual(typing.properties.value, { type: 'string' });
  assert.deepEqual(typing.properties.text, { type: 'null' });
  assert.deepEqual(typing.properties.frameId, { type: 'string', minLength: 1, maxLength: 200 });
  assert.equal(typing.additionalProperties, false);
  assert.deepEqual(new Set(typing.required), new Set(Object.keys(typing.properties)));
  assert.throws(() => parsePlanOutput(JSON.stringify({ thought: 'type', action: { type: 'computer_type', value: null, text: '1234', frameId: 'frame' } })));
  assert.deepEqual(parsePlanOutput(JSON.stringify({ thought: 'type', action: { type: 'computer_type', value: '1234', frameId: 'frame' } })).action, { type: 'computer_type', value: '1234', frameId: 'frame' });
});
