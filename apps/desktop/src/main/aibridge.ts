import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { AiToolResult } from '@rulz/ai';
import { cleanText } from '@rulz/connectors';
import {
  BRIDGE_PROTOCOL,
  CONNECTOR_FILE,
  HANDSHAKE_MS,
  LINE_MAX,
  LineReader,
  fromBridgeSchema,
  lineOf,
  messageOf,
  newPipeName,
  newSecret,
  proofOf,
  sameProof,
  type ConnectorFile,
  type FromApp,
  type Refusal,
} from '../bridge/protocol';
import type { AiClientInfo, AiConnectionInfo } from '../shared/ipc';

/**
 * Where an AI app reaches a session of the AI assistant: a named pipe of
 * this PC, on which the app's main process listens **only while a session is
 * under way**. The bridge an AI app starts connects to it and hands over
 * each call of a tool; the tools run here, in the main process, as they do
 * for every other route. See `../bridge/protocol.ts` for what is said on the
 * pipe and how each side proves itself.
 *
 * Each session gets a new key and a new name for the pipe, which are written
 * to a file in the app's data folder when the app listens and removed when
 * the session ends. Outside a session there is no pipe, no key and no file.
 *
 * **Who can open the pipe.** Node gives no say over the access rights of a
 * pipe it makes. Windows then lets the account that made it, administrators
 * and the system read and write, and everyone else read only (looked at on
 * 2026-11-14: `D:(A;;FR;;;WD)(A;;FR;;;AN)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)`).
 * So another account, on this PC or over the network, could open the pipe
 * but could send nothing on it, and the app says nothing on a connection
 * before it was sent a greeting. Whoever can write must still prove that it
 * holds the key. A connection that has not done so within
 * {@link HANDSHAKE_MS} is ended, and one that has sent no greeting within
 * {@link AI_BRIDGE_HELLO_MS} is ended sooner. Only so many may wait at once.
 * When they are that many, a new connection takes the place of the oldest
 * one that has sent nothing: so whoever can only open the pipe cannot keep
 * the bridge out by holding every place.
 *
 * Nothing here uses Electron.
 */

/** How many programs may be connected at once, each having proved itself. */
export const AI_BRIDGE_CLIENTS = 4;

/** How many connections may be on their way to proving themselves at once. */
export const AI_BRIDGE_WAITING = 4;

/** How long a connection may take to send its greeting, in milliseconds. The bridge sends it at once. */
export const AI_BRIDGE_HELLO_MS = 1000;

/** How many calls one connection may have under way at once. */
export const AI_BRIDGE_CALLS = 4;

/**
 * How much the app keeps for one connection that does not read what it is
 * sent, in bytes. Beyond it the connection is ended: a program that calls
 * and never reads cannot make the app hold answers without end.
 */
export const AI_BRIDGE_UNREAD_MAX = 4 * 1024 * 1024;

/** How often a new name is tried when a pipe cannot be made. */
const LISTEN_TRIES = 3;

const NOT_OPEN =
  'The connection for an AI app could not be opened on this PC, so no AI app can reach this session. Stop the session and start another one.';

/** What a session needs of whatever lets an AI app reach it. */
export interface AiBridge {
  /** Starts listening, for a session that has just started. */
  open(): void;
  /** Stops listening and ends every connection. */
  close(): void;
  /** How the connection stands, for the page. */
  state(): AiConnectionInfo;
  /** Who is told when a program has connected and proved itself. */
  onClient(listener: (client: AiClientInfo) => void): void;
  /** Who is told when anything of {@link state} changed. */
  onChange(listener: () => void): void;
}

export interface AiBridgeOptions {
  /** The folder the file for the bridge is written to: the app's own data folder. */
  dir: string;
  /** Takes one call of a tool; the session's `call`. */
  call: (name: string, input: unknown) => Promise<AiToolResult>;
  now?: () => number;
  /** How long a connection may take to prove itself; replaceable in tests. */
  handshakeMs?: number;
}

interface Connection {
  socket: Socket;
  /** 'over' once it was turned away: nothing it sends is read any more. */
  stage: 'hello' | 'auth' | 'ready' | 'over';
  /** Ends the connection when no greeting came in time. */
  mute: NodeJS.Timeout | null;
  bridgeNonce: string;
  appNonce: string;
  client: AiClientInfo | null;
  calls: number;
}

interface Listening {
  server: Server;
  pipe: string;
  key: string;
  connections: Set<Connection>;
}

const failed = (message: string): AiToolResult => ({ ok: false, reason: 'failed', message });

