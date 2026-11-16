import { PROFILE_ENV } from '../bridge/protocol';

/**
 * The command that adds the bridge to Claude Code, as the window of the AI
 * assistant shows it for the user to copy into a terminal. Nothing here uses
 * Electron.
 *
 * **The name stands before the options.** `--env` of `claude mcp add` takes
 * several values, so a name that follows it is read as one more of them
 * (tried with Claude Code 2.1.323 on 2026-11-14: "Invalid environment
 * variable format: rulz-kinspora"). The `--` that ends the options is in
 * quotes: Windows PowerShell takes a bare one away before a program that was
 * installed as a script sees it.
 */

/**
 * A path in double quotes, as PowerShell, cmd and a POSIX shell all take it.
 * One that holds a character a shell would read is not offered at all, and
 * neither is one with two backslashes in a row or one at its end, which a
 * POSIX shell reads as one backslash or as a quote that does not close.
 */
const quoted = (path: string): string | null =>
  /^[^"$`%!\r\n]+$/.test(path) && !path.includes('\\\\') && !path.endsWith('\\')
    ? `"${path}"`
    : null;

export interface ConnectorCommandInput {
  /** The file of the bridge, as a full path. */
  bridge: string;
  /** The folder this copy of the app keeps its data in. */
  profile: string;
  /**
   * The folders the bridge looks in when nothing tells it otherwise, in its
   * order: that of an installed copy first.
   */
  usual: readonly string[];
}

export interface ConnectorCommand {
  /** The command; empty where a path holds what cannot be put in quotes safely. */
  command: string;
  /** Whether this copy keeps its data in a folder the connector file looks in by itself. */
  fileFits: boolean;
}

export function connectorCommandOf(input: ConnectorCommandInput): ConnectorCommand {
  const profile = input.profile.toLowerCase();
  const fileFits = input.usual.some((folder) => folder.toLowerCase() === profile);
  // Only the first folder needs no naming: a bridge that is told nothing
  // would take a session of an installed copy before one of this copy.
  const named = input.usual[0]?.toLowerCase() !== profile;
  const bridgeArg = quoted(input.bridge);
  const profileArg = quoted(`${PROFILE_ENV}=${input.profile}`);
  if (bridgeArg === null || profileArg === null) return { command: '', fileFits };
  const env = named ? ` --env ${profileArg}` : '';
  return {
    command: `claude mcp add rulz-kinspora --scope user --transport stdio${env} "--" node ${bridgeArg}`,
    fileFits,
  };
}
