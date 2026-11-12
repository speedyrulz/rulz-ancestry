/**
 * The contract between the main process and the renderer. The renderer can
 * only reach the main process through the functions listed in {@link RulzApi},
 * which the preload script exposes as `window.rulz`.
 */

export const IPC = {
  appInfo: 'app:info',
} as const;

export interface AppInfo {
  appVersion: string;
  packaged: boolean;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  database: {
    path: string;
    sqliteVersion: string;
    fts5: boolean;
    journalMode: string;
  };
  /**
   * Result of the start-up check that builds a small family tree in memory and
   * adds, finds, undoes and redoes a person in it.
   */
  treeEngine: { ok: true; schemaVersion: number } | { ok: false; error: string };
  /** Number of known data sources per access tier. */
  connectors: {
    api: number;
    bulk: number;
    deeplink: number;
  };
}

export interface RulzApi {
  getAppInfo(): Promise<AppInfo>;
}
