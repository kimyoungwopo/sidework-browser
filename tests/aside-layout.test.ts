import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLayout } from '../src/renderer/behavior.ts';
import { paneLayout } from '../src/desktop/pane-layout.ts';
import { assertSurfaceCommand, parseCommand } from '../src/desktop/security.ts';

const pageUrl = 'https://example.com';

test('layout IPC accepts the main shell on both sides of each breakpoint', () => {
  for (const width of [1099, 1100, 1199, 1200]) {
    for (const panelOpen of [false, true]) {
      for (const url of [pageUrl, 'about:newtab']) {
        const layout = browserLayout(width, url, panelOpen);
        assert.deepEqual(parseCommand(layout), layout);
      }
    }
  }
});

test('layout IPC keeps legacy AgentArea geometry and authority unchanged', () => {
  const legacy = { type: 'layout.set', top: 88, left: 0, bottom: 0, sidebarWidth: 360, hideBrowser: false } as const;
  assert.deepEqual(parseCommand(legacy), legacy);
  assert.doesNotThrow(() => assertSurfaceCommand('agent', parseCommand(legacy)));
  assert.throws(() => assertSurfaceCommand('agent', parseCommand({ type: 'tab.new' })));
});

test('layout IPC accepts exact finite geometry limits and existing right-panel limits', () => {
  for (const top of [48, 200]) {
    for (const left of [0, 320]) {
      for (const bottom of [0, 100]) {
        for (const sidebarWidth of [0, 280, 700]) {
          const layout = { type: 'layout.set', top, left, bottom, sidebarWidth, hideBrowser: false };
          assert.deepEqual(parseCommand(layout), layout);
        }
      }
    }
  }
});

test('layout IPC rejects nonfinite, negative and oversized geometry in every field', () => {
  const valid = { type: 'layout.set', top: 56, left: 228, bottom: 0, sidebarWidth: 380, hideBrowser: false };
  const invalidByField = {
    top: [NaN, Infinity, -Infinity, -1, 0, 47, 201, Number.MAX_VALUE],
    left: [NaN, Infinity, -Infinity, -1, 321, Number.MAX_VALUE],
    bottom: [NaN, Infinity, -Infinity, -1, 101, Number.MAX_VALUE],
    sidebarWidth: [NaN, Infinity, -Infinity, -1, 1, 279, 701, Number.MAX_VALUE],
  };
  for (const [field, values] of Object.entries(invalidByField)) {
    for (const value of [...values, '56', null, undefined]) {
      assert.throws(() => parseCommand({ ...valid, [field]: value }), /화면 크기/, `${field}=${String(value)}`);
    }
  }
  assert.throws(() => parseCommand({ ...valid, hideBrowser: 'false' }));
  assert.throws(() => parseCommand({ ...valid, unexpected: 1 }));
});

test('main browser reserves the expanded Aside from 1100px and compact rail below it', () => {
  for (const [width, left] of [[960, 64], [1099, 64], [1100, 228], [1440, 228]]) {
    assert.deepEqual(browserLayout(width, pageUrl), {
      type: 'layout.set', left, top: 56, bottom: 0, sidebarWidth: 0, hideBrowser: false,
    });
  }
});

test('optional right panels keep the independent 1200px width breakpoint', () => {
  for (const [width, left, sidebarWidth] of [[1099, 64, 360], [1100, 228, 360], [1199, 228, 360], [1200, 228, 380]]) {
    assert.deepEqual(browserLayout(width, pageUrl, true), {
      type: 'layout.set', left, top: 56, bottom: 0, sidebarWidth, hideBrowser: false,
    });
    assert.equal(browserLayout(width, pageUrl, false).sidebarWidth, 0);
  }
});

test('newtab hiding remains limited to a single page', () => {
  for (const width of [1099, 1100]) {
    for (const url of [undefined, '', 'about:blank', 'about:newtab']) {
      assert.equal(browserLayout(width, url).hideBrowser, true);
      for (const splitCount of [2, 4, 8]) {
        assert.equal(browserLayout(width, url, false, splitCount).hideBrowser, false);
      }
    }
    assert.equal(browserLayout(width, pageUrl).hideBrowser, false);
  }
});

test('native split panes stay inside the Aside browser area without overlapping', () => {
  for (const width of [960, 1099, 1100, 1199, 1200, 1441]) {
    for (const panelOpen of [false, true]) {
      for (const count of [2, 4, 8] as const) {
        const layout = browserLayout(width, pageUrl, panelOpen, count);
        const height = 801;
        const left = width >= 1100 ? 228 : 64;
        const right = width - (panelOpen ? (width >= 1200 ? 380 : 360) : 0);
        const panes = paneLayout(count, { ...layout, width, height });
        assert.equal(panes.length, count);
        assert.equal(panes[0].x, left);
        assert.equal(panes[0].y, 56 + 32);
        for (const [index, pane] of panes.entries()) {
          assert.ok(pane.width > 0 && pane.height > 0);
          assert.ok(pane.x >= left && pane.y >= 56 + 32);
          assert.ok(pane.x + pane.width <= right);
          assert.ok(pane.y + pane.height <= height);
          for (const other of panes.slice(index + 1)) {
            assert.ok(pane.x + pane.width <= other.x || other.x + other.width <= pane.x
              || pane.y + pane.height <= other.y || other.y + other.height <= pane.y);
          }
        }
        assert.equal(Math.max(...panes.map(pane => pane.x + pane.width)), right);
        assert.equal(Math.max(...panes.map(pane => pane.y + pane.height)), height);
      }
    }
  }
});
