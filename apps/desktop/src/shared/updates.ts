export const UPDATE_METHODS = [
  'updateState',
  'checkUpdate',
  'setUpdateStartup',
  'dismissUpdate',
  'openUpdate',
  'installUpdate',
  'cancelUpdate',
  'acknowledgeUpdate',
] as const;
export type UpdateMethod = (typeof UPDATE_METHODS)[number];
export type UpdateResult = 'newer' | 'current' | 'busy' | 'failed';

/**
 * Where the one-click update stands:
 * - `idle`: nothing under way (the notice may offer an update).
 * - `downloading`: the installer is coming in; `percent` says how far.
 * - `waiting`: the installer is checked and waits for an import, a pack install or an AI session to end.
 * - `verified`: the installer is checked, but this copy cannot install it by itself (a development
 *   build or an unpacked folder); the release page is the way on.
 * - `installing`: the installer has been started and the app is closing.
 * - `failed`: the update stopped; `failure` says why.
 */
export type UpdatePhase = 'idle' | 'downloading' | 'waiting' | 'verified' | 'installing' | 'failed';

/** What the last update left behind, told once at the next start. */
export type UpdateOutcome =
  { kind: 'updated'; version: string } | { kind: 'not-installed'; version: string };

export interface UpdateState {
  startup: boolean;
  version: string | null;
  phase: UpdatePhase;
  /** Whole percent of the installer received while downloading; null otherwise. */
  percent: number | null;
  /** Whether this copy of the app can install an update by itself. */
  canInstall: boolean;
  /** Why the update failed, in words for the user; null unless the phase is `failed`. */
  failure: string | null;
  outcome: UpdateOutcome | null;
}
export interface UpdateApi {
  updateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateResult>;
  setUpdateStartup(enabled: boolean): Promise<void>;
  /** Hides the notice for this version. */
  dismissUpdate(): Promise<void>;
  openUpdate(): Promise<void>;
  /** Downloads, checks and installs the newer version, then reopens the app. Takes no version: the app knows it. */
  installUpdate(): Promise<void>;
  /** Gives up a download or a wait; nothing is installed. */
  cancelUpdate(): Promise<void>;
  /** Forgets what the last update left (the "updated" or "did not install" notice). */
  acknowledgeUpdate(): Promise<void>;
}
