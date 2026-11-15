import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVING_LABEL, RECORD_TEXT_NOTE, type AiToolResult } from '@rulz/ai';
import {
  addChild,
  addName,
  addPersonEvent,
  createFamily,
  createPerson,
  deletePerson,
  listAiActivity,
  listNames,
  listPersonEvents,
  openAppDatabase,
  openTree,
  setSetting,
  updateEvent,
  updateName,
  updatePerson,
  type Db,
  type Tree,
} from '@rulz/db';
import {
  AI_NOTICE_SETTING,
  AI_NOTICE_VERSION,
  AI_NOTICE_VERSION_SETTING,
  AI_SESSION_CALLS,
  AI_SESSION_GAP_MS,
  AI_SESSION_CLIENTS_LOGGED,
  AI_SESSION_IDLE_MS,
  AI_SESSION_MAX_MS,
  AI_SESSION_REQUESTS,
  AiSessionService,
  type AiSessionStatus,
} from './aisession';
import type { AiClientInfo } from '../shared/ipc';
import type { AiBridge } from './aibridge';
import { RecordSearchService } from './records';

let appDb: Db;
let tree: Tree;
/** False once the tree counts as closed. */
let open: boolean;
let records: RecordSearchService;
let ai: AiSessionService;
/** How far the clock of the session is ahead of the PC's, in milliseconds. */
let ahead: number;
/** Every address a source was asked for. */
let asked: string[];
/** What a source answers; a test can put its own answer in its place. */
let answerOf: (url: string) => Response;
/** How long the session waited before a question each time. It does not wait in these tests. */
let waits: number[];
/** What a test does while the session waits. */
let whileWaiting: (() => void | Promise<void>) | null;

const askedOf = (host: string) => asked.filter((url) => new URL(url).host === host);

/** A profile of WikiTree of someone made up. */
const profile = (number: number, extra: object = {}) => ({
  Id: number,
  Name: `Veldkamp-${90000 + number}`,
  FirstName: 'Marten',
  RealName: 'Marten',
  LastNameAtBirth: 'Veldkamp',
  LastNameCurrent: 'Veldkamp',
  BirthDate: '1850-03-01',
  DeathDate: '1921-00-00',
  BirthLocation: 'Zwolle',
  Gender: 'Male',
  IsLiving: 0,
  Privacy: 60,
  DataStatus: { BirthDate: 'certain', DeathDate: 'guess' },
  Bio: 'A biography that a member wrote.',
  ...extra,
});

const usualAnswer = (url: string): Response => {
  const host = new URL(url).host;
  if (host === 'api.openarchieven.nl') {
    return new Response(
      JSON.stringify({
        response: {
          number_found: 1,
          docs: [
            {
              pid: 'Person1',
              identifier: 'REC-1',
              archive_code: 'exa',
              archive: 'Example Municipal Archive',
              personname: 'Marten Veldkamp',
              relationtype: 'Groom',
              eventtype: 'Marriage',
              eventdate: { day: 12, month: 5, year: 1875 },
              eventplace: ['Voorbeeldstad'],
              sourcetype: 'Civil registration marriages',
            },
          ],
        },
      }),
    );
  }
  return new Response(
    JSON.stringify([
      {
        status: 0,
        total: 3,
        matches: [
          profile(1),
          // Left out by the connector: one who is living, and one that is private.
          profile(2, { IsLiving: 1 }),
          profile(3, { Privacy: 40 }),
        ],
      },
    ]),
  );
};

/**
 * A family of made-up people: Marten Veldkamp (1850 to 1921), his father
 * Douwe (1820 to 1880), his mother Tessel Oort, who is marked as living, and
 * Douwe's father Hidde, born in 1790.
 */
function family() {
  const person = (
    given: string,
    surname: string,
    born: string | null,
    extra: { living?: boolean; died?: string } = {},
  ) => {
    const { id } = createPerson(tree, {
      sex: 'U',
      living: extra.living ?? null,
      name: { given, surname },
    });
    if (born !== null) addPersonEvent(tree, id, { type: 'birth', date: born, place: 'Zwolle' });
    if (extra.died !== undefined) addPersonEvent(tree, id, { type: 'death', date: extra.died });
    return id;
  };
  const marten = person('Marten', 'Veldkamp', '1 MAR 1850', { died: '1921' });
  const douwe = person('Douwe', 'Veldkamp', '1820', { died: '1880' });
  const tessel = person('Tessel', 'Oort', null, { living: true });
  const hidde = person('Hidde', 'Veldkamp', '1790');
  addChild(tree, createFamily(tree, { partner1Id: douwe, partner2Id: tessel }).id, marten);
  addChild(tree, createFamily(tree, { partner1Id: hidde }).id, douwe);
  return { marten, douwe, tessel, hidde };
}

function agreeToBoth(): void {
  records.agree();
  ai.agree();
}

/** Starts a session from a person, as the page does: from the plan it was shown. */
function begin(personId: string, sourceIds: string[] = ['wikitree'], generations = 3) {
  const plan = ai.plan(tree, { personId, generations });
  return ai.start(tree, { personId, generations, sourceIds, stamp: plan?.stamp ?? '' }, () => open);
}

function started(personId: string, sourceIds: string[] = ['wikitree']): AiSessionStatus {
  const result = begin(personId, sourceIds);
  if (!result.ok) throw new Error(result.problem.message);
  return result.session;
}

/** The value of an answer that gave something. */
function valueOf<T>(result: AiToolResult): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.value as T;
}

interface Records {
  records: { ref: string; url: string; fields: { name: string; value: string }[] }[];
  questionsLeft: number;
  leftOut: number;
  fromEarlierAnswer: boolean;
  note: string;
}

const question = (personId: string, extra: object = {}) => ({
  personId,
  sourceId: 'wikitree',
  given: 'Marten',
  surname: 'Veldkamp',
  birthYear: 1850,
  deathYear: null,
  ...extra,
});

const log = () =>
  listAiActivity(appDb, { limit: 500 })
    .reverse()
    .map((entry) => ({ kind: entry.kind, ...entry.detail }));

const status = (): AiSessionStatus => {
  const standing = ai.status();
  if (standing === null) throw new Error('there is no session');
  return standing;
};

beforeEach(() => {
  appDb = openAppDatabase(':memory:');
  tree = openTree(':memory:');
  open = true;
  ahead = 0;
  asked = [];
  answerOf = usualAnswer;
  waits = [];
  whileWaiting = null;
  records = new RecordSearchService({
    appDb,
    appVersion: '0.0.0',
    fetch: (url) => {
      asked.push(url);
      return Promise.resolve(answerOf(url));
    },
  });
  let sessions = 0;
  ai = new AiSessionService(records, {
    appDb,
    now: () => Date.now() + ahead,
    wait: async (ms, signal) => {
      waits.push(ms);
      await whileWaiting?.();
      if (signal.aborted) throw new Error('given up');
    },
    newId: () => {
      sessions += 1;
      return `session-${sessions}`;
    },
  });
});

afterEach(async () => {
  ai.clear();
  await ai.idle();
  records.reset();
  tree.close();
  appDb.close();
});

describe('the notice of the AI assistant', () => {
  it('must be agreed to before a session starts, and so must the notice of the search', () => {
    const { marten } = family();
    expect(ai.agreed).toBe(false);
    expect(begin(marten)).toMatchObject({ ok: false, problem: { kind: 'notice' } });

    ai.agree();
    expect(ai.agreed).toBe(true);
    // The assistant is on, but the user has not agreed to what a search sends.
    expect(begin(marten)).toMatchObject({ ok: false, problem: { kind: 'notice' } });

    records.agree();
    expect(begin(marten).ok).toBe(true);
    expect(asked).toEqual([]);
  });

  it('does not count when it was agreed to in an earlier wording, or is no number', () => {
    setSetting(appDb, AI_NOTICE_SETTING, '2026-11-14T00:00:00.000Z');
    for (const version of ['0', '1', '', '1.5', 'latest']) {
      setSetting(appDb, AI_NOTICE_VERSION_SETTING, version);
      expect(ai.agreed, version).toBe(false);
    }
    setSetting(appDb, AI_NOTICE_VERSION_SETTING, String(AI_NOTICE_VERSION));
    expect(ai.agreed).toBe(true);
  });

  it('can be taken back, which ends the session and forgets what it proposed', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    const found = valueOf<Records>(await ai.call('search_records', question(marten)));
    await ai.call('propose_match', {
      personId: marten,
      ref: found.records[0]?.ref,
      verdict: 'fits',
      confidence: 'high',
      reasons: [{ side: 'for', text: 'Born in the same place.', quote: 'Zwolle' }],
    });
    expect(ai.proposals()).toHaveLength(1);

    ai.withdraw();

    expect(ai.agreed).toBe(false);
    expect(ai.status()).toBeNull();
    expect(ai.proposals()).toEqual([]);
    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    expect(log().at(-1)).toMatchObject({ kind: 'session-ended', why: 'withdrawn' });
  });

  it('ends a session when the notice of the search no longer stands', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    setSetting(appDb, 'recordSearch.noticeVersion', '0');

    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    expect(status()).toMatchObject({ status: 'ended', ended: 'withdrawn' });
  });
});

