import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL,
  LINE_MAX,
  LineReader,
  fromAppSchema,
  fromBridgeSchema,
  lineOf,
  messageOf,
  newPipeName,
  newSecret,
  parseConnectorFile,
  proofOf,
  sameProof,
} from './protocol';

describe('the file the app writes for its bridge', () => {
  const file = { protocol: BRIDGE_PROTOCOL, pipe: newPipeName(), key: newSecret() };

  it('is read back as it was written', () => {
    expect(parseConnectorFile(JSON.stringify(file))).toEqual(file);
  });

  it('names a pipe of this PC that the app made, and nothing else', () => {
    const named = (pipe: string) => parseConnectorFile(JSON.stringify({ ...file, pipe }));
    expect(named(file.pipe)).not.toBeNull();
    // A pipe of another PC, a pipe of another program, a path of a file.
    expect(named(file.pipe.replace('\\\\.\\', '\\\\fileserver\\'))).toBeNull();
    expect(named('\\\\.\\pipe\\something-else')).toBeNull();
    expect(named(`${file.pipe}\\..\\other`)).toBeNull();
    expect(named('C:\\Windows\\Temp\\socket')).toBeNull();
    expect(named('/tmp/rulz.sock')).toBeNull();
  });

  it('is not read when it holds anything else', () => {
    expect(parseConnectorFile('')).toBeNull();
    expect(parseConnectorFile('not json')).toBeNull();
    expect(parseConnectorFile('null')).toBeNull();
    expect(parseConnectorFile(JSON.stringify({ ...file, key: 'short' }))).toBeNull();
    expect(parseConnectorFile(JSON.stringify({ ...file, more: 1 }))).toBeNull();
    expect(parseConnectorFile(JSON.stringify({ ...file, protocol: '1' }))).toBeNull();
  });

  it('gets a new name and a new key each time', () => {
    expect(newPipeName()).not.toBe(newPipeName());
    expect(newSecret()).not.toBe(newSecret());
    expect(newPipeName()).toMatch(/^\\\\\.\\pipe\\rulz-ancestry-[0-9a-f]{32}$/);
    expect(Buffer.from(newSecret(), 'base64')).toHaveLength(32);
  });
});

describe('the proof of a side', () => {
  const key = newSecret();
  const pipe = newPipeName();
  const bridgeNonce = newSecret();
  const appNonce = newSecret();
  const proof = proofOf(key, 'app', pipe, bridgeNonce, appNonce);

  it('is the same for the same key, side, pipe and numbers', () => {
    expect(sameProof(proof, proofOf(key, 'app', pipe, bridgeNonce, appNonce))).toBe(true);
  });

  it('is another for another key, side, pipe or number', () => {
    expect(sameProof(proof, proofOf(newSecret(), 'app', pipe, bridgeNonce, appNonce))).toBe(false);
    // The proof of the app is not the proof of the bridge, so it cannot be sent back.
    expect(sameProof(proof, proofOf(key, 'bridge', pipe, bridgeNonce, appNonce))).toBe(false);
    expect(sameProof(proof, proofOf(key, 'app', newPipeName(), bridgeNonce, appNonce))).toBe(false);
    expect(sameProof(proof, proofOf(key, 'app', pipe, newSecret(), appNonce))).toBe(false);
    expect(sameProof(proof, proofOf(key, 'app', pipe, bridgeNonce, newSecret()))).toBe(false);
    // Nor do the two numbers stand for each other.
    expect(sameProof(proof, proofOf(key, 'app', pipe, appNonce, bridgeNonce))).toBe(false);
  });

  it('is not the same as a text of another length', () => {
    expect(sameProof(proof, '')).toBe(false);
    expect(sameProof(proof, proof.slice(1))).toBe(false);
  });

  it('does not hold the key', () => {
    expect(proof).not.toContain(key);
    expect(proof).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});

describe('the lines on the pipe', () => {
  it('are handed on one by one, however they arrive', () => {
    const reader = new LineReader();
    expect(reader.push(Buffer.from('{"a":'))).toEqual([]);
    expect(reader.push(Buffer.from('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.push(Buffer.from(':3}\n'))).toEqual(['{"c":3}']);
    expect(reader.push(Buffer.from('\n'))).toEqual(['']);
  });

  it('keep a character whole that arrives in two parts', () => {
    const reader = new LineReader();
    const bytes = Buffer.from('"Kühn"\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;
    expect(reader.push(bytes.subarray(0, cut))).toEqual([]);
    expect(reader.push(bytes.subarray(cut))).toEqual(['"Kühn"']);
  });

  it('are not kept beyond the longest line', () => {
    const whole = new LineReader();
    expect(whole.push(Buffer.alloc(LINE_MAX, 0x61))).toEqual([]);
    expect(whole.push(Buffer.from('\n'))).toHaveLength(1);

    const inOne = new LineReader();
    expect(inOne.push(Buffer.alloc(LINE_MAX + 1, 0x61))).toBe('too-long');

    const inParts = new LineReader();
    expect(inParts.push(Buffer.alloc(LINE_MAX - 10, 0x61))).toEqual([]);
    expect(inParts.push(Buffer.alloc(20, 0x61))).toBe('too-long');

    const withEnd = new LineReader();
    expect(withEnd.push(Buffer.alloc(LINE_MAX, 0x61))).toEqual([]);
    expect(withEnd.push(Buffer.from('a\n'))).toBe('too-long');
  });

  it('are messages of one side only when they are exactly what that side sends', () => {
    const call = { t: 'call', id: 1, name: 'get_session', input: {} } as const;
    expect(messageOf(fromBridgeSchema, lineOf(call).trim())).toEqual(call);
    expect(messageOf(fromAppSchema, lineOf(call).trim())).toBeNull();
    expect(messageOf(fromBridgeSchema, '{"t":"call","id":0,"name":"x","input":{}}')).toBeNull();
    expect(messageOf(fromBridgeSchema, '{"t":"call","id":1,"name":"x","input":{},"key":"k"}')).toBe(
      null,
    );
    expect(messageOf(fromBridgeSchema, '{"t":"hello","protocol":1,"nonce":"short"}')).toBeNull();
    expect(messageOf(fromBridgeSchema, 'not json')).toBeNull();
    expect(messageOf(fromBridgeSchema, '[]')).toBeNull();
    expect(lineOf(call).endsWith('\n')).toBe(true);
    // A line feed inside a text does not end the line.
    expect(lineOf({ ...call, input: { query: 'a\nb' } }).split('\n')).toHaveLength(2);
  });
});
