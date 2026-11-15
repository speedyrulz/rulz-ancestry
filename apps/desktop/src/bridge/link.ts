import { readFileSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  BRIDGE_PROTOCOL,
  CONNECTOR_FILE,
  HANDSHAKE_MS,
  LINE_MAX,
  LineReader,
  fromAppSchema,
  lineOf,
  messageOf,
  newSecret,
  parseConnectorFile,
  proofOf,
  sameProof,
  type BridgeClient,
  type FromApp,
} from './protocol';

/**
 * The bridge's side of the pipe to the app. It reads the file the app wrote
 * for the session that is under way, connects to the pipe that file names,
 * makes the app prove that it holds the key, proves the same of itself, and
 * then hands over calls of tools and takes their answers.
 *
 * Nothing is sent to anything that has not proved itself to be the app, and
 * the key is never sent at all. A call is handed over once: one that may
 * have reached the app is never sent a second time, since a question to a
 * source is counted when it leaves. Connecting itself is tried twice, since
 * a session can start between reading the file and reaching the pipe.
 *
 * Every way this can fail is an answer in words an AI can pass on to the
 * user. Nothing here starts the app.
 */

/** What a call comes back with: what the session answered, or why nothing reached it. */
export type LinkResult = { ok: true; value: unknown } | LinkRefusal;

/** Why a call was given nothing, in words an AI can pass on. */
export interface LinkRefusal {
  ok: false;
  reason: string;
  message: string;
  detail?: unknown;
}

const refusal = (reason: string, message: string): LinkRefusal => ({ ok: false, reason, message });

export const NOT_UNDER_WAY = refusal(
  'no-session',
  'No session of the AI assistant is under way in RulZ Ancestry, or RulZ Ancestry is not open. Nothing can be read or asked now. Ask the user to open RulZ Ancestry, open the page of a person, press "AI assistant" and start a session there. Then call get_session.',
);

export const NOT_REACHED = refusal(
  'failed',
  'RulZ Ancestry did not answer on the connection of its session, so nothing was sent. The session may have just ended, or the app may be busy. Call get_session once more. If this goes on, ask the user to stop the session in RulZ Ancestry and to start a new one.',
);

export const NO_SUCH_TOOL = refusal('unknown-tool', 'There is no tool of this name.');

export const TOO_LONG = refusal(
  'input',
  'What was sent with this call is too long to pass on. Nothing was sent.',
);

export const NOT_FITTING = refusal(
  'failed',
  'This connector and the copy of RulZ Ancestry on this PC do not fit together: one of them is older than the other. Ask the user to open the window "AI assistant" in RulZ Ancestry and to install the connector from there again.',
);

export const NOT_TRUSTED = refusal(
  'failed',
  'What answered in the place of RulZ Ancestry did not show that it is the app, or the app did not accept this connector, so nothing was sent. Ask the user to stop the session in RulZ Ancestry and to start a new one.',
);

export const TOO_MANY = refusal(
  'failed',
  'Too many programs are connected to this session of RulZ Ancestry already. Ask the user to close an AI app they do not use, or to stop the session and start a new one.',
);

export const CUT_OFF = refusal(
  'failed',
  'The connection to RulZ Ancestry ended while this call was under way: the session ended, or the app was closed. If this was a question to a source, it may have been sent and counted all the same. Do not repeat it; call get_session to see how the session stands.',
);

/** The file of the app is a few hundred bytes. A larger one is not read. */
const FILE_MAX = 4096;

/** How long the second try to connect waits, in milliseconds. */
const RETRY_MS = 300;

export interface AppLinkOptions {
  /** The app's data folder, where it writes the file for the bridge. */
  profileDir: string;
  /** What the program on the other side of the bridge calls itself, asked when a connection is made. */
  client: () => BridgeClient;
  /** How long the app may take to prove itself; replaceable in tests. */
  handshakeMs?: number;
}

interface Open {
  socket: Socket;
  pending: Map<number, (result: LinkResult) => void>;
}

export class AppLink {
  readonly #file: string;
  readonly #client: () => BridgeClient;
  readonly #handshakeMs: number;
  #open: Open | null = null;
  #opening: Promise<Open | LinkResult> | null = null;
  #lastId = 0;
  #closed = false;

  constructor(options: AppLinkOptions) {
    this.#file = join(options.profileDir, CONNECTOR_FILE);
    this.#client = options.client;
    this.#handshakeMs = options.handshakeMs ?? HANDSHAKE_MS;
  }

