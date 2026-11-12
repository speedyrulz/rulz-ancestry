/**
 * Record identifiers are UUIDv7 (RFC 9562): a 48-bit millisecond timestamp
 * followed by random bits. They sort roughly by creation time, which keeps
 * SQLite primary-key indexes compact, and they stay unique when two trees
 * created on different machines are merged.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newId(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`timestamp out of range for UUIDv7: ${now}`);
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Bytes 0-5: big-endian Unix time in milliseconds. Division is used for the
  // high bytes because bitwise operators truncate to 32 bits.
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Returns the creation time (Unix milliseconds) encoded in an id from {@link newId}. */
export function idTimestamp(id: string): number {
  if (!UUID_V7.test(id)) {
    throw new TypeError(`not a UUIDv7: ${id}`);
  }
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
