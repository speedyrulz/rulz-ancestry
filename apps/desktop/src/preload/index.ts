import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, channelFor, type RulzBridge } from '../shared/ipc';

// This script runs sandboxed. It exposes one function per entry of the
// contract's fixed list and nothing else: never ipcRenderer itself, and never
// a function that takes the channel name from the page.
const bridge = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channelFor(method), ...args),
  ]),
) as unknown as RulzBridge;

contextBridge.exposeInMainWorld('rulz', bridge);
