import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import type { AppBridge, AppState } from '../src/contract.ts';

const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string, ...args: unknown[]) => { calls.push([channel, ...args]); return { bridgeReady: true }; } });
const calls: unknown[][] = [];
let exposed: AppBridge | undefined;
Object.assign(globalThis, { __preloadElectronMock: { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name: string, bridge: AppBridge) => { assert.equal(name, 'sidework'); exposed = bridge; } } } });
registerHooks({
  resolve(specifier, context, next) { return specifier === 'electron' ? { url: 'sidework:preload-electron', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'sidework:preload-electron' ? { format: 'module', source: 'export const {ipcRenderer, contextBridge} = globalThis.__preloadElectronMock', shortCircuit: true } : next(url, context); },
});

test('preload exposes exactly DTO bridge APIs and never delivers raw IPC events', async () => {
  await import('../src/desktop/preload.ts');
  assert.ok(exposed);
  assert.deepEqual(Object.keys(exposed).sort(), ['dispatch', 'getState', 'onState']);
  await exposed.getState();
  await exposed.dispatch({ type: 'tab.new' });
  assert.deepEqual(calls, [['sidework:get-state'], ['sidework:dispatch', { type: 'tab.new' }]]);
  let received: unknown;
  const unsubscribe = exposed.onState((...args: unknown[]) => { received = args; });
  const state = { bridgeReady: true } as AppState;
  ipc.emit('sidework:state', { sender: 'secret native event' }, state);
  assert.deepEqual(received, [state]);
  unsubscribe(); unsubscribe();
  assert.equal(ipc.listenerCount('sidework:state'), 0);
});