export class AiBridgeServer implements AiBridge {
  readonly #file: string;
  readonly #dir: string;
  readonly #call: (name: string, input: unknown) => Promise<AiToolResult>;
  readonly #now: () => number;
  readonly #handshakeMs: number;
  /** Goes up with every `open` and `close`, so that a pipe that comes up late is known as stale. */
  #turn = 0;
  #listening: Listening | null = null;
  #problem = '';
  #clientListener: (client: AiClientInfo) => void = () => undefined;
  #changeListener: () => void = () => undefined;

  constructor(options: AiBridgeOptions) {
    this.#dir = options.dir;
    this.#file = join(options.dir, CONNECTOR_FILE);
    this.#call = options.call;
    this.#now = options.now ?? Date.now;
    this.#handshakeMs = options.handshakeMs ?? HANDSHAKE_MS;
  }

  onClient(listener: (client: AiClientInfo) => void): void {
    this.#clientListener = listener;
  }

  onChange(listener: () => void): void {
    this.#changeListener = listener;
  }

  /** The name of the pipe while the app listens; null otherwise. For tests. */
  get pipe(): string | null {
    return this.#listening?.pipe ?? null;
  }

  state(): AiConnectionInfo {
    const listening = this.#listening;
    return {
      open: listening !== null,
      problem: this.#problem,
      clients:
        listening === null
          ? []
          : [...listening.connections].flatMap((connection) =>
              connection.client === null ? [] : [{ ...connection.client }],
            ),
    };
  }

  open(): void {
    this.close();
    this.#listen(this.#turn, LISTEN_TRIES);
  }

  close(): void {
    this.#turn += 1;
    const hadProblem = this.#problem !== '';
    this.#problem = '';
    // The file goes first, so that no bridge is sent to a pipe that is about to go.
    this.forgetFile();
    const listening = this.#listening;
    if (listening === null) {
      if (hadProblem) this.#changeListener();
      return;
    }
    this.#listening = null;
    for (const connection of listening.connections) connection.socket.destroy();
    listening.connections.clear();
    listening.server.close();
    this.#changeListener();
  }

  /** Removes the file for the bridge. Also for the start of the app: one may be left from a run that was ended by force. */
  forgetFile(): void {
    try {
      rmSync(this.#file, { force: true });
      // And a draft of it, where writing it was cut short.
      rmSync(`${this.#file}.new`, { force: true });
    } catch {
      // It names a pipe that is gone, and a key that proves nothing to anyone.
    }
  }

  #listen(turn: number, triesLeft: number): void {
    const pipe = newPipeName();
    const key = newSecret();
    const listening: Listening = { server: createServer(), pipe, key, connections: new Set() };
    const { server } = listening;
    const giveUp = (): void => {
      if (turn !== this.#turn) return;
      if (triesLeft > 1) {
        this.#listen(turn, triesLeft - 1);
      } else {
        this.#problem = NOT_OPEN;
        this.#changeListener();
      }
    };
    server.on('connection', (socket) => this.#take(listening, socket));
    server.once('error', giveUp);
    server.listen(pipe, () => {
      server.off('error', giveUp);
      // An error of a server that listens ends nothing: a connection that fails says so itself.
      server.on('error', () => undefined);
      if (turn !== this.#turn) {
        server.close();
        return;
      }
      try {
        this.#writeFile({ protocol: BRIDGE_PROTOCOL, pipe, key });
      } catch {
        server.close();
        this.#problem = NOT_OPEN;
        this.#changeListener();
        return;
      }
      this.#listening = listening;
      this.#changeListener();
    });
  }

  /** Writes the file whole or not at all: under another name first, then in its place. */
  #writeFile(file: ConnectorFile): void {
    mkdirSync(this.#dir, { recursive: true });
    const draft = `${this.#file}.new`;
    writeFileSync(draft, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(draft, this.#file);
  }

  #take(listening: Listening, socket: Socket): void {
    if (this.#listening !== listening) {
      socket.destroy();
      return;
    }
    const waiting = [...listening.connections].filter(
      (other) => other.stage === 'hello' || other.stage === 'auth',
    );
    if (waiting.length >= AI_BRIDGE_WAITING) {
      // The oldest one that has said nothing makes room. Where every one has
      // sent a greeting, each can write to the pipe, and the new one waits.
      const silent = waiting.find((other) => other.stage === 'hello');
      if (silent === undefined) {
        socket.destroy();
        return;
      }
      listening.connections.delete(silent);
      silent.socket.destroy();
    }
    const connection: Connection = {
      socket,
      stage: 'hello',
      mute: null,
      bridgeNonce: '',
      appNonce: '',
      client: null,
      calls: 0,
    };
    listening.connections.add(connection);
    const reader = new LineReader();
    const late = setTimeout(() => socket.destroy(), this.#handshakeMs);
    connection.mute = setTimeout(
      () => socket.destroy(),
      Math.min(this.#handshakeMs, AI_BRIDGE_HELLO_MS),
    );
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(late);
      if (connection.mute !== null) clearTimeout(connection.mute);
      if (listening.connections.delete(connection) && connection.client !== null) {
        this.#changeListener();
      }
    });
    socket.on('data', (chunk: Buffer) => {
      const lines = reader.push(chunk);
      if (lines === 'too-long') {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        if (socket.destroyed || connection.stage === 'over' || this.#listening !== listening) {
          return;
        }
        this.#read(listening, connection, line, late);
      }
    });
  }

  #send(connection: Connection, message: FromApp): void {
    this.#write(connection, lineOf(message));
  }

  /** Sends a line, unless the other side has left too much unread: then the connection ends. */
  #write(connection: Connection, line: string): void {
    const { socket } = connection;
    if (socket.destroyed) return;
    if (socket.writableLength > AI_BRIDGE_UNREAD_MAX) {
      socket.destroy();
      return;
    }
    socket.write(line);
  }

  #refuse(connection: Connection, why: Refusal): void {
    connection.stage = 'over';
    if (!connection.socket.destroyed) connection.socket.end(lineOf({ t: 'refused', why }));
  }