describe('the plan of a session', () => {
  it('lists the person and their ancestors, and who is left out as living', () => {
    const { marten, douwe, tessel, hidde } = family();
    agreeToBoth();

    const plan = ai.plan(tree, { personId: marten, generations: 3 });

    expect(plan?.people).toEqual([
      { personId: marten, name: 'Marten Veldkamp', generation: 0, leftOut: null },
      { personId: douwe, name: 'Douwe Veldkamp', generation: 1, leftOut: null },
      { personId: tessel, name: 'Tessel Oort', generation: 1, leftOut: 'living' },
      { personId: hidde, name: 'Hidde Veldkamp', generation: 2, leftOut: null },
    ]);
    expect(plan).toMatchObject({
      agreed: true,
      searchAgreed: true,
      requestsPerSource: AI_SESSION_REQUESTS,
      idleMinutes: 15,
    });
    expect(plan?.stamp).toMatch(/^[0-9a-f]{64}$/);
    // Nothing started, and nothing was sent or logged.
    expect(ai.status()).toBeNull();
    expect(asked).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('is for the person alone with no generations, and for three generations at most', () => {
    const { marten } = family();
    expect(ai.plan(tree, { personId: marten, generations: 0 })?.people).toHaveLength(1);
    expect(ai.plan(tree, { personId: marten, generations: 1 })?.people).toHaveLength(3);
    expect(ai.plan(tree, { personId: marten, generations: 99 })?.people).toHaveLength(4);
    expect(ai.plan(tree, { personId: marten, generations: -4 })?.people).toHaveLength(1);
    expect(ai.plan(tree, { personId: marten, generations: Number.NaN })?.people).toHaveLength(1);
  });

  it('offers the sources whose results may be passed on to an AI, and no others', () => {
    const { marten } = family();
    expect(
      ai.plan(tree, { personId: marten, generations: 0 })?.sources.map(({ id }) => id),
    ).toEqual(['wikitree', 'open-archives', 'wikidata']);
  });

  it('is none for a person who is not in the tree', () => {
    expect(ai.plan(tree, { personId: 'nobody', generations: 1 })).toBeNull();
  });
});

describe('starting a session', () => {
  it('is refused when the tree is no longer as the plan showed it', () => {
    const { marten, douwe } = family();
    agreeToBoth();
    const plan = ai.plan(tree, { personId: marten, generations: 3 });
    updatePerson(tree, douwe, { living: true });

    const result = ai.start(
      tree,
      { personId: marten, generations: 3, sourceIds: ['wikitree'], stamp: plan?.stamp ?? '' },
      () => open,
    );

    expect(result).toMatchObject({ ok: false, problem: { kind: 'changed' } });
    // The plan as it is now comes back, to be shown again.
    expect(!result.ok && result.plan?.people[1]).toMatchObject({ leftOut: 'living' });
    expect(ai.status()).toBeNull();
  });

  it('is refused for a source a session may not ask, for none, and for one named twice', () => {
    const { marten } = family();
    agreeToBoth();
    for (const sourceIds of [[], ['loc'], ['wikitree', 'loc'], ['wikitree', 'wikitree'], ['x']]) {
      expect(begin(marten, sourceIds), sourceIds.join()).toMatchObject({
        ok: false,
        problem: { kind: 'source' },
      });
    }
    expect(ai.status()).toBeNull();
  });

  it('is refused when the sources are named as anything but a list of their ids', () => {
    const { marten } = family();
    agreeToBoth();
    // One text is no list, though the id of a source can be found in it.
    for (const sourceIds of ['wikitree', 'wikitree open-archives', [7], null, { 0: 'wikitree' }]) {
      expect(
        begin(marten, sourceIds as unknown as string[]),
        JSON.stringify(sourceIds),
      ).toMatchObject({ ok: false, problem: { kind: 'source' } });
    }
    expect(ai.status()).toBeNull();
  });

  it('is refused when everybody it would be for may be living, and for a person who is gone', () => {
    const { tessel } = family();
    agreeToBoth();
    expect(begin(tessel, ['wikitree'], 0)).toMatchObject({
      ok: false,
      problem: { kind: 'living' },
    });
    expect(
      ai.start(
        tree,
        { personId: 'nobody', generations: 0, sourceIds: ['wikitree'], stamp: '' },
        () => open,
      ),
    ).toMatchObject({ ok: false, problem: { kind: 'gone' }, plan: null });
  });

  it('gives the session as it stands, and writes its start to the log', () => {
    const { marten, douwe, hidde } = family();
    agreeToBoth();

    const session = started(marten, ['wikitree', 'open-archives']);

    expect(session).toMatchObject({
      sessionId: 'session-1',
      status: 'running',
      ended: null,
      calls: 0,
      questions: [],
      proposals: 0,
      sources: [
        { id: 'wikitree', name: 'WikiTree', used: 0, limit: AI_SESSION_REQUESTS },
        { id: 'open-archives', used: 0, limit: AI_SESSION_REQUESTS },
      ],
    });
    // The mother, who may be living, is not one of its people.
    expect(session.people.map((person) => person.personId)).toEqual([marten, douwe, hidde]);
    expect(session.idleAt).toBe(session.startedAt + AI_SESSION_IDLE_MS);
    expect(log()).toEqual([
      {
        kind: 'session-started',
        person: marten,
        generations: 2,
        people: 3,
        sources: 'wikitree open-archives',
      },
    ]);
    expect(asked).toEqual([]);
  });

  it('ends the session before it', async () => {
    const { marten, douwe } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    const second = started(douwe);

    expect(second.sessionId).toBe('session-2');
    expect(second.questions).toEqual([]);
    expect(log().filter((entry) => entry.kind === 'session-ended')).toEqual([
      { kind: 'session-ended', why: 'replaced', calls: 1, questions: 1, proposals: 0, programs: 0 },
    ]);
  });
});

describe('outside a session', () => {
  const tools = [
    'get_session',
    'list_sources',
    'search_tree',
    'get_person',
    'get_relatives',
    'search_records',
    'get_record',
    'propose_match',
  ];

  it('no tool gives anything, and nothing is sent or logged', async () => {
    const { marten } = family();
    agreeToBoth();
    for (const tool of tools) {
      expect(await ai.call(tool, question(marten)), tool).toMatchObject({
        ok: false,
        reason: 'no-session',
      });
    }
    expect(asked).toEqual([]);
    expect(log()).toEqual([]);
  });

  it('is where a session is once the user stopped it', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    ai.stop();

    for (const tool of tools) {
      expect(await ai.call(tool, question(marten)), tool).toMatchObject({
        ok: false,
        reason: 'no-session',
      });
    }
    expect(status()).toMatchObject({ status: 'ended', ended: 'stopped', idleAt: null, calls: 0 });
    expect(asked).toEqual([]);
  });

  it('is where a session is once the page that shows it is gone, and it says that this is why', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    await ai.call('propose_match', {
      personId: marten,
      ref: 'r1',
      verdict: 'fits',
      confidence: 'high',
      reasons: [{ side: 'for', text: 'He was born in the same place.', quote: 'Zwolle' }],
    });

    ai.stop('page');

    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    expect(status()).toMatchObject({
      status: 'ended',
      ended: 'page',
      endedMessage: 'The window of the app was loaded again, so the session ended.',
    });
    // What it proposed stays for the user to look at.
    expect(ai.proposals()).toHaveLength(1);
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toBe(
      'The session ended: the window of the app was loaded again. 2 calls, 1 question to services, 1 proposal.',
    );
  });

  it('is where a session is once its tree closed', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    open = false;

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(status()).toMatchObject({ status: 'ended', ended: 'tree-closed' });
    expect(asked).toEqual([]);
  });

  it('is where a session is when no call came for a quarter of an hour', async () => {
    const { marten } = family();
    agreeToBoth();
    const { startedAt } = started(marten);
    ahead = AI_SESSION_IDLE_MS - 1000;
    expect((await ai.call('get_session', {})).ok).toBe(true);
    // The quarter of an hour starts again with every call.
    ahead += AI_SESSION_IDLE_MS - 1000;
    expect((await ai.call('get_session', {})).ok).toBe(true);

    ahead += AI_SESSION_IDLE_MS;

    expect(status()).toMatchObject({ status: 'ended', ended: 'idle' });
    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    // The log says when it ended, not when someone next looked.
    const ended = listAiActivity(appDb).find((entry) => entry.kind === 'session-ended');
    expect(ended?.at).toBeGreaterThan(startedAt + 2 * AI_SESSION_IDLE_MS - 3000);
    expect(ended?.at).toBeLessThan(startedAt + 3 * AI_SESSION_IDLE_MS - 1000);
  });

  it('is where a session is after the calls it may take', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    for (let call = 0; call < AI_SESSION_CALLS; call += 1) await ai.call('no_such_tool', {});
    expect(status()).toMatchObject({ status: 'running', calls: AI_SESSION_CALLS });

    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    expect(status()).toMatchObject({ status: 'ended', ended: 'calls' });
  });

  it('is where a session is when the activity log cannot be written', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    appDb.exec('DROP TABLE ai_activity');

    // The call gives nothing, since it could not be logged.
    expect(await ai.call('get_person', { personId: marten })).toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(status()).toMatchObject({ status: 'ended', ended: 'log' });
  });
});

