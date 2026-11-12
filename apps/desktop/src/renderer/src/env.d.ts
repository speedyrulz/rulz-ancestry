/// <reference types="vite/client" />
import type { RulzBridge } from '../../shared/ipc';

declare global {
  interface Window {
    /** Provided by the preload script. Missing if the page is opened outside the app. */
    rulz?: RulzBridge;
  }
}
