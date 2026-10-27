import test from 'node:test';
import assert from 'node:assert/strict';
import { paneLayout } from '../src/desktop/pane-layout.ts';

test('native pane grid reserves exactly 32px per header and uses all pixels', () => {
  const bounds = { width: 1101, height: 801, left: 0, top: 88, sidebarWidth: 300, bottom: 0 };
  assert.deepEqual(paneLayout(1, bounds), [{ x: 0, y: 88, width: 801, height: 713 }]);
  assert.deepEqual(paneLayout(2, bounds), [{ x: 0, y: 120, width: 400, height: 681 }, { x: 400, y: 120, width: 401, height: 681 }]);
  const eight = paneLayout(8, bounds);
  assert.equal(eight.length, 8);
  assert.deepEqual(eight[7], { x: 600, y: 476, width: 201, height: 325 });
  assert.throws(() => paneLayout(3 as never, bounds), /split/i);
});