describe('the tools that read the tree', () => {
  it('say who the session is for, and what it may ask', async () => {
    const { marten, douwe, hidde } = family();
    agreeToBoth();
    started(marten, ['wikitree', 'wikidata']);

    const session = valueOf<{
      people: { id: string; name: string }[];
      sources: { id: string; questionsLeft: number }[];
      rules: string[];
    }>(await ai.call('get_session', {}));

    expect(session.people.map(({ id, name }) => [id, name])).toEqual([
      [marten, 'Marten Veldkamp'],
      [douwe, 'Douwe Veldkamp'],
      [hidde, 'Hidde Veldkamp'],
    ]);
    expect(JSON.stringify(session)).not.toContain('Tessel');
    expect(session.sources.map(({ id, questionsLeft }) => [id, questionsLeft])).toEqual([
      ['wikitree', AI_SESSION_REQUESTS],
      ['wikidata', AI_SESSION_REQUESTS],
    ]);
    expect(session.rules).toContain(RECORD_TEXT_NOTE);
    expect(valueOf<{ sources: unknown[] }>(await ai.call('list_sources', {})).sources).toEqual(
      session.sources,
    );
  });

  it('say nothing of a living person a session was started from, nor that there is one', async () => {
    const { marten, douwe, hidde } = family();
    const child = createPerson(tree, {
      living: true,
      name: { given: 'Sietse', surname: 'Veldkamp' },
    }).id;
    addChild(tree, createFamily(tree, { partner1Id: marten }).id, child);
    agreeToBoth();
    // The session is for the ancestors of the child, who is left out as living.
    expect(started(child).people.map(({ personId }) => personId)).toEqual([marten, douwe, hidde]);

    const session = valueOf<{ people: { id: string }[] }>(await ai.call('get_session', {}));

    expect(session.people.map(({ id }) => id)).toEqual([marten, douwe, hidde]);
    // No number of a generation, which would start at 1 here and so say that someone is below.
    expect(JSON.stringify(session)).not.toContain('generation');
    expect(JSON.stringify(session)).not.toContain(child);
    expect(JSON.stringify(session)).not.toContain('Sietse');
  });

  it('leave out of the session someone who has come to count as living since it started', async () => {
    const { marten, douwe } = family();
    agreeToBoth();
    started(marten);
    updatePerson(tree, douwe, { living: true });

    const session = valueOf<{ people: { id: string }[] }>(await ai.call('get_session', {}));

    expect(session.people.map(({ id }) => id)).not.toContain(douwe);
    expect(JSON.stringify(session)).not.toContain('Douwe');
    expect(await ai.call('search_records', question(douwe, { given: 'Douwe' }))).toMatchObject({
      ok: false,
      reason: 'not-given',
    });
    expect(asked).toEqual([]);
  });

  it('read a person and their relatives, and nobody who may be living', async () => {
    const { marten, tessel } = family();
    agreeToBoth();
    started(marten);

    const person = valueOf<{ names: { given: string }[] }>(
      await ai.call('get_person', { personId: marten }),
    );
    expect(person.names[0]?.given).toBe('Marten');
    const relatives = valueOf<{ parents: { living: boolean; label?: string; name?: string }[] }>(
      await ai.call('get_relatives', { personId: marten }),
    );
    expect(relatives.parents).toMatchObject([
      { living: false, name: 'Douwe Veldkamp' },
      { living: true, label: LIVING_LABEL },
    ]);
    expect(JSON.stringify(relatives)).not.toContain('Tessel');

    for (const tool of ['get_person', 'get_relatives']) {
      for (const personId of [tessel, 'nobody']) {
        expect(await ai.call(tool, { personId }), tool).toMatchObject({
          ok: false,
          reason: 'not-given',
        });
      }
    }
    const found = valueOf<{ people: { name: string }[] }>(
      await ai.call('search_tree', { query: 'Oort' }),
    );
    expect(found.people).toEqual([]);
    expect(
      valueOf<{ people: { name: string }[] }>(await ai.call('search_tree', { query: 'Veldkamp' }))
        .people,
    ).toHaveLength(3);
  });

  it('write what was read to the log, by the id of a person and without a name', async () => {
    const { marten, tessel } = family();
    agreeToBoth();
    started(marten);
    await ai.call('get_session', {});
    await ai.call('get_person', { personId: marten });
    await ai.call('get_relatives', { personId: tessel });
    await ai.call('search_tree', { query: 'Veld', offset: 0 });

    expect(log().slice(1)).toEqual([
      { kind: 'sources-listed', tool: 'get_session', people: 3 },
      { kind: 'person-read', person: marten, given: true },
      { kind: 'relatives-read', person: tessel, given: false },
      { kind: 'tree-searched', query: 'Veld', offset: 0, found: 3 },
    ]);
  });

  it('write to the log no text an AI sent in place of an id or of a reference', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    const text = 'a text of a record, sent as an id';
    await ai.call('get_person', { personId: text });
    await ai.call('get_relatives', { personId: text });
    await ai.call('search_records', question(text, { sourceId: text }));
    await ai.call('get_record', { ref: text });
    await ai.call('propose_match', {
      personId: text,
      ref: text,
      verdict: 'fits',
      confidence: 'low',
      reasons: [{ side: 'for', text: 'A reason.', quote: 'Zwolle' }],
    });

    expect(log().slice(1)).toMatchObject([
      { kind: 'person-read', person: '', given: false },
      { kind: 'relatives-read', person: '', given: false },
      { kind: 'records-searched', person: '', source: '', sent: false },
      { kind: 'record-read', ref: '', given: false },
      { kind: 'proposal-made', person: '', ref: '', accepted: false },
    ]);
    expect(JSON.stringify(log())).not.toContain(text);
  });

  it('are refused by another name, and with what they do not take', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);

    for (const name of ['read_file', 'constructor', '__proto__', '']) {
      expect(await ai.call(name, {}), name).toMatchObject({ ok: false, reason: 'unknown-tool' });
    }
    expect(await ai.call('get_person', { personId: marten, notes: true })).toMatchObject({
      ok: false,
      reason: 'input',
    });
    expect(await ai.call('get_person', 'Marten')).toMatchObject({ ok: false, reason: 'input' });
    expect(await ai.call('search_tree', { query: 7 })).toMatchObject({
      ok: false,
      reason: 'input',
    });
    // Each of them was a call of the session all the same.
    expect(status().calls).toBe(7);
  });
});

