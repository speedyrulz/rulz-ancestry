import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppDatabase, setSetting, type Db } from '@rulz/db';
import { createThemeHandlers, DEFAULT_THEME, THEME_SETTING, ThemeService } from './theme';

let db: Db;
beforeEach(() => {
  db = openAppDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

function setup() {
  const apply = vi.fn<(theme: 'dark' | 'light') => void>();
  const service = new ThemeService({ db, apply });
  return { service, apply, handlers: createThemeHandlers(service) };
}

describe('the theme setting', () => {
  it('is dark until a choice is saved, and applying it sets that theme', () => {
    const { service, apply } = setup();
    expect(DEFAULT_THEME).toBe('dark');
    expect(service.get()).toBe('dark');
    expect(service.applySaved()).toBe('dark');
    expect(apply).toHaveBeenCalledExactlyOnceWith('dark');
  });

  it('keeps the choice, applies it at once and finds it again in a new service', () => {
    const { service, apply } = setup();
    service.set('light');
    expect(apply).toHaveBeenLastCalledWith('light');
    expect(service.get()).toBe('light');
    // A new service over the same settings, as after the app is started again.
    const again = new ThemeService({ db, apply });
    expect(again.applySaved()).toBe('light');
    expect(apply).toHaveBeenLastCalledWith('light');
    again.set('dark');
    expect(service.get()).toBe('dark');
  });

  it('falls back to dark when the saved value is damaged', () => {
    setSetting(db, THEME_SETTING, 'purple');
    const { service, apply } = setup();
    expect(service.get()).toBe('dark');
    expect(service.applySaved()).toBe('dark');
    expect(apply).toHaveBeenCalledExactlyOnceWith('dark');
  });
});

describe('the theme handlers', () => {
  it('read and save the choice', async () => {
    const { handlers, apply } = setup();
    expect(await handlers.getTheme()).toBe('dark');
    await handlers.setTheme('light');
    expect(await handlers.getTheme()).toBe('light');
    expect(apply).toHaveBeenLastCalledWith('light');
  });

  it('accept nothing but the two themes, and no extra arguments', async () => {
    const { handlers, apply } = setup();
    const bad: unknown[][] = [
      [],
      ['system'],
      ['Dark'],
      [''],
      [null],
      [1],
      [{ theme: 'light' }],
      ['light', 'dark'],
    ];
    for (const args of bad) {
      expect(() => handlers.setTheme(...args), JSON.stringify(args)).toThrow();
    }
    expect(() => handlers.getTheme('light')).toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(await handlers.getTheme()).toBe('dark');
  });
});
