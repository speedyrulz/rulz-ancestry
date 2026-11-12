import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RulzApi } from '../shared/ipc';

// This script runs sandboxed. It must stay a thin, explicit list of calls:
// never expose ipcRenderer itself or a generic "send any channel" function.
const api: RulzApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
};

contextBridge.exposeInMainWorld('rulz', api);