describe('a question to a source', () => {
  it('is sent as it was let through, and answered with records that have a reference', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);

    const found = valueOf<Records & { source: object; asked: object; total: number }>(
      await ai.call('search_records', question(marten, { given: ' Marten ', deathYear: 1921 })),
    );

    const sent = new URL(asked[0] ?? '').searchParams;
    expect(asked).toHaveLength(1);
    expect([sent.get('FirstName'), sent.get('LastName')]).toEqual(['Marten', 'Veldkamp']);
    expect([sent.get('BirthDate'), sent.get('DeathDate')]).toEqual(['1850', '1921']);
    expect(found.asked).toEqual({
      given: 'Marten',
      surname: 'Veldkamp',
      birthYear: 1850,
      deathYear: 1921,
    });
    expect(found.source).toMatchObject({ id: 'wikitree', name: 'WikiTree' });
    expect(found.records).toEqual([
      {
        ref: 'r1',
        sourceId: 'wikitree',
        sourceName: 'WikiTree',
        attribution: 'Profile data from WikiTree (wikitree.com)',
        kind: 'person',
        sex: 'M',
        url: 'https://www.wikitree.com/wiki/Veldkamp-90001',
        fields: [
          { name: 'title', value: 'Marten Veldkamp' },
          { name: 'birth date', value: '1 MAR 1850' },
          { name: 'birth place', value: 'Zwolle' },
          { name: 'death date', value: 'ABT 1921' },
        ],
      },
    ]);
    // The living profile and the private one, which the connector left out.
    expect(found.leftOut).toBe(2);
    expect(found.questionsLeft).toBe(AI_SESSION_REQUESTS - 1);
    expect(found.note).toBe(RECORD_TEXT_NOTE);
    expect(JSON.stringify(found)).not.toContain('biography');
  });

  it('is shown to the user as it was asked', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    expect(status().questions).toMatchObject([
      {
        number: 1,
        personId: marten,
        sourceId: 'wikitree',
        query: { given: 'Marten', surname: 'Veldkamp', birthYear: 1850, deathYear: null },
        state: 'answered',
        found: 1,
        cached: false,
        message: '',
      },
    ]);
    expect(status().sources).toMatchObject([{ id: 'wikitree', used: 1 }]);
  });

  it('is logged with what was asked and which records were given, never with their text', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    expect(log().slice(1)).toEqual([
      {
        kind: 'records-searched',
        person: marten,
        source: 'wikitree',
        given: 'Marten',
        surname: 'Veldkamp',
        birthYear: 1850,
        deathYear: null,
        sent: true,
        found: 1,
        outcome: 'answered',
      },
      {
        kind: 'record-read',
        person: marten,
        source: 'wikitree',
        key: 'Veldkamp-90001',
        by: 'search',
      },
    ]);
    expect(JSON.stringify(log())).not.toContain('Zwolle');
  });

  it('is refused for someone the session is not for, and for a source it does not ask', async () => {
    const { marten, tessel } = family();
    agreeToBoth();
    started(marten, ['wikitree']);
    const stranger = createPerson(tree, { name: { given: 'Marten', surname: 'Veldkamp' } }).id;
    addPersonEvent(tree, stranger, { type: 'birth', date: '1850' });

    for (const [personId, sourceId] of [
      [tessel, 'wikitree'],
      [stranger, 'wikitree'],
      ['nobody', 'wikitree'],
      [marten, 'open-archives'],
      [marten, 'loc'],
    ]) {
      expect(
        await ai.call('search_records', question(personId ?? '', { sourceId })),
        `${personId} at ${sourceId}`,
      ).toMatchObject({ ok: false, reason: 'not-in-session' });
    }
    expect(asked).toEqual([]);
    expect(status().questions).toEqual([]);
    expect(status().sources).toMatchObject([{ used: 0 }]);
    // The last of them: the person is of the session, the source is not.
    expect(log().at(-1)).toMatchObject({
      kind: 'records-searched',
      person: marten,
      source: '',
      sent: false,
      found: 0,
    });
  });

  it('is refused under another name, with a word that rides along, and for years too far off', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);

    for (const extra of [
      { given: 'Jikke', surname: 'Zandstra' },
      { given: 'Marten Tessel Oort' },
      { surname: 'Veldkamp Zwolle' },
      { given: 'Martentesseloort' },
      { given: "Marten.'-.'-" },
      { birthYear: 1861 },
      { deathYear: 1932 },
      { birthYear: 2030 },
    ]) {
      expect(
        await ai.call('search_records', question(marten, extra)),
        JSON.stringify(extra),
      ).toMatchObject({ ok: false, reason: 'query' });
    }
    expect(asked).toEqual([]);
    expect(status().sources).toMatchObject([{ used: 0 }]);
    expect(log().at(-1)).toMatchObject({ kind: 'records-searched', outcome: 'query-years' });
  });

  it('may be asked under any name the tree has for the person', async () => {
    const { marten } = family();
    addName(tree, marten, { type: 'aka', given: 'Martinus', surname: 'Veltcamp' });
    agreeToBoth();
    started(marten);

    expect(
      (
        await ai.call(
          'search_records',
          question(marten, { given: 'Martinus', surname: 'Veltcamp' }),
        )
      ).ok,
    ).toBe(true);
    expect(new URL(asked[0] ?? '').searchParams.get('LastName')).toBe('Veltcamp');
  });

  it('counts against the ten a session has for a source, and the eleventh is refused', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten, ['wikitree', 'open-archives']);

    for (let number = 0; number < AI_SESSION_REQUESTS; number += 1) {
      // Another year each time, so that the app has no answer of its own to give.
      const answer = await ai.call(
        'search_records',
        question(marten, { birthYear: 1841 + number }),
      );
      expect(valueOf<Records>(answer).questionsLeft).toBe(AI_SESSION_REQUESTS - 1 - number);
    }
    expect(await ai.call('search_records', question(marten, { birthYear: 1855 }))).toMatchObject({
      ok: false,
      reason: 'budget',
    });
    expect(askedOf('api.wikitree.com')).toHaveLength(AI_SESSION_REQUESTS);
    // The other source has its own ten.
    expect(
      (await ai.call('search_records', question(marten, { sourceId: 'open-archives' }))).ok,
    ).toBe(true);
    expect(askedOf('api.openarchieven.nl')).toHaveLength(1);
    expect(status().sources).toMatchObject([
      { id: 'wikitree', used: AI_SESSION_REQUESTS },
      { id: 'open-archives', used: 1 },
    ]);
  });

  it('takes none of the ten when the app still had the answer', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    const again = valueOf<Records>(await ai.call('search_records', question(marten)));

    expect(asked).toHaveLength(1);
    expect(again.fromEarlierAnswer).toBe(true);
    expect(again.questionsLeft).toBe(AI_SESSION_REQUESTS - 1);
    // The same record keeps its reference.
    expect(again.records.map(({ ref }) => ref)).toEqual(['r1']);
    expect(status().questions[1]).toMatchObject({ state: 'answered', cached: true, found: 1 });
    expect(log().filter((entry) => entry.kind === 'records-searched')[1]).toMatchObject({
      sent: false,
      outcome: 'answered',
    });
  });

  it('waits a second after the question before it at the same source', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten, ['wikitree', 'open-archives']);

    await ai.call('search_records', question(marten));
    expect(waits).toEqual([]);
    await ai.call('search_records', question(marten, { sourceId: 'open-archives' }));
    // Another source is not waited for.
    expect(waits).toEqual([]);
    await ai.call('search_records', question(marten, { birthYear: 1851 }));

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(AI_SESSION_GAP_MS - 500);
    expect(waits[0]).toBeLessThanOrEqual(AI_SESSION_GAP_MS);
  });

  it('goes to a source one after the other, when two are asked at once', async () => {
    const { marten } = family();
    let underWay = 0;
    let most = 0;
    // A source that answers only when the test lets it.
    const release: (() => void)[] = [];
    records = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => {
        asked.push(url);
        underWay += 1;
        most = Math.max(most, underWay);
        return new Promise((resolve) => {
          release.push(() => {
            underWay -= 1;
            resolve(usualAnswer(url));
          });
        });
      },
    });
    ai = new AiSessionService(records, { appDb, wait: () => Promise.resolve() });
    agreeToBoth();
    started(marten);

    const both = Promise.all([
      ai.call('search_records', question(marten, { birthYear: 1851 })),
      ai.call('search_records', question(marten, { birthYear: 1852 })),
    ]);
    // The first is on its way; the second waits for it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(1);
    expect(status().sources).toMatchObject([{ used: 2 }]);
    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(2);
    release.shift()?.();

    expect((await both).map((answer) => answer.ok)).toEqual([true, true]);
    expect(most).toBe(1);
  });

  it('counts when the source did not answer, and says so', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    answerOf = () => new Response('no', { status: 500 });

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(status().questions).toMatchObject([{ state: 'failed', found: 0 }]);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().at(-1)).toMatchObject({ kind: 'records-searched', sent: true, found: 0 });
  });

  it('is not sent for someone who came to count as living while it waited', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    whileWaiting = () => {
      updatePerson(tree, marten, { living: true });
    };

    expect(await ai.call('search_records', question(marten, { birthYear: 1851 }))).toMatchObject({
      ok: false,
      reason: 'not-given',
    });

    expect(asked).toHaveLength(1);
    expect(status().questions[1]).toMatchObject({ state: 'not-sent' });
    // The question was given back to the session.
    expect(status().sources).toMatchObject([{ used: 1 }]);
  });

  it('is not sent when the person was given another name or other years while it waited', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    // The year of birth is put a century back: 1851 is no longer near it.
    whileWaiting = () => {
      const birth = listPersonEvents(tree, marten).find((event) => event.type === 'birth');
      updateEvent(tree, birth?.id ?? '', { date: '1750' });
    };
    expect(await ai.call('search_records', question(marten, { birthYear: 1851 }))).toMatchObject({
      ok: false,
      reason: 'not-sent',
    });

    // And the name is made another.
    whileWaiting = () => {
      updateName(tree, listNames(tree, marten)[0]?.id ?? '', {
        given: 'Jikke',
        surname: 'Zandstra',
      });
    };
    expect(await ai.call('search_records', question(marten, { birthYear: 1752 }))).toMatchObject({
      ok: false,
      reason: 'not-sent',
    });

    expect(asked).toHaveLength(1);
    expect(status().questions.map(({ state }) => state)).toEqual([
      'answered',
      'not-sent',
      'not-sent',
    ]);
    expect(status().sources).toMatchObject([{ used: 1 }]);
  });

  it('is not sent when the session was stopped while it waited', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    whileWaiting = () => ai.stop();

    expect(await ai.call('search_records', question(marten, { birthYear: 1851 }))).toMatchObject({
      ok: false,
      reason: 'no-session',
    });

    expect(asked).toHaveLength(1);
    expect(status()).toMatchObject({ status: 'ended', ended: 'stopped' });
    expect(status().questions[1]).toMatchObject({ state: 'not-sent' });
  });

  it('gives its answer to nobody when the session ended while the source was asked', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    answerOf = (url) => {
      ai.stop();
      return usualAnswer(url);
    };

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(await ai.call('get_record', { ref: 'r1' })).toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(log().filter((entry) => entry.kind === 'record-read')).toEqual([]);
    // It went out all the same: it is shown as that, stays counted, and is in the log.
    expect(asked).toHaveLength(1);
    expect(status().questions).toMatchObject([{ state: 'failed', found: 0 }]);
    expect(status().questions[0]?.message).toMatch(/on its way/);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().slice(-2)).toMatchObject([
      { kind: 'session-ended', why: 'stopped' },
      { kind: 'records-searched', person: marten, sent: true, found: 0, outcome: 'cancelled' },
    ]);
  });

  /** A source that answers only when the test lets it. The clock of the session runs `ahead`. */
  function heldSource(): (() => void)[] {
    const release: (() => void)[] = [];
    records = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => {
        asked.push(url);
        return new Promise((resolve) => {
          release.push(() => resolve(usualAnswer(url)));
        });
      },
    });
    let sessions = 0;
    ai = new AiSessionService(records, {
      appDb,
      now: () => Date.now() + ahead,
      wait: () => Promise.resolve(),
      newId: () => {
        sessions += 1;
        return `held-${sessions}`;
      },
    });
    return release;
  }

  const soon = () => new Promise((resolve) => setTimeout(resolve, 20));

  for (const [why, end] of [
    ['stopped', () => ai.stop()],
    ['withdrawn', () => ai.withdraw()],
    ['tree-closed', () => ai.clear()],
    ['replaced', (personId: string) => void started(personId)],
  ] as const) {
    it(`is counted and logged when it was on its way as the session ended (${why})`, async () => {
      const { marten } = family();
      const release = heldSource();
      agreeToBoth();
      started(marten);
      const answer = ai.call('search_records', question(marten));
      const waiting = ai.call('search_records', question(marten, { birthYear: 1851 }));
      await soon();
      expect(asked).toHaveLength(1);

      end(marten);
      release.shift()?.();

      expect(await answer).toMatchObject({ ok: false, reason: 'no-session' });
      // The one that waited for its turn is never sent.
      expect(await waiting).toMatchObject({ ok: false, reason: 'no-session' });
      await ai.idle();
      expect(asked).toHaveLength(1);
      const entries = listAiActivity(appDb, { sessionId: 'held-1' })
        .reverse()
        .map((entry) => ({ kind: entry.kind, ...entry.detail }));
      expect(entries).toMatchObject([
        { kind: 'session-started' },
        { kind: 'session-ended', why },
        { kind: 'records-searched', birthYear: 1850, sent: true, found: 0, outcome: 'cancelled' },
      ]);
    });
  }

  it('gives nothing, and sends nothing more, once the session ran out of time meanwhile', async () => {
    const { marten } = family();
    const release = heldSource();
    agreeToBoth();
    started(marten);
    const first = ai.call('search_records', question(marten, { birthYear: 1851 }));
    const second = ai.call('search_records', question(marten, { birthYear: 1852 }));
    await soon();
    expect(asked).toHaveLength(1);

    // No call came for a quarter of an hour while the first was on its way.
    ahead = AI_SESSION_IDLE_MS;
    release.shift()?.();

    expect(await first).toMatchObject({ ok: false, reason: 'no-session' });
    expect(await second).toMatchObject({ ok: false, reason: 'no-session' });
    expect(asked).toHaveLength(1);
    expect(status()).toMatchObject({ status: 'ended', ended: 'idle' });
    expect(status().questions.map(({ state }) => state)).toEqual(['answered', 'not-sent']);
    expect(status().questions[0]).toMatchObject({ found: 0 });
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().slice(-2)).toMatchObject([
      { kind: 'session-ended', why: 'idle' },
      { kind: 'records-searched', birthYear: 1851, sent: true, found: 0, outcome: 'dropped' },
    ]);
    expect(await ai.call('get_record', { ref: 'r1' })).toMatchObject({ reason: 'no-session' });
  });

  it('takes the last of the ten once, when two ask for it at once', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    for (let number = 0; number < AI_SESSION_REQUESTS - 1; number += 1) {
      await ai.call('search_records', question(marten, { birthYear: 1841 + number }));
    }

    const both = await Promise.all([
      ai.call('search_records', question(marten, { birthYear: 1850 })),
      ai.call('search_records', question(marten, { birthYear: 1851 })),
    ]);

    expect(both.map((answer) => (answer.ok ? 'answered' : answer.reason))).toEqual([
      'answered',
      'budget',
    ]);
    expect(asked).toHaveLength(AI_SESSION_REQUESTS);
    expect(status().sources).toMatchObject([{ used: AI_SESSION_REQUESTS }]);
  });

  it('counts when the source could not be reached', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    answerOf = () => {
      throw new TypeError('fetch failed');
    };

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(status().questions).toMatchObject([{ state: 'failed' }]);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().at(-1)).toMatchObject({
      kind: 'records-searched',
      sent: true,
      outcome: 'offline',
    });
  });

  it('counts the question a source answers with a pause, and none that is held back for it', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    answerOf = () => new Response('', { status: 429, headers: { 'retry-after': '120' } });

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(status().sources).toMatchObject([{ used: 1 }]);
    // The source is left alone now: the next question does not leave, and is given back.
    expect(await ai.call('search_records', question(marten, { birthYear: 1851 }))).toMatchObject({
      ok: false,
      reason: 'not-sent',
    });

    expect(asked).toHaveLength(1);
    expect(status().questions.map(({ state }) => state)).toEqual(['failed', 'not-sent']);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(
      log()
        .filter((entry) => entry.kind === 'records-searched')
        .map((entry) => ({ ...entry })),
    ).toMatchObject([
      { sent: true, outcome: 'paused' },
      { sent: false, outcome: 'paused' },
    ]);
  });

  it('gives its answer to nobody when the person came to count as living while the source was asked', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    answerOf = (url) => {
      updatePerson(tree, marten, { living: true });
      return usualAnswer(url);
    };

    expect(await ai.call('search_records', question(marten))).toMatchObject({
      ok: false,
      reason: 'not-given',
    });

    // It went out, so it counts; nothing of the answer is kept or logged as read.
    expect(asked).toHaveLength(1);
    expect(status().questions).toMatchObject([{ state: 'answered', found: 0 }]);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().at(-1)).toMatchObject({
      kind: 'records-searched',
      sent: true,
      found: 0,
      outcome: 'not-given',
    });
    updatePerson(tree, marten, { living: false });
    expect(await ai.call('get_record', { ref: 'r1' })).toMatchObject({
      ok: false,
      reason: 'record',
    });
  });

  it('stays counted, and holds nothing up, when the search fails in a way it should not', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    vi.spyOn(records, 'searchForAi').mockImplementationOnce(() => {
      throw new Error('the file of the tree is gone');
    });

    const failed = await ai.call('search_records', question(marten));

    expect(failed).toMatchObject({ ok: false, reason: 'failed' });
    expect(JSON.stringify(failed)).not.toContain('gone');
    expect(status().questions).toMatchObject([{ state: 'failed' }]);
    expect(status().sources).toMatchObject([{ used: 1 }]);
    expect(log().at(-1)).toMatchObject({ kind: 'records-searched', sent: true, outcome: 'error' });
    // The next question to the source has its turn.
    expect((await ai.call('search_records', question(marten, { birthYear: 1851 }))).ok).toBe(true);
  });
});