  /** One call of a tool, handed to the session the user started in the app. */
  async call(name: string, input: unknown): Promise<LinkResult> {
    if (this.#closed) return NOT_UNDER_WAY;
    // The app ends a connection that sends what a message may not hold, and
    // every other call under way with it. So such a call is answered here.
    if (name.length > 100) return NO_SUCH_TOOL;
    let sized: string | undefined;
    try {
      sized = JSON.stringify(input);
    } catch {
      return TOO_LONG;
    }
    if (Buffer.byteLength(sized ?? '', 'utf8') > LINE_MAX - 1024) return TOO_LONG;
    const open = await this.#ready();
    if (!('socket' in open)) return open;
    if (this.#closed) {
      // Closed while the connection was being made: nothing is sent on it.
      open.socket.destroy();
      return NOT_UNDER_WAY;
    }
    this.#lastId += 1;
    const id = this.#lastId;
    return new Promise<LinkResult>((resolve) => {
      open.pending.set(id, resolve);
      if (open.socket.destroyed) {
        open.pending.delete(id);
        // The connection went before this call was written, so it was not sent.
        resolve(NOT_REACHED);
        return;
      }
      open.socket.write(lineOf({ t: 'call', id, name, input }));
    });
  }

  /** Ends the connection. For when the AI app has gone. */
  close(): void {
    this.#closed = true;
    this.#open?.socket.destroy();
  }

  /** What the other program calls itself, cut to what a message may hold. */
  #named(): BridgeClient {
    const { name, version } = this.#client();
    return { name: name.slice(0, 200), version: version.slice(0, 100) };
  }

  #ready(): Promise<Open | LinkResult> {
    if (this.#open !== null) return Promise.resolve(this.#open);
    this.#opening ??= this.#connectTwice().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #connectTwice(): Promise<Open | LinkResult> {
    const first = await this.#connect();
    // Nothing was handed over yet, so trying again repeats nothing. A
    // connector that does not fit will not fit a moment later either.
    if ('socket' in first || first === NOT_FITTING || first === TOO_MANY) return first;
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    return this.#connect();
  }

  #connect(): Promise<Open | LinkResult> {
    let text: string;
    try {
      if (statSync(this.#file).size > FILE_MAX) return Promise.resolve(NOT_UNDER_WAY);
      text = readFileSync(this.#file, 'utf8');
    } catch {
      return Promise.resolve(NOT_UNDER_WAY);
    }
    // A file that is not what the app writes names nothing this program connects to.
    const file = parseConnectorFile(text);
    if (file === null) return Promise.resolve(NOT_UNDER_WAY);
    if (file.protocol !== BRIDGE_PROTOCOL) return Promise.resolve(NOT_FITTING);

    return new Promise<Open | LinkResult>((resolve) => {
      const socket = connect(file.pipe);
      const reader = new LineReader();
      const pending = new Map<number, (result: LinkResult) => void>();
      const nonce = newSecret();
      let stage: 'hello' | 'ready' | 'open' | 'over' = 'hello';
      let connected = false;
      let settled = false;
      const settle = (result: Open | LinkResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(late);
        resolve(result);
      };
      const giveUp = (result: LinkResult): void => {
        stage = 'over';
        socket.destroy();
        settle(result);
      };
      const late = setTimeout(() => giveUp(NOT_REACHED), this.#handshakeMs);

      const read = (message: FromApp | null): void => {
        // Anything that is not the next message of the exchange ends it.
        if (message === null) {
          giveUp(NOT_TRUSTED);
          socket.destroy();
          return;
        }
        if (message.t === 'refused') {
          giveUp(
            message.why === 'protocol'
              ? NOT_FITTING
              : message.why === 'busy'
                ? TOO_MANY
                : NOT_TRUSTED,
          );
          return;
        }
        if (stage === 'hello') {
          if (
            message.t !== 'hello' ||
            !sameProof(message.proof, proofOf(file.key, 'app', file.pipe, nonce, message.nonce))
          ) {
            giveUp(NOT_TRUSTED);
            return;
          }
          if (message.protocol !== BRIDGE_PROTOCOL) {
            giveUp(NOT_FITTING);
            return;
          }
          stage = 'ready';
          socket.write(
            lineOf({
              t: 'auth',
              proof: proofOf(file.key, 'bridge', file.pipe, nonce, message.nonce),
              client: this.#named(),
            }),
          );
          return;
        }
        if (stage === 'ready') {
          if (message.t !== 'ready') {
            giveUp(NOT_TRUSTED);
            return;
          }
          stage = 'open';
          const open: Open = { socket, pending };
          this.#open = open;
          settle(open);
          return;
        }
        if (message.t !== 'result') {
          socket.destroy();
          return;
        }
        const answer = pending.get(message.id);
        pending.delete(message.id);
        answer?.(message.result);
      };

      socket.on('connect', () => {
        connected = true;
        socket.write(lineOf({ t: 'hello', protocol: BRIDGE_PROTOCOL, nonce }));
      });
      socket.on('data', (chunk: Buffer) => {
        const lines = reader.push(chunk);
        if (lines === 'too-long') {
          socket.destroy();
          return;
        }
        for (const line of lines) {
          if (stage === 'over' || socket.destroyed) return;
          read(messageOf(fromAppSchema, line));
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        if (this.#open?.socket === socket) this.#open = null;
        // A pipe that is not there: the file is left from a session that is
        // gone. One that was there and went before the app had proved itself
        // is another matter, and is not answered with "start a session".
        settle(connected ? NOT_REACHED : NOT_UNDER_WAY);
        for (const answer of pending.values()) answer(CUT_OFF);
        pending.clear();
      });
    });
  }
}
