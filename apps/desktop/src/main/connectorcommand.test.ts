import { describe, expect, it } from 'vitest';
import { connectorCommandOf } from './connectorcommand';

const usual = 'C:\\Users\\someone\\AppData\\Roaming\\RulZ Ancestry';
const bridge =
  'C:\\Program Files\\RulZ Ancestry\\resources\\app.asar.unpacked\\out\\connector\\bridge.cjs';

describe('the command that adds the bridge to Claude Code', () => {
  it('names the bridge and nothing else for a copy with its data in the usual folder', () => {
    expect(connectorCommandOf({ bridge, profile: usual, usual })).toEqual({
      command: `claude mcp add rulz-ancestry --scope user --transport stdio "--" node "${bridge}"`,
      fileFits: true,
    });
    // Windows does not tell capital letters apart in the name of a folder.
    expect(connectorCommandOf({ bridge, profile: usual.toUpperCase(), usual }).fileFits).toBe(true);
  });

  it('says where the data is for a copy that keeps it elsewhere', () => {
    const profile = `${usual} (dev)`;
    expect(connectorCommandOf({ bridge, profile, usual })).toEqual({
      command: `claude mcp add rulz-ancestry --scope user --transport stdio --env "RULZ_ANCESTRY_PROFILE=${profile}" "--" node "${bridge}"`,
      fileFits: false,
    });
  });

  it('has the name before every option, and nothing but the end of the options after --env', () => {
    // --env takes several values: a name after it would be read as one of them.
    const { command } = connectorCommandOf({ bridge, profile: `${usual} (dev)`, usual });
    const words: string[] = command.match(/"[^"]*"|\S+/g) ?? [];
    expect(words.slice(0, 4)).toEqual(['claude', 'mcp', 'add', 'rulz-ancestry']);
    expect(words[words.indexOf('--env') + 2]).toBe('"--"');
    // The end of the options is in quotes, which PowerShell passes on.
    expect(words).not.toContain('--');
  });

  it('offers no command for a path a shell would read something into', () => {
    for (const odd of ['C:\\a"b', 'C:\\a$b', 'C:\\a`b', 'C:\\a%b%', 'C:\\a!b', 'C:\\a\nb']) {
      expect(connectorCommandOf({ bridge: `${odd}\\bridge.cjs`, profile: usual, usual })).toEqual({
        command: '',
        fileFits: true,
      });
      expect(connectorCommandOf({ bridge, profile: odd, usual }).command).toBe('');
    }
    expect(
      connectorCommandOf({ bridge: '\\\\server\\share\\bridge.cjs', profile: usual, usual }),
    ).toMatchObject({ command: '' });
    expect(connectorCommandOf({ bridge, profile: 'D:\\data\\', usual }).command).toBe('');
  });
});