describe('a record read again, and a proposal about it', () => {
  const proposal = (personId: string, ref: string, extra: object = {}) => ({
    personId,
    ref,
    verdict: 'fits',
    confidence: 'high',
    reasons: [
      { side: 'for', text: 'He was born in the same place.', quote: 'Zwolle' },
      { side: 'for', text: 'The tree has the same day.', quote: '1 MAR 1850' },
    ],
    ...extra,
  });

  it('gives a record of the session again by its reference', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    const found = valueOf<Records>(await ai.call('search_records', question(marten)));

    const again = valueOf<{ ref: string; personId: string; fields: unknown[]; note: string }>(
      await ai.call('get_record', { ref: 'r1' }),
    );

    expect(again).toMatchObject({ ref: 'r1', personId: marten, note: RECORD_TEXT_NOTE });
    expect(again.fields).toEqual(found.records[0]?.fields);
    expect(await ai.call('get_record', { ref: 'r2' })).toMatchObject({
      ok: false,
      reason: 'record',
    });
    expect(asked).toHaveLength(1);
    expect(log().slice(-2)).toEqual([
      { kind: 'record-read', person: marten, source: 'wikitree', key: 'Veldkamp-90001', by: 'get' },
      // A reference of the right form is written down, though it names nothing.
      { kind: 'record-read', ref: 'r2', by: 'get', given: false },
    ]);
  });

  it('gives a record that reads otherwise now a reference of its own, and keeps the earlier reading', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    // The source has another place of birth for the same profile now.
    answerOf = () =>
      new Response(
        JSON.stringify([
          { status: 0, total: 1, matches: [profile(1, { BirthLocation: 'Voorbeeldstad' })] },
        ]),
      );

    const later = valueOf<Records>(
      await ai.call('search_records', question(marten, { birthYear: 1851 })),
    );
    const again = valueOf<Records>(
      await ai.call('search_records', question(marten, { birthYear: 1852 })),
    );

    expect(later.records.map(({ ref }) => ref)).toEqual(['r2']);
    // The same reading again keeps its reference.
    expect(again.records.map(({ ref }) => ref)).toEqual(['r2']);
    const first = valueOf<{ fields: unknown[] }>(await ai.call('get_record', { ref: 'r1' }));
    expect(JSON.stringify(first.fields)).toContain('Zwolle');
    expect(JSON.stringify(first.fields)).not.toContain('Voorbeeldstad');
    // A quote is held against the reading its reference gave, and no other.
    const quote = (ref: string, place: string) =>
      ai.call(
        'propose_match',
        proposal(marten, ref, {
          reasons: [{ side: 'for', text: 'The place of birth.', quote: place }],
        }),
      );
    expect(await quote('r1', 'Voorbeeldstad')).toMatchObject({ ok: false, reason: 'proposal' });
    expect(await quote('r2', 'Zwolle')).toMatchObject({ ok: false, reason: 'proposal' });
    expect((await quote('r1', 'Zwolle')).ok).toBe(true);
    expect((await quote('r2', 'Voorbeeldstad')).ok).toBe(true);
    expect(
      ai
        .proposals()
        .map(({ ref }) => ref)
        .sort(),
    ).toEqual(['r1', 'r2']);
  });

  it('files a proposal whose reasons quote the record, for the user to look at', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    const filed = valueOf<{ filed: boolean; reasonsKept: number; reasonsDropped: unknown[] }>(
      await ai.call(
        'propose_match',
        proposal(marten, 'r1', {
          reasons: [
            { side: 'for', text: 'He was born in the same place.', quote: 'zwolle' },
            { side: 'for', text: 'The record names his wife.', quote: 'Jikke Zandstra' },
          ],
        }),
      ),
    );

    expect(filed).toMatchObject({ filed: true, reasonsKept: 1 });
    // The reason whose quote is not in the record is told, and does not count.
    expect(filed.reasonsDropped).toEqual([
      { side: 'for', quote: 'Jikke Zandstra', why: 'not-in-record' },
    ]);
    expect(ai.proposals()).toMatchObject([
      {
        ref: 'r1',
        personId: marten,
        sourceId: 'wikitree',
        key: 'Veldkamp-90001',
        verdict: 'fits',
        confidence: 'high',
        reasons: [{ side: 'for', quote: 'Zwolle', field: 'birth place' }],
        dropped: [{ quote: 'Jikke Zandstra' }],
        record: { url: 'https://www.wikitree.com/wiki/Veldkamp-90001' },
      },
    ]);
    expect(status().proposals).toBe(1);
    // Nothing was written into the tree.
    expect(tree.db.prepare('SELECT count(*) FROM record_mark').pluck().get()).toBe(0);
  });

  it('refuses a proposal none of whose reasons quotes the record', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    const refused = await ai.call(
      'propose_match',
      proposal(marten, 'r1', {
        reasons: [{ side: 'for', text: 'It must be him.', quote: 'Utrecht' }],
      }),
    );

    expect(refused).toMatchObject({
      ok: false,
      reason: 'proposal',
      detail: { dropped: [{ quote: 'Utrecht', why: 'not-in-record' }] },
    });
    expect(ai.proposals()).toEqual([]);
  });

  it('refuses a proposal about a record that was not found for that person', async () => {
    const { marten, douwe } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));

    for (const [personId, ref] of [
      [douwe, 'r1'],
      [marten, 'r9'],
      ['nobody', 'r1'],
    ]) {
      expect(
        await ai.call('propose_match', proposal(personId ?? '', ref ?? '')),
        `${personId} ${ref}`,
      ).toMatchObject({ ok: false, reason: 'record' });
    }
    expect(ai.proposals()).toEqual([]);
  });

  it('gives and takes nothing about a record of someone who came to count as living', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    updatePerson(tree, marten, { living: true });

    expect(await ai.call('get_record', { ref: 'r1' })).toMatchObject({
      ok: false,
      reason: 'not-given',
    });
    expect(await ai.call('propose_match', proposal(marten, 'r1'))).toMatchObject({
      ok: false,
      reason: 'not-given',
    });
    expect(ai.proposals()).toEqual([]);
  });

  it('keeps the later of two proposals about one record', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    await ai.call('propose_match', proposal(marten, 'r1'));

    await ai.call(
      'propose_match',
      proposal(marten, 'r1', {
        verdict: 'may-fit',
        confidence: 'low',
        reasons: [{ side: 'against', text: 'The year of death is a guess.', quote: 'ABT 1921' }],
      }),
    );

    expect(ai.proposals()).toMatchObject([
      { ref: 'r1', verdict: 'may-fit', confidence: 'low', reasons: [{ side: 'against' }] },
    ]);
  });

  it('logs a proposal by its verdict and its counts, never with the words of a reason', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    await ai.call('propose_match', proposal(marten, 'r1'));
    await ai.call('propose_match', proposal(marten, 'r9'));

    expect(log().slice(-2)).toEqual([
      {
        kind: 'proposal-made',
        person: marten,
        source: 'wikitree',
        key: 'Veldkamp-90001',
        verdict: 'fits',
        confidence: 'high',
        accepted: true,
        kept: 2,
        dropped: 0,
        outcome: 'accepted',
      },
      { kind: 'proposal-made', person: marten, ref: 'r9', accepted: false, outcome: 'record' },
    ]);
    expect(JSON.stringify(log())).not.toContain('same place');
  });

  it('keeps the proposals after the session ended, until the tree closes', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('search_records', question(marten));
    await ai.call('propose_match', proposal(marten, 'r1'));

    ai.stop();
    expect(ai.proposals()).toHaveLength(1);
    expect(status()).toMatchObject({ status: 'ended', proposals: 1 });

    ai.clear();
    expect(ai.proposals()).toEqual([]);
    expect(ai.status()).toBeNull();
  });
});

