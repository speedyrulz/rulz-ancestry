/** The theme of the window: dark by default, light on request. The main process keeps the choice. */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_METHODS = ['getTheme', 'setTheme'] as const;
export type ThemeMethod = (typeof THEME_METHODS)[number];

export interface ThemeApi {
  /** The saved choice; the dark theme when nothing was saved. */
  getTheme(): Promise<Theme>;
  /** Saves the choice and applies it to the window now. */
  setTheme(theme: Theme): Promise<void>;
}
