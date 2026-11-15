import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppLink } from './link';
import { PROFILE_ENV } from './protocol';
import { clientOf, createBridgeServer } from './server';

/**
 * The bridge of the optional AI assistant: the program an AI app starts to
 * reach RulZ Ancestry. Claude Desktop starts it from the connector file the
 * app hands out, Claude Code from the command the app shows. It speaks the
 * Model Context Protocol on its standard input and output, and hands each
 * call of a tool to the app over a pipe of this PC (see `protocol.ts`).
 *
 * It is built into one file that needs nothing but Node.js
 * (`scripts/connector.mjs`). It reads one file, the one the app writes for a
 * session, and writes none. It starts no program and asks nothing of the
 * internet.
 *
 * Nothing but the protocol may be written to the standard output.
 */

declare const __RULZ_VERSION__: string | undefined;

/** The folder of the app's data, as the packaged app names it. */
const USUAL_PROFILE = 'RulZ Ancestry';

function profileDir(): string {
  const named = process.env[PROFILE_ENV];
  if (named !== undefined && named !== '') return named;
  const roaming = process.env['APPDATA'];
  return join(
    roaming !== undefined && roaming !== '' ? roaming : join(homedir(), 'AppData', 'Roaming'),
    USUAL_PROFILE,
  );
}

const link = new AppLink({ profileDir: profileDir(), client: () => clientOf(server) });
const server = createBridgeServer(
  link,
  typeof __RULZ_VERSION__ === 'string' ? __RULZ_VERSION__ : '0.0.0',
);

/** The AI app has gone: so does this program, and its connection to the app. */
function leave(): void {
  link.close();
  process.exit(0);
}

process.stdin.on('end', leave);
process.stdin.on('close', leave);
server.onclose = leave;

void server.connect(new StdioServerTransport()).catch(() => process.exit(1));