describe('the proposals the user is shown', () => {
  const proposal = (personId: string, ref: string, extra: object = {}) => ({
    personId,
    ref,
    verdict: 'fits',
    confidence: 'high',
    reasons: [{ side: 'for', text: 'He was born in the same place.', quote: 'Zwolle' }],
    ...extra,
  });

  /** A session for one person with one proposal about the first record WikiTree gave. */
  async function proposedIn(personId: string): Promise<void> {
    started(personId);
    await ai.call('search_records', question(personId));
    valueOf(await ai.call('propose_match', proposal(personId, 'r1')));
  }

  it('hold the record as it read when the AI was given it, and when it was read', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);

    const [held] = ai.proposals();
    expect(held).toMatchObject({
      sessionId: 'session-1',
      ref: 'r1',
      external: {
        connectorId: 'wikitree',
        key: 'Veldkamp-90001',
        kind: 'person',
        url: 'https://www.wikitree.com/wiki/Veldkamp-90001',
      },
    });
    expect(Math.abs((held?.readAt ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(ai.proposal({ sessionId: 'session-1', ref: 'r1' })).toEqual(held);
    // Another session, or another reference, names nothing.
    expect(ai.proposal({ sessionId: 'session-2', ref: 'r1' })).toBeNull();
    expect(ai.proposal({ sessionId: 'session-1', ref: 'r2' })).toBeNull();
  });

  it('stay when another session starts, and are told apart by their session', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);
    const before = ai.state().proposalsRevision;

    ahead += 1000;
    await proposedIn(marten);

    expect(ai.proposals().map(({ sessionId, ref }) => [sessionId, ref])).toEqual([
      ['session-2', 'r1'],
      ['session-1', 'r1'],
    ]);
    expect(ai.state()).toMatchObject({ proposals: 2, session: { sessionId: 'session-2' } });
    expect(ai.state().proposalsRevision).toBeGreaterThan(before);
    // The session itself counts its own.
    expect(status().proposals).toBe(1);

    ai.clear();
    expect(ai.proposals()).toEqual([]);
    expect(ai.state()).toMatchObject({ session: null, proposals: 0 });
  });

  it('are all forgotten when the assistant is turned off', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);
    await proposedIn(marten);

    ai.withdraw();

    expect(ai.proposals()).toEqual([]);
    expect(ai.state().session).toBeNull();
  });

  it('can be forgotten one at a time, of the session or of one before it', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);
    await proposedIn(marten);
    const before = ai.state().proposalsRevision;

    expect(ai.dismiss({ sessionId: 'session-1', ref: 'r1' })).toBe(true);
    expect(ai.proposals().map(({ sessionId }) => sessionId)).toEqual(['session-2']);
    expect(ai.state().proposalsRevision).toBe(before + 1);
    // Forgetting it again, or one that never was, changes nothing.
    expect(ai.dismiss({ sessionId: 'session-1', ref: 'r1' })).toBe(false);
    expect(ai.dismiss({ sessionId: 'session-9', ref: 'r1' })).toBe(false);
    expect(ai.state().proposalsRevision).toBe(before + 1);

    expect(ai.dismiss({ sessionId: 'session-2', ref: 'r1' })).toBe(true);
    expect(ai.proposals()).toEqual([]);
    // Nothing of it reached the tree.
    expect(tree.db.prepare('SELECT count(*) FROM record_mark').pluck().get()).toBe(0);
  });

  it('are not listed for someone who is no longer in the tree, and come back with them', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);

    deletePerson(tree, marten);
    expect(ai.proposals()).toEqual([]);
    expect(ai.state().proposals).toBe(0);

    tree.undo();
    expect(ai.proposals()).toHaveLength(1);
  });

  it('are not listed once the tree is no longer the open one', async () => {
    const { marten } = family();
    agreeToBoth();
    await proposedIn(marten);

    open = false;

    expect(ai.proposals()).toEqual([]);
  });
});

