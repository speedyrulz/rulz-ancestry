import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { packsPath, profilePath, treesPath } from './rename';

describe('rename migration', () => {
  for (const packaged of [true, false]) {
    const suffix = packaged ? '' : ' (dev)';
    const old = join('base', `RulZ Ancestry${suffix}`);
    const next = join('base', `RulZ Kinspora${suffix}`);
    it(`selects and migrates the ${packaged ? 'installed' : 'development'} profile`, () => {
      const rename = vi.fn();
      const removeEmptyDir = vi.fn();
      const exists = vi.fn((path: string) => path === next || path === join(old, 'app.db'));
      expect(
        profilePath('base', packaged, false, 'custom', { exists, rename, removeEmptyDir }),
      ).toBe(next);
      expect(removeEmptyDir).toHaveBeenCalledWith(next);
      expect(rename).toHaveBeenCalledWith(old, next);
    });
    it(`preserves the ${packaged ? 'installed' : 'development'} trees path`, () => {
      const exists = (path: string) => path === old;
      expect(treesPath('base', packaged, exists)).toBe(old);
      expect(treesPath('base', packaged, () => true)).toBe(next);
    });
  }
  it('uses the old profile when the destination is not empty', () => {
    const old = join('base', 'RulZ Ancestry');
    const next = join('base', 'RulZ Kinspora');
    const rename = vi.fn();
    const removeEmptyDir = vi.fn(() => {
      throw Error();
    });
    const exists = (path: string) => path === next || path === join(old, 'app.db');
    expect(profilePath('base', true, false, 'custom', { exists, rename, removeEmptyDir })).toBe(
      old,
    );
    expect(removeEmptyDir).toHaveBeenCalledWith(next);
    expect(rename).not.toHaveBeenCalled();
  });
  it('uses the old profile when rename fails', () => {
    const old = join('base', 'RulZ Ancestry');
    const rename = vi.fn(() => {
      throw Error();
    });
    const removeEmptyDir = vi.fn();
    const exists = (path: string) => path === join(old, 'app.db');
    expect(profilePath('base', true, false, 'custom', { exists, rename, removeEmptyDir })).toBe(
      old,
    );
    expect(removeEmptyDir).not.toHaveBeenCalled();
  });
  it('prefers an existing new profile even when the old profile exists', () => {
    const rename = vi.fn();
    const removeEmptyDir = vi.fn();
    expect(
      profilePath('base', true, false, 'custom', { exists: () => true, rename, removeEmptyDir }),
    ).toBe(join('base', 'RulZ Kinspora'));
    expect(rename).not.toHaveBeenCalled();
    expect(removeEmptyDir).not.toHaveBeenCalled();
  });
  it('uses the new path when neither profile has a database', () => {
    const rename = vi.fn();
    const removeEmptyDir = vi.fn();
    for (const exists of [() => false, (path: string) => path === join('base', 'RulZ Ancestry')]) {
      expect(profilePath('base', true, false, 'custom', { exists, rename, removeEmptyDir })).toBe(
        join('base', 'RulZ Kinspora'),
      );
    }
    expect(rename).not.toHaveBeenCalled();
    expect(removeEmptyDir).not.toHaveBeenCalled();
  });
  it('leaves an explicit user-data directory untouched', () => {
    const exists = vi.fn();
    const rename = vi.fn();
    const removeEmptyDir = vi.fn();
    expect(profilePath('base', true, true, 'custom', { exists, rename, removeEmptyDir })).toBe(
      'custom',
    );
    expect(exists).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(removeEmptyDir).not.toHaveBeenCalled();
  });
  it('moves only a packs-only parent and falls back on failure', () => {
    const old = join('base', 'RulZAncestry');
    const next = join('base', 'RulZKinspora');
    const exists = (path: string) => path === join(old, 'packs');
    const rename = vi.fn();
    expect(packsPath('base', { exists, rename }, () => ['packs'])).toBe(join(next, 'packs'));
    expect(rename).toHaveBeenCalledWith(old, next);
    expect(packsPath('base', { exists, rename }, () => ['packs', 'other'])).toBe(
      join(old, 'packs'),
    );
    expect(
      packsPath(
        'base',
        {
          exists,
          rename: () => {
            throw Error();
          },
        },
        () => ['packs'],
      ),
    ).toBe(join(old, 'packs'));
  });
});