  #read(listening: Listening, connection: Connection, line: string, late: NodeJS.Timeout): void {
    const message = messageOf(fromBridgeSchema, line);
    // Anything that is not the next message of the exchange ends the connection, without a word.
    if (message === null) {
      connection.socket.destroy();
      return;
    }
    if (connection.stage === 'hello') {
      if (connection.mute !== null) clearTimeout(connection.mute);
      connection.mute = null;
      if (message.t !== 'hello') {
        connection.socket.destroy();
      } else if (message.protocol !== BRIDGE_PROTOCOL) {
        this.#refuse(connection, 'protocol');
      } else {
        connection.bridgeNonce = message.nonce;
        connection.appNonce = newSecret();
        connection.stage = 'auth';
        this.#send(connection, {
          t: 'hello',
          protocol: BRIDGE_PROTOCOL,
          nonce: connection.appNonce,
          proof: proofOf(
            listening.key,
            'app',
            listening.pipe,
            connection.bridgeNonce,
            connection.appNonce,
          ),
        });
      }
      return;
    }
    if (connection.stage === 'auth') {
      const expected = proofOf(
        listening.key,
        'bridge',
        listening.pipe,
        connection.bridgeNonce,
        connection.appNonce,
      );
      if (message.t !== 'auth') {
        connection.socket.destroy();
      } else if (!sameProof(message.proof, expected)) {
        this.#refuse(connection, 'proof');
      } else if (
        [...listening.connections].filter((other) => other.stage === 'ready').length >=
        AI_BRIDGE_CLIENTS
      ) {
        this.#refuse(connection, 'busy');
      } else {
        clearTimeout(late);
        connection.stage = 'ready';
        // The name is that program's own word, cleaned to one short line.
        connection.client = {
          name: cleanText(message.client.name, 60),
          version: cleanText(message.client.version, 30),
          since: this.#now(),
        };
        this.#send(connection, { t: 'ready' });
        this.#clientListener({ ...connection.client });
        this.#changeListener();
      }
      return;
    }
    if (message.t !== 'call') {
      connection.socket.destroy();
      return;
    }
    const { id } = message;
    if (connection.calls >= AI_BRIDGE_CALLS) {
      this.#send(connection, {
        t: 'result',
        id,
        result: failed('Too many calls at once. Wait for an answer before the next call.'),
      });
      return;
    }
    connection.calls += 1;
    void Promise.resolve()
      .then(() => this.#call(message.name, message.input))
      .catch(() => failed('The call failed.'))
      .then((result) => {
        connection.calls -= 1;
        let answer = lineOf({ t: 'result', id, result });
        if (Buffer.byteLength(answer, 'utf8') > LINE_MAX) {
          answer = lineOf({
            t: 'result',
            id,
            result: failed('The answer was too long to pass on.'),
          });
        }
        this.#write(connection, answer);
      });
  }
}
