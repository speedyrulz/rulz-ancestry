import { afterEach, describe, expect, it } from 'vitest';
import {
  AI_ACTIVITY_DETAIL_KEYS,
  AI_ACTIVITY_KEEP_DAYS,
  AI_ACTIVITY_MAX_ROWS,
  AI_ACTIVITY_TEXT_MAX,
  clearAiActivity,
  countAiActivity,
  listAiActivity,
  logAiActivity,
  pruneAiActivity,
  type AiActivityInput,
} from './aiactivity';
import { openAppDatabase } from './appdb';
import type { Db } from './connection';

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    if (db.open) db.close();
  }
});

function appDb(): Db {
  const db = openAppDatabase(':memory:');
  open.push(db);
  return db;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 1);

function entry(overrides: Partial<AiActivityInput> = {}): AiActivityInput {
  return {
    sessionId: 'session-1',
    treeId: 'tree-1',
    kind: 'person-read',
    at: NOW,
    detail: { personId: 'p1' },
    ...overrides,
  };
}

/** Writes a row as another program could have, without any of the checks. */
function insertRaw(db: Db, at: number, kind: string, detail: string, sessionId = 'session-1') {
  db.prepare(
    'INSERT INTO ai_activity (at, session_id, tree_id, kind, detail) VALUES (?, ?, ?, ?, ?)',
  ).run(at, sessionId, 'tree-1', kind, detail);
}

