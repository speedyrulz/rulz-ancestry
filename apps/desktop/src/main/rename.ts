import { join } from 'node:path';

type Files = { exists: (path: string) => boolean; rename: (old: string, next: string) => void };
type ProfileFiles = Files & { removeEmptyDir: (path: string) => void };

export function profilePath(
  base: string,
  packaged: boolean,
  explicit: boolean,
  current: string,
  fs: ProfileFiles,
): string {
  if (explicit) return current;
  const suffix = packaged ? '' : ' (dev)';
  const next = join(base, `RulZ Kinspora${suffix}`);
  const old = join(base, `RulZ Ancestry${suffix}`);
  if (fs.exists(join(next, 'app.db'))) return next;
  if (fs.exists(join(old, 'app.db'))) {
    try {
      if (fs.exists(next)) fs.removeEmptyDir(next);
      fs.rename(old, next);
    } catch {
      return old;
    }
  }
  return next;
}

export function treesPath(base: string, packaged: boolean, exists: Files['exists']): string {
  const suffix = packaged ? '' : ' (dev)';
  const next = join(base, `RulZ Kinspora${suffix}`);
  const old = join(base, `RulZ Ancestry${suffix}`);
  return !exists(next) && exists(old) ? old : next;
}

export function packsPath(base: string, fs: Files, entries: (path: string) => string[]): string {
  const oldParent = join(base, 'RulZAncestry');
  const nextParent = join(base, 'RulZKinspora');
  const old = join(oldParent, 'packs');
  const next = join(nextParent, 'packs');
  if (!fs.exists(next) && fs.exists(old)) {
    try {
      if (fs.exists(nextParent) || entries(oldParent).some((name) => name !== 'packs')) return old;
      fs.rename(oldParent, nextParent);
    } catch {
      return old;
    }
  }
  return next;
}
