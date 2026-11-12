import { describe, expect, it } from 'vitest';
import { idTimestamp, newId } from './id';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('produces a well-formed UUIDv7', () => {
    expect(newId()).toMatch(UUID_V7);
  });

  it('encodes the timestamp so it can be read back', () => {
    const now = Date.UTC(2026, 10, 11, 12, 0, 0, 123);
    expect(idTimestamp(newId(now))).toBe(now);
  });

  it('round-trips the smallest and largest timestamps', () => {
    expect(idTimestamp(newId(0))).toBe(0);
    expect(idTimestamp(newId(2 ** 48 - 1))).toBe(2 ** 48 - 1);
  });

  it('sorts by creation time when timestamps differ', () => {
    const earlier = newId(1_700_000_000_000);
    const later = newId(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it('does not repeat within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId(1_700_000_000_000)));
    expect(ids.size).toBe(5000);
  });

  it('makes ids that sort in the order they were made', () => {
    // Far more than one millisecond can hold, so the counter and its overflow are both used.
    const ids = Array.from({ length: 20_000 }, () => newId());
    for (let i = 1; i < ids.length; i++) {
      if (!(ids[i - 1]! < ids[i]!)) throw new Error(`id ${i} does not sort after id ${i - 1}`);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    // Borrowing from the next millisecond must not let ids run far ahead of the clock.
    expect(idTimestamp(ids.at(-1)!) - Date.now()).toBeLessThan(1000);
  });

  it('rejects timestamps that do not fit in 48 bits', () => {
    expect(() => newId(-1)).toThrow(RangeError);
    expect(() => newId(2 ** 48)).toThrow(RangeError);
    expect(() => newId(1.5)).toThrow(RangeError);
  });
});

describe('idTimestamp', () => {
  it('rejects strings that are not UUIDv7', () => {
    expect(() => idTimestamp('not-an-id')).toThrow(TypeError);
    // A version 4 UUID has the right shape but the wrong version nibble.
    expect(() => idTimestamp('9b2f1c1e-8a52-4e0a-9d3b-2f6f0e9a1c11')).toThrow(TypeError);
  });
});
