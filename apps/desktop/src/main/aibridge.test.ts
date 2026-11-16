import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AI_TOOL_NAMES, RESEARCH_PROMPT, RESEARCH_PROMPT_NAME, type AiToolResult } from '@rulz/ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppLink,
  CUT_OFF,
  NOT_FITTING,
  NOT_REACHED,
  NOT_TRUSTED,
  NOT_UNDER_WAY,
  NO_SUCH_TOOL,
  TOO_LONG,
  TOO_MANY,
} from '../bridge/link';
import {
  BRIDGE_PROTOCOL,
  CONNECTOR_FILE,
  LINE_MAX,
  LineReader,
  lineOf,
  newPipeName,
  newSecret,
  parseConnectorFile,
  proofOf,
  type ConnectorFile,
} from '../bridge/protocol';
import { clientOf, createBridgeServer } from '../bridge/server';
import type { AiClientInfo } from '../shared/ipc';
import {
  AI_BRIDGE_CALLS,
  AI_BRIDGE_CLIENTS,
  AI_BRIDGE_HELLO_MS,
  AI_BRIDGE_UNREAD_MAX,
  AI_BRIDGE_WAITING,
  AiBridgeServer,
} from './aibridge';

/**
 * The pipe between the app and its bridge, tried with the real thing: a
 * named pipe of this PC, the app's side that listens on it, and the bridge's
 * side that connects to it. Named pipes of this kind are a thing of Windows,
 * which is where the app runs.
 */
const onWindows = process.platform === 'win32';

let dir: string;
let bridge: AiBridgeServer;
let calls: { name: string; input: unknown }[];
let answer: (name: string, input: unknown) => Promise<AiToolResult>;
let connected: AiClientInfo[];
let changes: number;
let links: AppLink[];
let sockets: Socket[];
let servers: Server[];

