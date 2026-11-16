import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * What the app and its bridge say to each other. The bridge is the small
 * program an AI app starts (see `index.ts` beside this file); the app's main
 * process listens on a named pipe of this PC while a session of the AI
 * assistant is under way (`main/aibridge.ts`). Both sides use this file, so
 * neither can drift from the other within one build.
 *
 * **Finding each other.** When a session starts, the app makes a new key and
 * a new name for the pipe, listens, and writes both to a file in its own
 * data folder ({@link CONNECTOR_FILE}). The file is gone again when the
 * session ends. The bridge reads it before it connects.
 *
 * **Proving themselves.** The key never goes over the pipe. Each side sends
 * a number it made up for this connection, and each proves with a keyed hash
 * over both numbers and the name of the pipe that it holds the key: the app
 * first, then the bridge. A program that made a pipe of that name first, to
 * be taken for the app, therefore learns nothing it can use, and the bridge
 * sends it no call. A proof is of no use on another connection, since both
 * numbers are new each time.
 *
 * **What this does not keep out.** A program that runs under the same
 * Windows account can read the file, as it can read the tree itself, and can
 * then call the tools during a session as an AI app can. Nothing here can
 * prevent that, and the notice of the assistant says so.
 *
 * **Framing.** One JSON value on a line, UTF-8, a line feed after it. A line
 * longer than {@link LINE_MAX} bytes ends the connection.
 */

/** The wording of this protocol. Each side refuses one it does not speak. */
export const BRIDGE_PROTOCOL = 1;

/** The file in the app's data folder that says where the app listens, while a session is under way. */
export const CONNECTOR_FILE = 'ai-connector.json';

/** The environment variable that names the app's data folder to a bridge, where it is not the usual one. */
export const PROFILE_ENV = 'RULZ_KINSPORA_PROFILE';
export const LEGACY_PROFILE_ENV = 'RULZ_ANCESTRY_PROFILE';

/** The longest line either side takes, in bytes. */
export const LINE_MAX = 1024 * 1024;

/** How long a connection may take to prove itself, in milliseconds. */
export const HANDSHAKE_MS = 5000;

/** The key, in bytes. */
export const KEY_BYTES = 32;

// The pipe prefix and handshake deliberately retain the old name for compatibility.
const PIPE_PREFIX = '\\\\.\\pipe\\rulz-ancestry-';

/**
 * A pipe of this PC as the app names one. A bridge connects to nothing else:
 * not to a pipe of another PC, and not to a path of a file, whatever the
 * file it read says.
 */
const PIPE_NAME = /^\\\\\.\\pipe\\rulz-ancestry-[0-9a-f]{32}$/;

/** 32 bytes in base64, as a key and a number of a connection are written. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

/** A new name for the pipe, which nothing can guess. */
export function newPipeName(): string {
  return PIPE_PREFIX + randomBytes(16).toString('hex');
}

/** A new key, or a new number for one connection. */
export function newSecret(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

const connectorFileSchema = z.strictObject({
  protocol: z.number().int().min(1).max(1_000_000),
  pipe: z.string().regex(PIPE_NAME),
  key: z.string().regex(BASE64_32),
});

/** What {@link CONNECTOR_FILE} holds. */
export type ConnectorFile = z.infer<typeof connectorFileSchema>;

/** Reads the text of the file; null when it is not what the app writes. */
export function parseConnectorFile(text: string): ConnectorFile | null {
  try {
    const parsed = connectorFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The proof of one side for one connection: a keyed hash that only a holder
 * of the key can make. The side is part of it, so the proof of the app
 * cannot be sent back as the proof of the bridge.
 */
export function proofOf(
  key: string,
  side: 'app' | 'bridge',
  pipe: string,
  bridgeNonce: string,
  appNonce: string,
): string {
  return createHmac('sha256', Buffer.from(key, 'base64'))
    .update(
      `rulz-ancestry bridge ${BRIDGE_PROTOCOL}\n${side}\n${pipe}\n${bridgeNonce}\n${appNonce}`,
    )
    .digest('base64');
}

/** Whether two proofs are the same, compared in a time that does not depend on where they differ. */
export function sameProof(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const nonce = z.string().regex(BASE64_32);
const proof = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/** What the program that speaks to the bridge calls itself. It is that program's own word. */
const clientSchema = z.strictObject({
  name: z.string().max(200),
  version: z.string().max(100),
});
export type BridgeClient = z.infer<typeof clientSchema>;

/** What a bridge sends. */
export const fromBridgeSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), protocol: z.number().int(), nonce }),
  z.strictObject({ t: z.literal('auth'), proof, client: clientSchema }),
  z.strictObject({
    t: z.literal('call'),
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    name: z.string().max(100),
    input: z.unknown(),
  }),
]);
export type FromBridge = z.infer<typeof fromBridgeSchema>;

/** Why the app turned a connection away. */
export type Refusal = 'protocol' | 'proof' | 'busy';

/** What the app sends. The answer of a tool is plain data, as the session gave it. */
export const fromAppSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), protocol: z.number().int(), nonce, proof }),
  z.strictObject({ t: z.literal('refused'), why: z.enum(['protocol', 'proof', 'busy']) }),
  z.strictObject({ t: z.literal('ready') }),
  z.strictObject({
    t: z.literal('result'),
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    result: z.union([
      z.strictObject({ ok: z.literal(true), value: z.unknown() }),
      z.strictObject({
        ok: z.literal(false),
        reason: z.string().max(100),
        message: z.string().max(10_000),
        detail: z.unknown().optional(),
      }),
    ]),
  }),
]);
export type FromApp = z.infer<typeof fromAppSchema>;

/** One message as a line. */
export function lineOf(message: FromBridge | FromApp): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Cuts what arrives into lines. A line is handed on once its line feed has
 * come; what is left waits for more. Nothing is kept beyond {@link LINE_MAX}
 * bytes: `push` then says `'too-long'`, and the connection is to be ended.
 */
export class LineReader {
  #kept: Buffer[] = [];
  #size = 0;

  push(chunk: Buffer): string[] | 'too-long' {
    const lines: string[] = [];
    let rest = chunk;
    for (;;) {
      const end = rest.indexOf(0x0a);
      if (end === -1) break;
      if (this.#size + end > LINE_MAX) return 'too-long';
      lines.push(Buffer.concat([...this.#kept, rest.subarray(0, end)]).toString('utf8'));
      this.#kept = [];
      this.#size = 0;
      rest = rest.subarray(end + 1);
    }
    if (rest.length > 0) {
      this.#size += rest.length;
      if (this.#size > LINE_MAX) return 'too-long';
      this.#kept.push(rest);
    }
    return lines;
  }
}

/** Reads one line as a message of the given kind; null when it is none. */
export function messageOf<T>(schema: z.ZodType<T>, line: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
