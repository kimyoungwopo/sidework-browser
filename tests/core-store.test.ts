import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/contract.ts';
import type { CoreSnapshot } from '../src/contract.ts';

test('store refuses corrupt or unsafe persisted DTOs rather than trusting a type assertion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidework-core-corrupt-'));
  try {
    const { RuntimeStore } = await import('../src/core/store.ts');
    const safe: CoreSnapshot = { jobs: [], activeJobId: null, settings: { ...DEFAULT_SETTINGS }, memory: [] };
    for (const value of [
      { ...safe, settings: { ...DEFAULT_SETTINGS, confirmMutations: false } },
      { ...safe, settings: { ...DEFAULT_SETTINGS, maxSteps: 10000 } },
      { ...safe, memory: [{ id: 'm', text: 42, createdAt: 'now' }] },
      { ...safe, jobs: [{ id: 'j', status: 'completed' }] },
      { ...safe, activeJobId: 42 },
    ]) {
      await writeFile(join(root, 'runtime.json'), JSON.stringify(value));
      await assert.rejects(new RuntimeStore(root).load(), /runtime data/i);
    }
    await writeFile(join(root, 'runtime.json'), '{broken');
    await assert.rejects(new RuntimeStore(root).load(), /runtime data/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('store atomically serializes real filesystem snapshots without retaining references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sidework-core-'));
  try {
    const { RuntimeStore } = await import('../src/core/store.ts');
    const store = new RuntimeStore(root);
    const initial = await store.load();
    assert.deepEqual(initial, { jobs: [], activeJobId: null, settings: DEFAULT_SETTINGS, memory: [] });
    const first: CoreSnapshot = structuredClone(initial);
    first.memory.push({ id: 'one', text: 'first', createdAt: 'now' });
    const saving = store.save(first);
    first.memory[0]!.text = 'changed outside';
    const second: CoreSnapshot = structuredClone(initial);
    second.memory.push({ id: 'two', text: 'second', createdAt: 'now' });
    await Promise.all([saving, store.save(second)]);
    assert.deepEqual(await new RuntimeStore(root).load(), second);
    assert.deepEqual(await readdir(root), ['runtime.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
