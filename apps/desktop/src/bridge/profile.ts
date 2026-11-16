import { isAbsolute, join } from 'node:path';
import { LEGACY_PROFILE_ENV, PROFILE_ENV } from './protocol';

/**
 * The folders of the app's data, as the app names them itself
 * (`main/index.ts`): the one of an installed copy, and the one of a copy
 * that was started from its source code.
 */
export const DEV_PROFILE = 'RulZ Kinspora (dev)';
export const USUAL_PROFILES: readonly string[] = [
  'RulZ Kinspora',
  'RulZ Ancestry',
  DEV_PROFILE,
  'RulZ Ancestry (dev)',
];

/**
 * The folders the bridge looks for the app's file in: the one it was told
 * (the command for Claude Code names it, and the connector for Claude
 * Desktop has a setting for it), and no other then. Told nothing, it looks
 * where an installed copy of the app keeps its data, and after that where a
 * copy started from the source code does. So a connector that was installed
 * with its setting left empty finds either. Both folders are in the user's
 * own profile, like the folder of an installed copy alone was.
 *
 * What it was told is taken only when it is a full path. A setting of the
 * connector that the user left empty may arrive as an empty text or as the
 * placeholder it was written with (`${user_config...}`); neither names a
 * folder.
 */
export function profileDirsOf(env: Record<string, string | undefined>, home: string): string[] {
  const named = (env[PROFILE_ENV] ?? env[LEGACY_PROFILE_ENV] ?? '').trim();
  if (named !== '' && !named.includes('${') && isAbsolute(named)) return [named];
  const roaming = env['APPDATA'];
  const base = roaming !== undefined && roaming !== '' ? roaming : join(home, 'AppData', 'Roaming');
  return USUAL_PROFILES.map((name) => join(base, name));
}
