export const UPDATE_METHODS = [
  'updateState',
  'checkUpdate',
  'setUpdateStartup',
  'dismissUpdate',
  'openUpdate',
] as const;
export type UpdateMethod = (typeof UPDATE_METHODS)[number];
export type UpdateResult = 'newer' | 'current' | 'busy' | 'failed';
export interface UpdateState {
  startup: boolean;
  version: string | null;
}
export interface UpdateApi {
  updateState(): Promise<UpdateState>;
  checkUpdate(): Promise<UpdateResult>;
  setUpdateStartup(enabled: boolean): Promise<void>;
  dismissUpdate(): Promise<void>;
  openUpdate(): Promise<void>;
}