describe('the assistant as the page is told of it', () => {
  it('says whether it is on, what a session may ask, and that it has no connector unless it was given one', () => {
    expect(ai.info()).toMatchObject({
      agreed: false,
      searchAgreed: false,
      canConnect: false,
      session: null,
      proposals: 0,
      requestsPerSource: AI_SESSION_REQUESTS,
      idleMinutes: 15,
      maxCalls: AI_SESSION_CALLS,
      logDays: 90,
    });
    expect(
      ai
        .info()
        .sources.map((source) => source.id)
        .sort(),
    ).toEqual(['open-archives', 'wikidata', 'wikitree']);

    agreeToBoth();
    expect(ai.info()).toMatchObject({ agreed: true, searchAgreed: true });
  });
});

describe('the activity log as the user reads it', () => {
  it('says in words what was asked and given, with names of the open tree and no text of a record', async () => {
    const { marten, tessel } = family();
    agreeToBoth();
    started(marten);
    await ai.call('get_session', {});
    await ai.call('search_tree', { query: 'Veldkamp' });
    await ai.call('get_person', { personId: marten });
    await ai.call('get_person', { personId: tessel });
    await ai.call('get_relatives', { personId: 'nobody' });
    await ai.call('search_records', question(marten));
    await ai.call('search_records', question(marten, { surname: 'Brouwer' }));
    await ai.call('get_record', { ref: 'r9' });
    await ai.call('propose_match', {
      personId: marten,
      ref: 'r1',
      verdict: 'may-fit',
      confidence: 'low',
      reasons: [
        { side: 'for', text: 'He was born in the same place.', quote: 'Zwolle' },
        { side: 'for', text: 'The record names his wife.', quote: 'Jikke Zandstra' },
      ],
    });
    ai.stop();

    const page = ai.activity({ offset: 0, limit: 50 }, tree);
    expect(page.total).toBe(page.items.length);
    expect(page.items.every((item) => item.thisTree && item.sessionId === 'session-1')).toBe(true);
    expect(page.items.map((item) => item.what).reverse()).toEqual([
      'A session started for Marten Veldkamp and 2 generations of their ancestors: 3 people. It may ask WikiTree.',
      'The AI asked what the session is for.',
      'The AI searched the tree for "Veldkamp": 3 people given.',
      'The AI read Marten Veldkamp.',
      'The AI asked for Tessel Oort. Nothing was given: they may be living.',
      'The AI asked for the relatives of someone who is not in the tree. Nothing was given.',
      'The AI asked WikiTree for "Marten Veldkamp", born 1850, for Marten Veldkamp: 1 record given.',
      'The AI was given record Veldkamp-90001 of WikiTree, found for Marten Veldkamp.',
      'The AI asked WikiTree for "Marten Brouwer", born 1850, for Marten Veldkamp: not sent, since the name or the years were too far from what the tree has for the person.',
      'The AI asked for a record that it is not given.',
      'The AI proposed that record Veldkamp-90001 of WikiTree may be of Marten Veldkamp, and said it is unsure: 1 reason passed the check, 1 did not.',
      'The session ended: you stopped it. 9 calls, 1 question to services, 1 proposal.',
    ]);
    // Nothing a record says, and nothing a reason says, is in it.
    expect(JSON.stringify(page)).not.toContain('Zwolle');
    expect(JSON.stringify(page)).not.toContain('same place');
  });

  it('names nobody for an entry of another tree, and is read without an open tree', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    await ai.call('get_person', { personId: marten });
    ai.stop();

    const other = openTree(':memory:');
    try {
      const page = ai.activity({ offset: 0, limit: 50 }, other);
      expect(page.items.every((item) => !item.thisTree)).toBe(true);
      expect(page.items.map((item) => item.what)).toContain(
        'The AI read a person of another tree.',
      );
      expect(JSON.stringify(page)).not.toContain('Veldkamp');
    } finally {
      other.close();
    }
    const closed = ai.activity({ offset: 0, limit: 50 }, null);
    expect(closed.items).toHaveLength(3);
    expect(JSON.stringify(closed)).not.toContain('Veldkamp');
  });

  it('is handed over in pages, the latest first, and can be cleared', async () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    for (let call = 0; call < 5; call += 1) await ai.call('list_sources', {});

    const first = ai.activity({ offset: 0, limit: 2 }, tree);
    const second = ai.activity({ offset: 2, limit: 2 }, tree);
    expect(first.total).toBe(6);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.id ?? 0).toBeGreaterThan(second.items[0]?.id ?? 0);
    // What does not say a page is taken as the least one.
    expect(ai.activity({ offset: -5, limit: 0 }, tree).items).toHaveLength(1);

    ai.clearActivity();
    expect(ai.activity({ offset: 0, limit: 50 }, tree)).toEqual({ items: [], total: 0 });
    // A session that is under way goes on, and writes into the empty log.
    expect(await ai.call('list_sources', {})).toMatchObject({ ok: true });
    expect(ai.activity({ offset: 0, limit: 50 }, tree).total).toBe(1);
  });
});

