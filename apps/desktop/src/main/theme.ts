import { getSetting, setSetting, type Db } from '@rulz/db';
import { z } from 'zod';
import { THEMES, type Theme, type ThemeMethod } from '../shared/theme';
import type { HandlerTable } from './handlers';

export type ThemeHandlers = Pick<HandlerTable, ThemeMethod>;

/** The key of the choice in the application's settings. */
export const THEME_SETTING = 'theme';
/** What a window starts with when no choice was saved: the brand's home. */
export const DEFAULT_THEME: Theme = 'dark';

const theme = z.enum(THEMES);

interface Options {
  db: Db;
  /** Makes the window show the theme: sets `nativeTheme.themeSource`, which the page follows. */
  apply: (theme: Theme) => void;
}

/** Keeps the theme choice in the application's settings and applies it to the window. */
export class ThemeService {
  constructor(private readonly options: Options) {}

  /** The saved choice. A missing or damaged value is the default, so a bad file cannot lock the window out. */
  get(): Theme {
    const saved = theme.safeParse(getSetting(this.options.db, THEME_SETTING));
    return saved.success ? saved.data : DEFAULT_THEME;
  }

  /** Saves the choice and applies it. */
  set(next: Theme): void {
    setSetting(this.options.db, THEME_SETTING, next);
    this.options.apply(next);
  }

  /** Applies the saved choice. Called before the window is made, so that it opens in the right colours. */
  applySaved(): Theme {
    const saved = this.get();
    this.options.apply(saved);
    return saved;
  }
}

export function createThemeHandlers(service: ThemeService): ThemeHandlers {
  return {
    getTheme: (...args) => {
      z.tuple([]).parse(args);
      return service.get();
    },
    setTheme: (...args) => {
      const [chosen] = z.tuple([theme]).parse(args);
      service.set(chosen);
    },
  };
}
