import { describe, expect, it } from 'vitest';
import { connectorCommandOf } from './connectorcommand';

const installed = 'C:\\Users\\someone\\AppData\\Roaming\\RulZ Kinspora';
const fromSource = `${installed} (dev)`;
const usual = [installed, fromSource];
const bridge =
  'C:\\Program Files\\RulZ Kinspora\\resources\\app.asar.unpacked\\out\\connector\\bridge.cjs';

describe('the command that adds the bridge to Claude Code', () => {
  it('names the bridge and nothing else for a copy with its data in the usual folder', () => {
    expect(connectorCommandOf({ bridge, profile: installed, usual })).toEqual({
      command: `claude mcp add rulz-kinspora --scope user --transport stdio "--" node "${bridge}"`,
      fileFits: true,
    });
    // Windows does not tell capital letters apart in the name of a folder.
    expect(connectorCommandOf({ bridge, profile: installed.toUpperCase(), usual }).fileFits).toBe(
      true,
    );
  });

  it('names the folder of a copy started from the source code, which the connector file finds by itself', () => {
    // A bridge that is told nothing would take a session of an installed copy first.
    expect(connectorCommandOf({ bridge, profile: fromSource, usual })).toEqual({
      command: `claude mcp add rulz-kinspora --scope user --transport stdio --env "RULZ_KINSPORA_PROFILE=${fromSource}" "--" node "${bridge}"`,
      fileFits: true,
    });
    const capitals = connectorCommandOf({ bridge, profile: fromSource.toUpperCase(), usual });
    expect(capitals.fileFits).toBe(true);
    expect(capitals.command).toContain('--env');
  });

  it('says where the data is for a copy that keeps it elsewhere', () => {
    const profile = 'E:\\somewhere\\data';
    expect(connectorCommandOf({ bridge, profile, usual })).toEqual({
      command: `claude mcp add rulz-kinspora --scope user --transport stdio --env "RULZ_KINSPORA_PROFILE=${profile}" "--" node "${bridge}"`,
      fileFits: false,
    });
  });

  it('has the name before every option, and nothing but the end of the options after --env', () => {
    // --env takes several values: a name after it would be read as one of them.
    const { command } = connectorCommandOf({ bridge, profile: fromSource, usual });
    const words: string[] = command.match(/"[^"]*"|\S+/g) ?? [];
    expect(words.slice(0, 4)).toEqual(['claude', 'mcp', 'add', 'rulz-kinspora']);
    expect(words[words.indexOf('--env') + 2]).toBe('"--"');
    // The end of the options is in quotes, which PowerShell passes on.
    expect(words).not.toContain('--');
  });

  it('offers no command for a path a shell would read something into', () => {
    for (const odd of ['C:\\a"b', 'C:\\a$b', 'C:\\a`b', 'C:\\a%b%', 'C:\\a!b', 'C:\\a\nb']) {
      expect(
        connectorCommandOf({ bridge: `${odd}\\bridge.cjs`, profile: installed, usual }),
      ).toEqual({ command: '', fileFits: true });
      expect(connectorCommandOf({ bridge, profile: odd, usual }).command).toBe('');
    }
    expect(
      connectorCommandOf({ bridge: '\\\\server\\share\\bridge.cjs', profile: installed, usual }),
    ).toMatchObject({ command: '' });
    expect(connectorCommandOf({ bridge, profile: 'D:\\data\\', usual }).command).toBe('');
  });
});
