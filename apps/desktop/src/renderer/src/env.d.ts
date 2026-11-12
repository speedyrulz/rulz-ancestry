/// <reference types="vite/client" />
import type { RulzApi } from '../../shared/ipc';

declare global {
  interface Window {
    /** Provided by the preload script. Missing if the page is opened outside the app. */
    rulz?: RulzApi;
  }
}