describe('logAiActivity', () => {
  it('writes an entry that comes back as it was given', () => {
    const db = appDb();
    logAiActivity(
      db,
      entry({
        kind: 'records-searched',
        detail: { query: 'born 1850', count: 3, exact: true, place: null },
      }),
    );
    expect(listAiActivity(db)).toEqual([
      {
        id: 1,
        sessionId: 'session-1',
        treeId: 'tree-1',
        kind: 'records-searched',
        at: NOW,
        detail: { query: 'born 1850', count: 3, exact: true, place: null },
      },
    ]);
  });

  it('cuts a long text to the longest that is kept', () => {
    const db = appDb();
    logAiActivity(db, entry({ detail: { query: 'x'.repeat(AI_ACTIVITY_TEXT_MAX + 50) } }));
    expect(listAiActivity(db)[0]?.detail.query).toBe('x'.repeat(AI_ACTIVITY_TEXT_MAX));
  });

  it('does not leave half of a character at the end of a cut', () => {
    const db = appDb();
    const pair = String.fromCharCode(0xd83c, 0xdf33);
    const text = 'x'.repeat(AI_ACTIVITY_TEXT_MAX - 1) + pair;
    logAiActivity(db, entry({ detail: { query: text } }));
    expect(listAiActivity(db)[0]?.detail.query).toBe('x'.repeat(AI_ACTIVITY_TEXT_MAX - 1));
  });

  it('turns control characters into spaces', () => {
    const db = appDb();
    // A line break, a tab, the nul character, delete, and one of the second set of control characters.
    const mixed = [10, 9, 0, 0x7f, 0x85]
      .map((code, index) => 'abcde'.charAt(index) + String.fromCharCode(code))
      .join('');
    logAiActivity(db, entry({ detail: { mixed } }));
    expect(listAiActivity(db)[0]?.detail).toEqual({ mixed: 'a b c d e ' });
  });

  it('drops values that are not text, a finite number, true or false, or null', () => {
    const db = appDb();
    const detail = {
      kept: 'yes',
      nested: { a: 1 },
      list: [1, 2],
      notANumber: Number.NaN,
      endless: Number.POSITIVE_INFINITY,
      missing: undefined,
      big: BigInt(1),
      call: () => 1,
    } as unknown as AiActivityInput['detail'];
    logAiActivity(db, entry({ detail }));
    expect(listAiActivity(db)[0]?.detail).toEqual({ kept: 'yes' });
  });

  it('drops keys beyond the most a detail may have, and keys that are too long', () => {
    const db = appDb();
    const detail: Record<string, number> = { ['k'.repeat(41)]: 0, ['j'.repeat(40)]: 1 };
    for (let i = 0; i < AI_ACTIVITY_DETAIL_KEYS + 5; i += 1) detail['key' + String(i)] = i;
    logAiActivity(db, entry({ detail }));
    const kept = listAiActivity(db)[0]?.detail ?? {};
    expect(Object.keys(kept)).toHaveLength(AI_ACTIVITY_DETAIL_KEYS);
    expect(kept).not.toHaveProperty('k'.repeat(41));
    expect(kept['j'.repeat(40)]).toBe(1);
    expect(kept).not.toHaveProperty('key' + String(AI_ACTIVITY_DETAIL_KEYS - 1));
  });

  it('keeps a key named like the prototype as an ordinary key', () => {
    const db = appDb();
    const detail = JSON.parse('{"__proto__": "text", "other": 1}') as AiActivityInput['detail'];
    logAiActivity(db, entry({ detail }));
    const kept = listAiActivity(db)[0]?.detail ?? {};
    expect(Object.keys(kept)).toEqual(['__proto__', 'other']);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  it('turns a detail that is not a plain object into an empty one', () => {
    const db = appDb();
    logAiActivity(db, entry({ detail: [1, 2] as unknown as AiActivityInput['detail'] }));
    logAiActivity(db, entry({ detail: null as unknown as AiActivityInput['detail'] }));
    expect(listAiActivity(db).map((row) => row.detail)).toEqual([{}, {}]);
  });

  it('throws a TypeError for a kind it does not know', () => {
    const db = appDb();
    expect(() =>
      logAiActivity(db, entry({ kind: 'file-deleted' as AiActivityInput['kind'] })),
    ).toThrow(TypeError);
  });

  it('keeps the entries of an API run, at the start and at the end', () => {
    const db = appDb();
    logAiActivity(
      db,
      entry({
        kind: 'run-started',
        detail: { model: 'claude-haiku-5-5', effort: 'low', capUsd: 0.5 },
      }),
    );
    logAiActivity(
      db,
      entry({
        kind: 'run-ended',
        at: NOW + 1,
        detail: { responses: 2, costUsd: 0.01, why: 'done', costMayBeHigher: false },
      }),
    );
    expect(listAiActivity(db).map((row) => row.kind)).toEqual(['run-ended', 'run-started']);
  });

  it('throws a TypeError for a time that is not a whole number of zero or more', () => {
    const db = appDb();
    for (const at of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => logAiActivity(db, entry({ at }))).toThrow(TypeError);
    }
    expect(() => logAiActivity(db, entry({ at: 0 }))).not.toThrow();
  });

  it('throws a TypeError for an id of a session or a tree that is empty or too long', () => {
    const db = appDb();
    expect(() => logAiActivity(db, entry({ sessionId: '' }))).toThrow(TypeError);
    expect(() => logAiActivity(db, entry({ sessionId: 's'.repeat(65) }))).toThrow(TypeError);
    expect(() => logAiActivity(db, entry({ treeId: '' }))).toThrow(TypeError);
    expect(() => logAiActivity(db, entry({ treeId: 3 as unknown as string }))).toThrow(TypeError);
    expect(() => logAiActivity(db, entry({ sessionId: 's'.repeat(64) }))).not.toThrow();
    expect(countAiActivity(db)).toBe(1);
  });

  it('removes what is too old, measured from the time of the new entry', () => {
    const db = appDb();
    const keep = AI_ACTIVITY_KEEP_DAYS * DAY;
    logAiActivity(db, entry({ at: NOW - keep - 1, detail: { n: 1 } }));
    logAiActivity(db, entry({ at: NOW - keep, detail: { n: 2 } }));
    logAiActivity(db, entry({ at: NOW, detail: { n: 3 } }));
    expect(listAiActivity(db).map((row) => row.detail.n)).toEqual([3, 2]);
  });

  it('removes the oldest entries beyond the most rows', () => {
    const db = appDb();
    db.transaction(() => {
      for (let i = 0; i < AI_ACTIVITY_MAX_ROWS; i += 1) insertRaw(db, NOW + i, 'person-read', '{}');
    })();
    logAiActivity(db, entry({ at: NOW + AI_ACTIVITY_MAX_ROWS }));
    expect(countAiActivity(db)).toBe(AI_ACTIVITY_MAX_ROWS);
    const oldest = db.prepare('SELECT min(at) FROM ai_activity').pluck().get();
    expect(oldest).toBe(NOW + 1);
  });

  it('writes nothing when the pruning fails', () => {
    const db = appDb();
    // A trigger stands in for a failure in the middle of the transaction.
    db.exec(`
      CREATE TRIGGER no_delete BEFORE DELETE ON ai_activity
      BEGIN SELECT RAISE(ABORT, 'no deleting'); END;
    `);
    insertRaw(db, 0, 'person-read', '{}');
    expect(() => logAiActivity(db, entry({ at: NOW }))).toThrow(/no deleting/);
    expect(countAiActivity(db)).toBe(1);
  });
});

describe('listAiActivity', () => {
  it('lists the latest first, by time and then by the order of writing', () => {
    const db = appDb();
    logAiActivity(db, entry({ at: NOW, detail: { n: 1 } }));
    logAiActivity(db, entry({ at: NOW + 10, detail: { n: 2 } }));
    logAiActivity(db, entry({ at: NOW, detail: { n: 3 } }));
    expect(listAiActivity(db).map((row) => row.detail.n)).toEqual([2, 3, 1]);
  });

  it('pages with a limit and an offset, and keeps the limit within bounds', () => {
    const db = appDb();
    db.transaction(() => {
      for (let i = 0; i < 600; i += 1) insertRaw(db, NOW + i, 'person-read', '{}');
    })();
    expect(listAiActivity(db)).toHaveLength(100);
    expect(listAiActivity(db, { limit: 1000 })).toHaveLength(500);
    expect(listAiActivity(db, { limit: 0 })).toHaveLength(1);
    expect(listAiActivity(db, { limit: Number.NaN })).toHaveLength(100);
    expect(listAiActivity(db, { limit: 2, offset: 3 }).map((row) => row.at)).toEqual([
      NOW + 596,
      NOW + 595,
    ]);
    expect(listAiActivity(db, { limit: 1, offset: -5 })[0]?.at).toBe(NOW + 599);
  });

  it('lists and counts the entries of one session when it is named', () => {
    const db = appDb();
    logAiActivity(db, entry({ sessionId: 'a', kind: 'session-started' }));
    logAiActivity(db, entry({ sessionId: 'b', kind: 'session-started' }));
    logAiActivity(db, entry({ sessionId: 'a', kind: 'session-ended', at: NOW + 1 }));
    expect(listAiActivity(db, { sessionId: 'a' }).map((row) => row.kind)).toEqual([
      'session-ended',
      'session-started',
    ]);
    expect(countAiActivity(db, 'a')).toBe(2);
    expect(countAiActivity(db, 'b')).toBe(1);
    expect(countAiActivity(db, 'c')).toBe(0);
    expect(countAiActivity(db)).toBe(3);
  });

  it('leaves out a row of a kind it does not know', () => {
    const db = appDb();
    insertRaw(db, NOW, 'person-read', '{"n":1}');
    insertRaw(db, NOW + 1, 'something-else', '{"n":2}');
    expect(listAiActivity(db).map((row) => row.detail.n)).toEqual([1]);
  });

  it('leaves out a row whose time is no whole number of zero or more', () => {
    const db = appDb();
    insertRaw(db, NOW, 'person-read', '{"n":1}');
    insertRaw(db, NOW + 0.5, 'person-read', '{"n":2}');
    insertRaw(db, -1, 'person-read', '{"n":3}');
    insertRaw(db, Number.MAX_SAFE_INTEGER * 4, 'person-read', '{"n":4}');
    expect(listAiActivity(db).map((row) => row.detail.n)).toEqual([1]);
  });

  it('gives an empty detail for one that is not JSON of a flat object, and cleans the rest', () => {
    const db = appDb();
    insertRaw(db, NOW + 3, 'person-read', 'not json');
    insertRaw(db, NOW + 2, 'person-read', '[1,2]');
    insertRaw(db, NOW + 1, 'person-read', '"text"');
    insertRaw(db, NOW, 'person-read', JSON.stringify({ a: 'x'.repeat(400), b: { c: 1 } }));
    expect(listAiActivity(db).map((row) => row.detail)).toEqual([
      {},
      {},
      {},
      { a: 'x'.repeat(AI_ACTIVITY_TEXT_MAX) },
    ]);
  });
});

describe('clearAiActivity', () => {
  it('removes every entry and says how many there were', () => {
    const db = appDb();
    logAiActivity(db, entry());
    logAiActivity(db, entry({ sessionId: 'other' }));
    expect(clearAiActivity(db)).toBe(2);
    expect(countAiActivity(db)).toBe(0);
    expect(clearAiActivity(db)).toBe(0);
  });
});

describe('pruneAiActivity', () => {
  it('removes what is older than the days that are kept, and keeps what is in the future', () => {
    const db = appDb();
    const keep = AI_ACTIVITY_KEEP_DAYS * DAY;
    insertRaw(db, NOW - keep - 1, 'person-read', '{"n":1}');
    insertRaw(db, NOW - keep, 'person-read', '{"n":2}');
    insertRaw(db, NOW + 10 * DAY, 'person-read', '{"n":3}');
    expect(pruneAiActivity(db, NOW)).toBe(1);
    expect(listAiActivity(db).map((row) => row.detail.n)).toEqual([3, 2]);
    expect(pruneAiActivity(db, NOW)).toBe(0);
  });

  it('removes the oldest beyond the most rows, the lowest id first among equal times', () => {
    const db = appDb();
    db.transaction(() => {
      for (let i = 0; i < AI_ACTIVITY_MAX_ROWS + 2; i += 1) {
        insertRaw(db, NOW, 'person-read', JSON.stringify({ n: i }));
      }
    })();
    expect(pruneAiActivity(db, NOW)).toBe(2);
    expect(countAiActivity(db)).toBe(AI_ACTIVITY_MAX_ROWS);
    const lowest = db.prepare('SELECT min(id) FROM ai_activity').pluck().get();
    expect(lowest).toBe(3);
  });
});
