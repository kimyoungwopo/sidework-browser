import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { AppBridge, AppCommand, AppState } from '../contract.ts';

const bridge: AppBridge = Object.freeze({
  getState: (): Promise<AppState> => ipcRenderer.invoke('sidework:get-state'),
  dispatch: (command: AppCommand): Promise<AppState> => ipcRenderer.invoke('sidework:dispatch', command),
  onState: (listener: (state: AppState) => void): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('State listener must be a function');
    // Never forward the event: it contains privileged renderer IPC handles.
    const receive = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('sidework:state', receive);
    return () => { ipcRenderer.removeListener('sidework:state', receive); };
  },
});
contextBridge.exposeInMainWorld('sidework', bridge);
