import { isAbsolute, join } from 'node:path';
import { PROFILE_ENV } from './protocol';

/** The folder of the app's data, as the packaged app names it. */
const USUAL_PROFILE = 'RulZ Ancestry';

/**
 * The folder the bridge looks for the app's file in: the one it was told
 * (the command for Claude Code names it, and the connector for Claude
 * Desktop has a setting for it), or else the folder an installed copy of the
 * app uses.
 *
 * What it was told is taken only when it is a full path. A setting of the
 * connector that the user left empty may arrive as an empty text or as the
 * placeholder it was written with (`${user_config...}`); neither names a
 * folder.
 */
export function profileDirOf(env: Record<string, string | undefined>, home: string): string {
  const named = (env[PROFILE_ENV] ?? '').trim();
  if (named !== '' && !named.includes('${') && isAbsolute(named)) return named;
  const roaming = env['APPDATA'];
  return join(
    roaming !== undefined && roaming !== '' ? roaming : join(home, 'AppData', 'Roaming'),
    USUAL_PROFILE,
  );
}