const until = async (what: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const file = (): ConnectorFile => {
  const read = parseConnectorFile(readFileSync(join(dir, CONNECTOR_FILE), 'utf8'));
  if (read === null) throw new Error('the file is not what the app writes');
  return read;
};

/** The app listens, as it does once a session has started. */
const listen = async (): Promise<ConnectorFile> => {
  bridge.open();
  await until(() => bridge.state().open);
  return file();
};

const link = (name = 'an AI app'): AppLink => {
  const made = new AppLink({
    profileDir: dir,
    client: () => ({ name, version: '1.2.3' }),
    handshakeMs: 500,
  });
  links.push(made);
  return made;
};

/** A connection that speaks for itself, to send what a bridge never would. */
const raw = async (
  pipe: string,
): Promise<{ socket: Socket; lines: string[]; closed: () => boolean }> => {
  const socket = connect(pipe);
  sockets.push(socket);
  const reader = new LineReader();
  const lines: string[] = [];
  let closed = false;
  socket.on('error', () => undefined);
  socket.on('close', () => {
    closed = true;
  });
  socket.on('data', (chunk: Buffer) => {
    const read = reader.push(chunk);
    if (read !== 'too-long') lines.push(...read);
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return { socket, lines, closed: () => closed };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rulz-bridge-'));
  calls = [];
  connected = [];
  changes = 0;
  links = [];
  sockets = [];
  servers = [];
  answer = (name) => Promise.resolve({ ok: true, value: { tool: name } });
  bridge = new AiBridgeServer({
    dir,
    call: (name, input) => {
      calls.push({ name, input });
      return answer(name, input);
    },
    now: () => 1_000,
    handshakeMs: 200,
  });
  bridge.onClient((client) => connected.push(client));
  bridge.onChange(() => {
    changes += 1;
  });
});

afterEach(async () => {
  for (const made of links) made.close();
  for (const socket of sockets) socket.destroy();
  bridge.close();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
  );
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(onWindows)('the pipe of a session', () => {
  it('is there with its file while the app listens, and gone with it afterwards', async () => {
    expect(bridge.state()).toEqual({ open: false, problem: '', clients: [] });
    expect(existsSync(join(dir, CONNECTOR_FILE))).toBe(false);

    const written = await listen();
    expect(written.protocol).toBe(BRIDGE_PROTOCOL);
    expect(written.pipe).toBe(bridge.pipe);
    expect(changes).toBe(1);
    // Nothing but what a bridge needs, and no draft left beside it.
    expect(Object.keys(JSON.parse(readFileSync(join(dir, CONNECTOR_FILE), 'utf8')))).toEqual([
      'protocol',
      'pipe',
      'key',
    ]);
    expect(existsSync(join(dir, `${CONNECTOR_FILE}.new`))).toBe(false);

    bridge.close();
    expect(bridge.state().open).toBe(false);
    expect(existsSync(join(dir, CONNECTOR_FILE))).toBe(false);
    // The pipe is gone: nothing answers under its name.
    const late = connect(written.pipe);
    sockets.push(late);
    const failed = await new Promise<boolean>((resolve) => {
      late.once('error', () => resolve(true));
      late.once('connect', () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  it('has a new name and a new key each time the app listens', async () => {
    const first = await listen();
    const second = await listen();
    expect(second.pipe).not.toBe(first.pipe);
    expect(second.key).not.toBe(first.key);
  });

  it('removes a file that a run ended by force left behind', () => {
    writeFileSync(join(dir, CONNECTOR_FILE), '{}');
    bridge.forgetFile();
    expect(existsSync(join(dir, CONNECTOR_FILE))).toBe(false);
    // And says nothing when there is none.
    bridge.forgetFile();
  });

  it('does not listen when it was closed before the pipe was up', async () => {
    bridge.open();
    bridge.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bridge.state().open).toBe(false);
    expect(existsSync(join(dir, CONNECTOR_FILE))).toBe(false);
  });
});

describe.runIf(onWindows)('a bridge that holds the key', () => {
  it('hands a call to the session and brings back its answer', async () => {
    await listen();
    const app = link('Claude Desktop');
    expect(await app.call('get_person', { personId: 'p1' })).toEqual({
      ok: true,
      value: { tool: 'get_person' },
    });
    expect(calls).toEqual([{ name: 'get_person', input: { personId: 'p1' } }]);
    // One connection serves every call after the first.
    await app.call('get_session', {});
    expect(connected).toEqual([{ name: 'Claude Desktop', version: '1.2.3', since: 1_000 }]);
    expect(bridge.state().clients).toEqual(connected);
  });

  it('brings back a refusal of the session as it is', async () => {
    await listen();
    answer = () =>
      Promise.resolve({
        ok: false,
        reason: 'budget',
        message: 'No question is left.',
        detail: { left: 0 },
      });
    expect(await link().call('search_records', {})).toEqual({
      ok: false,
      reason: 'budget',
      message: 'No question is left.',
      detail: { left: 0 },
    });
  });

  it('answers calls in any order, each under its own number', async () => {
    await listen();
    const waiting: (() => void)[] = [];
    answer = (name) =>
      new Promise((resolve) => waiting.push(() => resolve({ ok: true, value: name })));
    const app = link();
    const first = app.call('get_person', {});
    const second = app.call('get_relatives', {});
    await until(() => waiting.length === 2);
    waiting[1]?.();
    expect(await second).toEqual({ ok: true, value: 'get_relatives' });
    waiting[0]?.();
    expect(await first).toEqual({ ok: true, value: 'get_person' });
  });

  it('is told that a call was cut off when the session ends under it, and does not send it again', async () => {
    await listen();
    answer = () => new Promise(() => undefined);
    const app = link();
    const call = app.call('search_records', {});
    await until(() => calls.length === 1);
    bridge.close();
    expect(await call).toBe(CUT_OFF);
    expect(calls).toHaveLength(1);
    // Nothing listens now.
    expect(await app.call('get_session', {})).toBe(NOT_UNDER_WAY);
    expect(calls).toHaveLength(1);
  });

  it('finds the next session by itself', async () => {
    await listen();
    const app = link();
    await app.call('get_session', {});
    await listen();
    await until(() => bridge.state().clients.length === 0);
    expect(await app.call('get_session', {})).toEqual({ ok: true, value: { tool: 'get_session' } });
    expect(connected).toHaveLength(2);
  });

  it('is told when an answer cannot be passed on, and the connection stays', async () => {
    await listen();
    answer = () => Promise.resolve({ ok: true, value: 'a'.repeat(LINE_MAX) });
    const app = link();
    expect(await app.call('get_record', {})).toMatchObject({ ok: false, reason: 'failed' });
    answer = () => Promise.reject(new Error('a path of a file'));
    expect(await app.call('get_record', {})).toEqual({
      ok: false,
      reason: 'failed',
      message: 'The call failed.',
    });
    expect(bridge.state().clients).toHaveLength(1);
  });

  it('has only so many calls under way at once', async () => {
    await listen();
    answer = () => new Promise(() => undefined);
    const app = link();
    for (let index = 0; index < AI_BRIDGE_CALLS; index += 1) void app.call('get_person', {});
    expect(await app.call('get_person', {})).toMatchObject({
      ok: false,
      reason: 'failed',
      message: expect.stringContaining('Too many calls at once'),
    });
    expect(calls).toHaveLength(AI_BRIDGE_CALLS);
  });

  it('is one of only so many at once', async () => {
    await listen();
    for (let index = 0; index < AI_BRIDGE_CLIENTS; index += 1) {
      expect((await link(`app ${index}`).call('get_session', {})).ok).toBe(true);
    }
    expect(await link('one too many').call('get_session', {})).toBe(TOO_MANY);
    expect(bridge.state().clients).toHaveLength(AI_BRIDGE_CLIENTS);
    // A place is free again when one has gone.
    links[0]?.close();
    await until(() => bridge.state().clients.length === AI_BRIDGE_CLIENTS - 1);
    expect((await link('the next').call('get_session', {})).ok).toBe(true);
  });

  it('has its name shown as one short line, whatever it calls itself', async () => {
    await listen();
    await link(`  Claude\n\tDesktop ${'x'.repeat(300)}`).call('get_session', {});
    const name = connected[0]?.name ?? '';
    expect(name.startsWith('Claude Desktop x')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name).not.toMatch(/[\n\t]/);
  });
});

describe.runIf(onWindows)('a bridge and what it finds in the place of the app', () => {
  it('says that no session is under way when there is no file, or none it can read', async () => {
    expect(await link().call('get_session', {})).toBe(NOT_UNDER_WAY);
    writeFileSync(join(dir, CONNECTOR_FILE), 'x'.repeat(10_000));
    expect(await link().call('get_session', {})).toBe(NOT_UNDER_WAY);
    // A file that names a pipe of another PC is not followed.
    writeFileSync(
      join(dir, CONNECTOR_FILE),
      JSON.stringify({
        protocol: BRIDGE_PROTOCOL,
        pipe: newPipeName().replace('\\\\.\\', '\\\\fileserver\\'),
        key: newSecret(),
      }),
    );
    expect(await link().call('get_session', {})).toBe(NOT_UNDER_WAY);
  });

  it('says so when the file names a pipe that is gone', async () => {
    const written = await listen();
    bridge.close();
    writeFileSync(join(dir, CONNECTOR_FILE), JSON.stringify(written));
    expect(await link().call('get_session', {})).toBe(NOT_UNDER_WAY);
  });

  it('looks in a second folder when the first has no session under way', async () => {
    // As a connector does that was told no folder: an installed copy first,
    // then a copy that was started from the source code.
    const first = mkdtempSync(join(tmpdir(), 'rulz-bridge-first-'));
    const twoFolders = (): AppLink => {
      const made = new AppLink({
        profileDir: [first, dir],
        client: () => ({ name: 'an AI app', version: '1.2.3' }),
        handshakeMs: 500,
      });
      links.push(made);
      return made;
    };
    try {
      // Neither has a session.
      expect(await twoFolders().call('get_session', {})).toBe(NOT_UNDER_WAY);
      const written = await listen();
      // No file in the first folder.
      expect(await twoFolders().call('get_session', {})).toEqual({
        ok: true,
        value: { tool: 'get_session' },
      });
      // A file there that is left from a session that is gone.
      writeFileSync(
        join(first, CONNECTOR_FILE),
        JSON.stringify({ ...written, pipe: newPipeName(), key: newSecret() }),
      );
      expect(await twoFolders().call('get_session', {})).toEqual({
        ok: true,
        value: { tool: 'get_session' },
      });
      // A file there of a copy that speaks another wording does not stand in the way.
      writeFileSync(join(first, CONNECTOR_FILE), JSON.stringify({ ...written, protocol: 2 }));
      expect(await twoFolders().call('get_session', {})).toEqual({
        ok: true,
        value: { tool: 'get_session' },
      });
      // Neither does a pipe there that turns this bridge away: here the pipe
      // of the session, named with a key that is not its key.
      writeFileSync(join(first, CONNECTOR_FILE), JSON.stringify({ ...written, key: newSecret() }));
      expect(await twoFolders().call('get_session', {})).toEqual({
        ok: true,
        value: { tool: 'get_session' },
      });
      // Where no folder takes the bridge, the first that had something to say is the answer.
      bridge.close();
      writeFileSync(join(first, CONNECTOR_FILE), JSON.stringify({ ...written, protocol: 2 }));
      expect(await twoFolders().call('get_session', {})).toBe(NOT_FITTING);
    } finally {
      rmSync(first, { recursive: true, force: true });
    }
  });

  it('says that the two do not fit when the app speaks another wording', async () => {
    const written = await listen();
    writeFileSync(join(dir, CONNECTOR_FILE), JSON.stringify({ ...written, protocol: 2 }));
    expect(await link().call('get_session', {})).toBe(NOT_FITTING);
    expect(calls).toEqual([]);
  });

  it('is turned away when its key is not the key of the session', async () => {
    const written = await listen();
    writeFileSync(join(dir, CONNECTOR_FILE), JSON.stringify({ ...written, key: newSecret() }));
    // The app could not prove itself to this bridge either, with the key the bridge holds.
    expect(await link().call('get_session', {})).toBe(NOT_TRUSTED);
    expect(calls).toEqual([]);
    expect(connected).toEqual([]);
  });

  it('sends nothing to a program that took the name of the pipe but does not hold the key', async () => {
    const pipe = newPipeName();
    const key = newSecret();
    const got: string[] = [];
    const fake = createServer((socket) => {
      const reader = new LineReader();
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        const lines = reader.push(chunk);
        if (lines === 'too-long') return;
        for (const line of lines) {
          got.push(line);
          const message = JSON.parse(line) as { t: string; nonce?: string };
          if (message.t === 'hello') {
            const nonce = newSecret();
            // It answers as the app would, with a proof made without the key.
            socket.write(
              lineOf({
                t: 'hello',
                protocol: BRIDGE_PROTOCOL,
                nonce,
                proof: proofOf(newSecret(), 'app', pipe, message.nonce ?? '', nonce),
              }),
            );
          }
        }
      });
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(pipe, () => resolve()));
    writeFileSync(
      join(dir, CONNECTOR_FILE),
      JSON.stringify({ protocol: BRIDGE_PROTOCOL, pipe, key }),
    );

    expect(await link().call('search_tree', { query: 'Veldkamp' })).toBe(NOT_TRUSTED);
    // It was greeted, twice, and that is all: no proof of the bridge, no call, and never the key.
    expect(got.map((line) => (JSON.parse(line) as { t: string }).t)).toEqual(['hello', 'hello']);
    expect(got.join('\n')).not.toContain(key);
    expect(got.join('\n')).not.toContain('Veldkamp');
  });

  it('does not take a proof of the app that was made for the other side', async () => {
    const pipe = newPipeName();
    const key = newSecret();
    const got: string[] = [];
    const fake = createServer((socket) => {
      const reader = new LineReader();
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        const lines = reader.push(chunk);
        if (lines === 'too-long') return;
        for (const line of lines) {
          got.push(line);
          const message = JSON.parse(line) as { t: string; nonce?: string };
          if (message.t === 'hello') {
            const nonce = newSecret();
            socket.write(
              lineOf({
                t: 'hello',
                protocol: BRIDGE_PROTOCOL,
                nonce,
                proof: proofOf(key, 'bridge', pipe, message.nonce ?? '', nonce),
              }),
            );
          }
        }
      });
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(pipe, () => resolve()));
    writeFileSync(
      join(dir, CONNECTOR_FILE),
      JSON.stringify({ protocol: BRIDGE_PROTOCOL, pipe, key }),
    );
    expect(await link().call('get_session', {})).toBe(NOT_TRUSTED);
    expect(got.every((line) => (JSON.parse(line) as { t: string }).t === 'hello')).toBe(true);
  });
});

describe.runIf(onWindows)('the app and what connects to its pipe', () => {
  const hello = () => lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce: newSecret() });

  it('says nothing before it is greeted, and ends a connection that does not prove itself in time', async () => {
    const { pipe } = await listen();
    const quiet = await raw(pipe);
    await until(quiet.closed);
    expect(quiet.lines).toEqual([]);

    // Greeted, it proves itself; without the answer to that, the connection ends too.
    const half = await raw(pipe);
    half.socket.write(hello());
    await until(() => half.lines.length === 1);
    expect(JSON.parse(half.lines[0] ?? '')).toMatchObject({
      t: 'hello',
      protocol: BRIDGE_PROTOCOL,
    });
    await until(half.closed);
    expect(calls).toEqual([]);
    expect(connected).toEqual([]);
  });

  it('takes no call from a connection that has not proved itself', async () => {
    const { pipe } = await listen();
    const first = await raw(pipe);
    first.socket.write(lineOf({ t: 'call', id: 1, name: 'get_session', input: {} }));
    await until(first.closed);

    const second = await raw(pipe);
    second.socket.write(hello());
    await until(() => second.lines.length === 1);
    second.socket.write(lineOf({ t: 'call', id: 1, name: 'get_session', input: {} }));
    await until(second.closed);

    expect(first.lines).toEqual([]);
    expect(second.lines).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('turns away a proof that is not made with the key, and says only that', async () => {
    const { pipe } = await listen();
    const wrong = await raw(pipe);
    const nonce = newSecret();
    wrong.socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    await until(() => wrong.lines.length === 1);
    const greeted = JSON.parse(wrong.lines[0] ?? '') as { nonce: string; proof: string };
    // The proof the app just gave, sent back as its own.
    wrong.socket.write(
      lineOf({ t: 'auth', proof: greeted.proof, client: { name: 'x', version: '1' } }),
    );
    await until(wrong.closed);
    expect(wrong.lines[1]).toBe('{"t":"refused","why":"proof"}');
    expect(connected).toEqual([]);
  });

  it('turns away another wording of the protocol', async () => {
    const { pipe } = await listen();
    const other = await raw(pipe);
    other.socket.write(lineOf({ t: 'hello', protocol: 2, nonce: newSecret() }));
    await until(other.closed);
    expect(other.lines).toEqual(['{"t":"refused","why":"protocol"}']);
  });

  it('ends a connection that sends what is no message, or a line that is too long', async () => {
    const { pipe } = await listen();
    for (const sent of [
      'not json\n',
      '{"t":"hello"}\n',
      '{"t":"ready"}\n',
      'a'.repeat(LINE_MAX + 10),
    ]) {
      const one = await raw(pipe);
      one.socket.write(sent);
      await until(one.closed, 5000);
      expect(one.lines).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('lets only so many wait to prove themselves at once', async () => {
    const { pipe } = await listen();
    const waiting: Awaited<ReturnType<typeof raw>>[] = [];
    for (let index = 0; index < AI_BRIDGE_WAITING; index += 1) waiting.push(await raw(pipe));
    const extra = await raw(pipe);
    await until(extra.closed);
    // Those that wait are ended in their turn, and a bridge gets through again.
    await until(() => waiting.every((one) => one.closed()));
    expect((await link().call('get_session', {})).ok).toBe(true);
  });

  it('ends a proved connection that sends anything but a call', async () => {
    const { pipe, key } = await listen();
    const one = await raw(pipe);
    const nonce = newSecret();
    one.socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    await until(() => one.lines.length === 1);
    const greeted = JSON.parse(one.lines[0] ?? '') as { nonce: string };
    one.socket.write(
      lineOf({
        t: 'auth',
        proof: proofOf(key, 'bridge', pipe, nonce, greeted.nonce),
        client: { name: 'by hand', version: '' },
      }),
    );
    await until(() => one.lines.length === 2);
    expect(one.lines[1]).toBe('{"t":"ready"}');
    one.socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    await until(one.closed);
    await until(() => bridge.state().clients.length === 0);
  });
});

describe.runIf(onWindows)('the bridge as an AI app sees it', () => {
  const client = async (app: AppLink): Promise<Client> => {
    const [near, far] = InMemoryTransport.createLinkedPair();
    const server = createBridgeServer(app, '9.9.9');
    await server.connect(far);
    const made = new Client({ name: 'an AI app', version: '4.5.6' });
    await made.connect(near);
    return made;
  };

  it('lists the tools and the instructions whether or not the app is open', async () => {
    const ai = await client(link());
    expect(ai.getServerVersion()).toMatchObject({ name: 'rulz-kinspora', version: '9.9.9' });
    expect(ai.getInstructions()).toContain('call get_session first');
    const { tools } = await ai.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(AI_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.annotations).toEqual({ destructiveHint: false });
    }
    expect((await ai.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      RESEARCH_PROMPT_NAME,
    ]);
    const prompt = await ai.getPrompt({ name: RESEARCH_PROMPT_NAME });
    expect(prompt.messages).toEqual([
      { role: 'user', content: { type: 'text', text: RESEARCH_PROMPT } },
    ]);
    await expect(ai.getPrompt({ name: 'another' })).rejects.toThrow();
  });

  it('answers a call outside a session with what the user has to do', async () => {
    const ai = await client(link());
    const result = await ai.callTool({ name: 'get_session', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ reason: 'no-session', message: NOT_UNDER_WAY.message }),
      },
    ]);
    expect(NOT_UNDER_WAY.message).toContain('start a session');
  });

  it('hands a call to the session with what was sent, as it came, and says who it is', async () => {
    await listen();
    const made = new AppLink({ profileDir: dir, client: () => clientOf(server), handshakeMs: 500 });
    links.push(made);
    const [near, far] = InMemoryTransport.createLinkedPair();
    const server = createBridgeServer(made, '9.9.9');
    await server.connect(far);
    const ai = new Client({ name: 'an AI app', version: '4.5.6' });
    await ai.connect(near);

    const sent = { personId: 'p1', extra: ['not', 'what', 'the tool takes'] };
    const result = await ai.callTool({ name: 'get_person', arguments: sent });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: '{"tool":"get_person"}' }]);
    // A tool the bridge does not list goes to the session too, which counts and refuses it.
    await ai.callTool({ name: 'delete_tree', arguments: {} });
    expect(calls).toEqual([
      { name: 'get_person', input: sent },
      { name: 'delete_tree', input: {} },
    ]);
    expect(connected).toEqual([{ name: 'an AI app', version: '4.5.6', since: 1_000 }]);
  });

  it('passes a refusal on as an error with its reason and its words', async () => {
    await listen();
    answer = () =>
      Promise.resolve({
        ok: false,
        reason: 'query',
        message: 'The year is too far off.',
        detail: { year: 1700 },
      });
    const ai = await client(link());
    const result = await ai.callTool({ name: 'search_records', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '')).toEqual({
      reason: 'query',
      message: 'The year is too far off.',
      detail: { year: 1700 },
    });
  });
});

describe.runIf(onWindows)('what the reviews of the pipe asked for', () => {
  it('lets a bridge in when every place to wait is held by connections that say nothing', async () => {
    const written = await listen();
    const silent: Awaited<ReturnType<typeof raw>>[] = [];
    for (let index = 0; index < AI_BRIDGE_WAITING; index += 1) silent.push(await raw(written.pipe));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The bridge takes the place of the oldest of them.
    expect((await link().call('get_session', {})).ok).toBe(true);
    await until(() => silent[0]?.closed() === true);
    expect(silent[1]?.closed()).toBe(false);
  });

  it('ends a connection that sends no greeting, sooner than one that is on its way', async () => {
    const slow = new AiBridgeServer({ dir, call: () => answer('', {}), handshakeMs: 60_000 });
    try {
      slow.open();
      await until(() => slow.state().open);
      const quiet = await raw(file().pipe);
      const began = Date.now();
      await until(() => quiet.closed(), AI_BRIDGE_HELLO_MS + 2000);
      expect(Date.now() - began).toBeLessThan(AI_BRIDGE_HELLO_MS + 2000);
    } finally {
      slow.close();
    }
  });

  it('reads nothing more of a connection it turned away', async () => {
    const written = await listen();
    const other = await raw(written.pipe);
    const nonce = newSecret();
    other.socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    await until(() => other.lines.length === 1);
    const hello = JSON.parse(other.lines[0] ?? '{}') as { nonce: string };
    const client = { name: 'twice', version: '1' };
    other.socket.write(
      lineOf({
        t: 'auth',
        proof: proofOf(newSecret(), 'bridge', written.pipe, nonce, hello.nonce),
        client,
      }),
    );
    // The right proof, sent after the wrong one, opens nothing.
    other.socket.write(
      lineOf({
        t: 'auth',
        proof: proofOf(written.key, 'bridge', written.pipe, nonce, hello.nonce),
        client,
      }),
    );
    await until(() => other.closed());
    expect(connected).toEqual([]);
    expect(other.lines[1]).toBe(lineOf({ t: 'refused', why: 'proof' }).trim());
  });

  it('answers a call the app would end the connection for by itself, and the connection stays', async () => {
    await listen();
    const app = link();
    expect((await app.call('get_session', {})).ok).toBe(true);
    expect(await app.call('x'.repeat(101), {})).toBe(NO_SUCH_TOOL);
    expect(await app.call('get_record', { ref: 'a'.repeat(LINE_MAX) })).toBe(TOO_LONG);
    expect(calls).toHaveLength(1);
    expect((await app.call('get_session', {})).ok).toBe(true);
    expect(connected).toHaveLength(1);
  });

  it('does not say "start a session" when something is there and does not answer', async () => {
    const pipe = newPipeName();
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(pipe, () => resolve()));
    writeFileSync(
      join(dir, CONNECTOR_FILE),
      JSON.stringify({ protocol: BRIDGE_PROTOCOL, pipe, key: newSecret() }),
    );
    expect(await link().call('get_session', {})).toBe(NOT_REACHED);
    expect(NOT_REACHED.message).not.toContain('start a session there');
  });

  it('ends a connection that reads none of its answers', async () => {
    const written = await listen();
    answer = () => Promise.resolve({ ok: true, value: 'a'.repeat(LINE_MAX - 4096) });
    const other = await raw(written.pipe);
    const nonce = newSecret();
    other.socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
    await until(() => other.lines.length === 1);
    const hello = JSON.parse(other.lines[0] ?? '{}') as { nonce: string };
    other.socket.write(
      lineOf({
        t: 'auth',
        proof: proofOf(written.key, 'bridge', written.pipe, nonce, hello.nonce),
        client: { name: 'deaf', version: '1' },
      }),
    );
    await until(() => other.lines.length === 2);
    other.socket.pause();
    let id = 0;
    const ask = setInterval(() => {
      id += 1;
      if (!other.socket.destroyed) {
        other.socket.write(lineOf({ t: 'call', id, name: 'get_record', input: {} }));
      }
    }, 5);
    try {
      await until(() => bridge.state().clients.length === 0, 10_000);
    } finally {
      clearInterval(ask);
    }
    // It was ended long before it had asked without end.
    expect(AI_BRIDGE_UNREAD_MAX).toBeLessThan(calls.length * LINE_MAX);
  });
});