describe('a session and the way an AI app reaches it', () => {
  /** Stands in for the pipe: notes when it is opened and closed, and lets a test connect a program. */
  class FakeBridge implements AiBridge {
    opened = 0;
    closed = 0;
    listening = false;
    clients: AiClientInfo[] = [];
    #client: (client: AiClientInfo) => void = () => undefined;
    #change: () => void = () => undefined;
    open(): void {
      this.opened += 1;
      this.listening = true;
    }
    close(): void {
      this.closed += 1;
      this.listening = false;
      this.clients = [];
    }
    state() {
      return { open: this.listening, problem: '', clients: this.clients };
    }
    onClient(listener: (client: AiClientInfo) => void): void {
      this.#client = listener;
    }
    onChange(listener: () => void): void {
      this.#change = listener;
    }
    connect(name: string, version = '1.0'): void {
      const client = { name, version, since: 5 };
      this.clients = [...this.clients, client];
      this.#client(client);
      this.#change();
    }
  }

  let bridge: FakeBridge;

  beforeEach(() => {
    bridge = new FakeBridge();
    let sessions = 0;
    ai = new AiSessionService(records, {
      appDb,
      now: () => Date.now() + ahead,
      wait: () => Promise.resolve(),
      newId: () => {
        sessions += 1;
        return `bridged-${sessions}`;
      },
      bridge,
      connector: {
        file: 'C:\\app\\rulz-ancestry.mcpb',
        fileFits: false,
        command: 'claude mcp add rulz-ancestry',
      },
    });
  });

  it('can be reached from the start of a session, and not before', () => {
    const { marten } = family();
    expect(ai.state().connection).toEqual({ open: false, problem: '', clients: [] });
    // Turning the assistant on opens nothing, and neither does a start that is refused.
    ai.agree();
    expect(begin(marten).ok).toBe(false);
    expect(bridge.opened).toBe(0);

    agreeToBoth();
    started(marten);
    expect(bridge.opened).toBe(1);
    expect(ai.state().connection.open).toBe(true);
  });

  it('cannot be reached once it has ended, however it ended', async () => {
    const { marten } = family();
    agreeToBoth();

    started(marten);
    ai.stop();
    expect(bridge.listening).toBe(false);

    started(marten);
    expect(bridge.listening).toBe(true);
    ahead = AI_SESSION_IDLE_MS;
    expect(status().ended).toBe('idle');
    expect(bridge.listening).toBe(false);

    started(marten);
    for (let call = 0; call <= AI_SESSION_CALLS; call += 1) await ai.call('get_session', {});
    expect(status().ended).toBe('calls');
    expect(bridge.listening).toBe(false);

    started(marten);
    open = false;
    expect(status().ended).toBe('tree-closed');
    expect(bridge.listening).toBe(false);
    open = true;

    started(marten);
    ai.withdraw();
    expect(bridge.listening).toBe(false);
  });

  it('gets a new way in when another session takes its place', () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    const closedBefore = bridge.closed;
    started(marten);
    expect(bridge.closed).toBe(closedBefore + 1);
    expect(bridge.opened).toBe(2);
    expect(bridge.listening).toBe(true);
  });

  it('notes a program that connects, by the name it gives itself', () => {
    const { marten } = family();
    agreeToBoth();
    const { revision } = started(marten);

    bridge.connect('  Claude\nDesktop  ', '0.9');
    expect(status().revision).toBeGreaterThan(revision);
    expect(ai.state().connection.clients).toEqual([
      { name: '  Claude\nDesktop  ', version: '0.9', since: 5 },
    ]);
    expect(log().at(-1)).toEqual({
      kind: 'app-connected',
      name: 'Claude Desktop',
      version: '0.9',
      number: 1,
    });
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toBe(
      'A program connected to the session. It calls itself "Claude Desktop" (version 0.9).',
    );
    bridge.connect('', '');
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toBe(
      'A program connected to the session. It gave no name.',
    );
  });

  it('writes only the first few programs that connect to the log', () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    for (let index = 0; index < AI_SESSION_CLIENTS_LOGGED + 30; index += 1) {
      bridge.connect(`program ${index}`);
    }
    expect(log().filter((entry) => entry.kind === 'app-connected')).toHaveLength(
      AI_SESSION_CLIENTS_LOGGED,
    );
    // The session goes on.
    expect(status().status).toBe('running');
  });

  it('notes nothing of a program outside a session', () => {
    const { marten } = family();
    agreeToBoth();
    bridge.connect('early');
    started(marten);
    ai.stop();
    const entries = log().length;
    bridge.connect('late');
    expect(log()).toHaveLength(entries);
  });

  it('ends after two hours at the latest, whatever calls come', async () => {
    const { marten } = family();
    agreeToBoth();
    const { startedAt, lastsUntil } = started(marten);
    expect(lastsUntil).toBe(startedAt + AI_SESSION_MAX_MS);
    expect(AI_SESSION_MAX_MS).toBe(2 * 60 * 60 * 1000);

    // A call every ten minutes keeps it from ending for want of calls.
    for (ahead = 0; ahead < AI_SESSION_MAX_MS - 1000; ahead += 10 * 60 * 1000) {
      expect((await ai.call('get_session', {})).ok).toBe(true);
    }
    ahead = AI_SESSION_MAX_MS;
    expect(await ai.call('get_session', {})).toMatchObject({ ok: false, reason: 'no-session' });
    expect(status()).toMatchObject({
      status: 'ended',
      ended: 'time',
      endedMessage: 'The session lasted as long as one may, so it ended.',
      lastsUntil: null,
    });
    expect(bridge.listening).toBe(false);
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toContain(
      'The session ended: it lasted as long as a session may.',
    );
  });

  it('is not kept alive by a call that names no tool, or sends what its tool does not take', async () => {
    const { marten } = family();
    agreeToBoth();
    const { idleAt } = started(marten);
    ahead = AI_SESSION_IDLE_MS - 1000;
    expect(await ai.call('keep_alive', {})).toMatchObject({ ok: false, reason: 'unknown-tool' });
    expect(await ai.call('get_person', { id: marten })).toMatchObject({
      ok: false,
      reason: 'input',
    });
    expect(await ai.call('get_session', { more: 1 })).toMatchObject({ ok: false, reason: 'input' });
    expect(status().idleAt).toBe(idleAt);
    // They are counted all the same.
    expect(status().calls).toBe(3);

    ahead += 1000;
    expect(status()).toMatchObject({ status: 'ended', ended: 'idle' });
  });

  it('ends with the app, and says so', () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    ai.stop('quit');
    expect(status()).toMatchObject({
      status: 'ended',
      ended: 'quit',
      endedMessage: 'The app was closed, so the session ended.',
    });
    expect(bridge.listening).toBe(false);
    expect(log().at(-1)).toMatchObject({ kind: 'session-ended', why: 'quit' });
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toContain(
      'The session ended: the app was closed.',
    );
  });

  it('says that it ended for want of calls when that came first, however late anybody looks', () => {
    const { marten } = family();
    agreeToBoth();
    const { idleAt } = started(marten);
    ahead = AI_SESSION_MAX_MS + 60 * 60 * 1000;
    expect(status()).toMatchObject({ status: 'ended', ended: 'idle' });
    expect(log().at(-1)).toMatchObject({ kind: 'session-ended', why: 'idle' });
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.at).toBe(idleAt);
  });

  it('says why it had ended already when it is stopped after its time', () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    ahead = AI_SESSION_IDLE_MS;
    ai.stop('quit');
    expect(log().at(-1)).toMatchObject({ kind: 'session-ended', why: 'idle' });
  });

  it('ends when its time is up, also when nobody asks how it stands', () => {
    vi.useFakeTimers();
    try {
      const { marten } = family();
      agreeToBoth();
      started(marten);
      vi.advanceTimersByTime(AI_SESSION_IDLE_MS - 60 * 1000);
      expect(bridge.listening).toBe(true);
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(bridge.listening).toBe(false);
      expect(log().at(-1)).toMatchObject({ kind: 'session-ended', why: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says at its end how often a program connected to it', () => {
    const { marten } = family();
    agreeToBoth();
    started(marten);
    bridge.connect('one');
    bridge.connect('two');
    ai.stop();
    expect(log().at(-1)).toMatchObject({ kind: 'session-ended', programs: 2 });
    expect(ai.activity({ offset: 0, limit: 1 }, tree).items[0]?.what).toContain(
      'Programs connected to it 2 times.',
    );
  });

  it('tells the page what it hands out for connecting an AI app', () => {
    expect(ai.info()).toMatchObject({
      canConnect: true,
      connectorCommand: 'claude mcp add rulz-ancestry',
      connectorFileFits: false,
      maxHours: 2,
    });
    expect(ai.connectorFile).toBe('C:\\app\\rulz-ancestry.mcpb');

    const without = new AiSessionService(records, { appDb });
    expect(without.info()).toMatchObject({ canConnect: false, connectorCommand: '' });
    expect(without.connectorFile).toBeNull();
    expect(without.state().connection).toEqual({ open: false, problem: '', clients: [] });
  });
});
