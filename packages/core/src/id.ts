/**
 * Record identifiers are UUIDv7 (RFC 9562): a 48-bit millisecond timestamp, a
 * 12-bit counter and 62 random bits. They stay unique when two trees created
 * on different machines are merged, and they keep SQLite primary-key indexes
 * compact because new ids always land at the end.
 *
 * Ids made by one running app sort in the order they were made, even within
 * the same millisecond. The database layer relies on that: "ORDER BY id" lists
 * records in creation order, and the order survives undo and redo.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const COUNTER_MAX = 0xfff;

let lastTime = -1;
let lastCounter = 0;

/** Every byte value as two hex digits. */
const HEX: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

/**
 * Random bytes are fetched from the system a block at a time. An import makes
 * more than a hundred thousand ids, and asking the system for sixteen bytes
 * each time took a fifth of the import. Every byte is still used only once.
 */
const POOL_SIZE = 4096;
const pool = new Uint8Array(POOL_SIZE);
let poolUsed = POOL_SIZE;

/** Reserves `count` unused random bytes and returns where they start in the pool. */
function takeRandom(count: number): number {
  if (poolUsed + count > POOL_SIZE) {
    crypto.getRandomValues(pool);
    poolUsed = 0;
  }
  const start = poolUsed;
  poolUsed += count;
  return start;
}

function randomCounterStart(): number {
  // Start in the lower half of the 12 bits, so there is always room to count up.
  const at = takeRandom(2);
  return (((pool[at] ?? 0) << 8) | (pool[at + 1] ?? 0)) & 0x7ff;
}

/** The bytes of the id being made. Reused, because an id is turned into text before the next one starts. */
const scratch = new Uint8Array(16);

/**
 * Returns a new id. Pass `now` (Unix milliseconds) only to make an id for a
 * known moment, as tests and imports do; such an id has random bits in place
 * of the counter and takes no part in the ordering described above.
 */
export function newId(now?: number): string {
  const bytes = scratch;
  const random = takeRandom(16);
  bytes.set(pool.subarray(random, random + 16));

  let time: number;
  if (now === undefined) {
    const clock = Date.now();
    if (clock > lastTime) {
      lastTime = clock;
      lastCounter = randomCounterStart();
    } else if (lastCounter < COUNTER_MAX) {
      // Same millisecond, or the clock was set back: keep counting from the last id.
      lastCounter += 1;
    } else {
      // More than the counter holds in one millisecond: borrow the next one.
      lastTime += 1;
      lastCounter = randomCounterStart();
    }
    time = lastTime;
    bytes[6] = lastCounter >> 8;
    bytes[7] = lastCounter & 0xff;
  } else {
    if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48) {
      throw new RangeError(`timestamp out of range for UUIDv7: ${now}`);
    }
    time = now;
  }

  // Bytes 0-5: big-endian Unix time in milliseconds. Division is used for the
  // high bytes because bitwise operators truncate to 32 bits.
  bytes[0] = Math.floor(time / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(time / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(time / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(time / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(time / 2 ** 8) & 0xff;
  bytes[5] = time & 0xff;

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC variant

  // 8-4-4-4-12 hex digits.
  let text = '';
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) text += '-';
    text += HEX[bytes[index] ?? 0] ?? '';
  }
  return text;
}

/** Returns the creation time (Unix milliseconds) encoded in an id from {@link newId}. */
export function idTimestamp(id: string): number {
  if (!UUID_V7.test(id)) {
    throw new TypeError(`not a UUIDv7: ${id}`);
  }
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
