import { describe, expect, it } from 'vitest';
import {
  OPEN_ARCHIVES_RECORD_URL,
  WIKIDATA_ENTITY_URL,
  internetArchiveManifest,
  locManifest,
  manifests,
  naraCatalogManifest,
  openArchivesManifest,
  parseWikitreeSearch,
  wikidataManifest,
  wikitreeManifest,
  type ConnectorManifest,
} from '@rulz/connectors';
import type { EventRecord, PersonRecord, TextRecord } from '@rulz/core';
import { mayShareWithAi, recordTextsOf, sharedRecordOf } from './record';

const marriage: EventRecord = {
  connectorId: 'open-archives',
  key: 'abc:123/p1',
  kind: 'event',
  title: 'Jikke Zandstra',
  url: `${OPEN_ARCHIVES_RECORD_URL}abc:123/en`,
  role: 'Bride',
  event: 'Marriage',
  date: '12 MAY 1875',
  place: 'Utrecht',
  held: 'Civil registration marriages, Municipal archive',
};

const painter: PersonRecord = {
  connectorId: 'wikidata',
  key: 'Q0',
  kind: 'person',
  title: 'Marten Veldkamp',
  url: `${WIKIDATA_ENTITY_URL}Q0`,
  sex: 'M',
  facts: [
    { type: 'birth', date: '1 MAR 1850', place: 'Zwolle' },
    { type: 'death', date: 'ABT 1921', place: '' },
  ],
  about: 'painter of seascapes',
};

describe('which sources may be passed on to an AI assistant', () => {
  it('are those whose terms were read for it, and no others', () => {
    // A source is added here only with a note in its manifest of what was read, and when.
    expect(manifests.filter(mayShareWithAi).map((manifest) => manifest.id)).toEqual([
      'wikitree',
      'wikidata',
      'open-archives',
    ]);
  });

  it('is never a source the app does not fetch, or one that bars keeping what it returns', () => {
    const allowed: ConnectorManifest = { ...openArchivesManifest };
    expect(mayShareWithAi(allowed)).toBe(true);
    expect(mayShareWithAi({ ...allowed, mayShareWithAi: false })).toBe(false);
    expect(mayShareWithAi({ ...allowed, tier: 'deeplink' })).toBe(false);
    expect(mayShareWithAi({ ...allowed, mayStoreText: false })).toBe(false);
    const { mayShareWithAi: _left, ...unread } = allowed;
    expect(mayShareWithAi(unread)).toBe(false);
  });
});

describe('a record as an AI assistant gets it', () => {
  it('is the texts of a record of an event, each under its name, with the credit of the source', () => {
    expect(sharedRecordOf(marriage, openArchivesManifest)).toEqual({
      ok: true,
      record: {
        sourceId: 'open-archives',
        sourceName: openArchivesManifest.name,
        attribution: openArchivesManifest.attribution,
        kind: 'event',
        sex: null,
        url: marriage.url,
        fields: [
          { name: 'title', value: 'Jikke Zandstra' },
          { name: 'role', value: 'Bride' },
          { name: 'event', value: 'Marriage' },
          { name: 'date', value: '12 MAY 1875' },
          { name: 'place', value: 'Utrecht' },
          { name: 'held', value: 'Civil registration marriages, Municipal archive' },
        ],
      },
    });
  });

  it('is the texts of a person, a text that is empty left out', () => {
    const shared = sharedRecordOf(painter, wikidataManifest);

    expect(shared.ok && shared.record.sex).toBe('M');
    expect(shared.ok && shared.record.fields).toEqual([
      { name: 'title', value: 'Marten Veldkamp' },
      { name: 'about', value: 'painter of seascapes' },
      { name: 'birth date', value: '1 MAR 1850' },
      { name: 'birth place', value: 'Zwolle' },
      { name: 'death date', value: 'ABT 1921' },
    ]);
  });

  it('is the name, the sex, the birth and the death of a profile of WikiTree, and nothing more', () => {
    // Through the connector, as a search gives it. The people are made up, and
    // WikiTree is not asked for a biography: one that came all the same is not read.
    const profile = {
      Id: 1,
      Name: 'Veldkamp-90001',
      FirstName: 'Marten',
      MiddleName: '',
      RealName: 'Marten',
      LastNameAtBirth: 'Veldkamp',
      LastNameCurrent: 'Veldkamp',
      Suffix: '',
      BirthDate: '1850-03-01',
      DeathDate: '1921-00-00',
      BirthLocation: 'Zwolle',
      DeathLocation: '',
      Gender: 'Male',
      IsLiving: 0,
      Privacy: 60,
      DataStatus: { BirthDate: 'certain', DeathDate: 'guess' },
      Bio: 'A biography that a member wrote.',
    };
    const found = parseWikitreeSearch(
      [
        {
          status: 0,
          total: 4,
          matches: [
            profile,
            { ...profile, Name: 'Veldkamp-90002', IsLiving: 1 },
            { ...profile, Name: 'Veldkamp-90003', Privacy: 40 },
            {
              ...profile,
              Name: 'Zandstra-90004',
              FirstName: 'Jikke',
              RealName: 'Jikke',
              LastNameAtBirth: 'Zandstra',
              Gender: 'Female',
            },
          ],
        },
      ],
      { offset: 0, limit: 10 },
    );

    const shared = found.items.map((record) => sharedRecordOf(record, wikitreeManifest));

    const fields = [
      { name: 'birth date', value: '1 MAR 1850' },
      { name: 'birth place', value: 'Zwolle' },
      { name: 'death date', value: 'ABT 1921' },
    ];
    const common = {
      sourceId: 'wikitree',
      sourceName: 'WikiTree',
      attribution: wikitreeManifest.attribution,
      kind: 'person',
    };
    // The living one and the private one are not among them.
    expect(shared).toEqual([
      {
        ok: true,
        record: {
          ...common,
          sex: 'M',
          url: 'https://www.wikitree.com/wiki/Veldkamp-90001',
          fields: [{ name: 'title', value: 'Marten Veldkamp' }, ...fields],
        },
      },
      {
        ok: true,
        record: {
          ...common,
          sex: 'F',
          url: 'https://www.wikitree.com/wiki/Zandstra-90004',
          fields: [{ name: 'title', value: 'Jikke Veldkamp (born Zandstra)' }, ...fields],
        },
      },
    ]);
    expect(JSON.stringify(shared)).not.toContain('biography');
  });

  it('numbers a second birth or death of one record', () => {
    const shared = sharedRecordOf(
      {
        ...painter,
        about: '',
        facts: [
          { type: 'birth', date: '1850', place: '' },
          { type: 'birth', date: '1851', place: 'Zwolle' },
        ],
      },
      wikidataManifest,
    );

    expect(shared.ok && shared.record.fields.map((field) => field.name)).toEqual([
      'title',
      'birth date',
      'birth date 2',
      'birth place 2',
    ]);
  });

  it('is the texts of a newspaper or a book', () => {
    const page: TextRecord = {
      connectorId: 'open-archives',
      key: 'abc:9/p2',
      kind: 'text',
      title: 'The weekly courier',
      url: `${OPEN_ARCHIVES_RECORD_URL}abc:9/en`,
      date: '1881',
      by: '',
      about: 'Newspaper',
    };

    const shared = sharedRecordOf(page, openArchivesManifest);

    expect(shared.ok && shared.record.fields).toEqual([
      { name: 'title', value: 'The weekly courier' },
      { name: 'date', value: '1881' },
      { name: 'about', value: 'Newspaper' },
    ]);
  });

  it('cleans every text once more, cuts it, and gives every letter one form', () => {
    const bell = String.fromCharCode(7);
    const combining = `e${String.fromCharCode(0x301)}`;
    const shared = sharedRecordOf(
      {
        ...marriage,
        title: `Ren${combining}e${bell}\n  Zandstra`,
        held: 'x'.repeat(2000),
      },
      openArchivesManifest,
    );

    const field = (name: string) =>
      shared.ok ? shared.record.fields.find((entry) => entry.name === name)?.value : undefined;
    expect(field('title')).toBe(`Ren${String.fromCharCode(0xe9)}e Zandstra`);
    expect(field('held')).toHaveLength(500);
  });

  it('leaves no half of a character where a text was cut', () => {
    // A character of two halves, of which the cut at 200 leaves the first.
    const tree = String.fromCodePoint(0x1f333);
    const shared = sharedRecordOf(
      { ...marriage, role: `${'x'.repeat(198)}${tree}y` },
      openArchivesManifest,
    );

    const role = shared.ok
      ? shared.record.fields.find((entry) => entry.name === 'role')?.value
      : '';
    expect(role).toBe(`${'x'.repeat(198)}${String.fromCharCode(0x2026)}`);
  });

  it('is not given for a source whose terms were not read for it', () => {
    for (const manifest of [locManifest, internetArchiveManifest, naraCatalogManifest]) {
      const record = {
        ...painter,
        connectorId: manifest.id,
        url: `${manifest.siteUrl ?? manifest.baseUrl}/x`,
      };
      expect(sharedRecordOf(record, manifest), manifest.id).toEqual({
        ok: false,
        reason: 'source-not-allowed',
        message: `Records of ${manifest.name} are not passed on to an AI assistant.`,
      });
    }
  });

  it('is not given when the record names another source, or its address is not on the site of its source', () => {
    for (const record of [
      { ...marriage, connectorId: 'wikidata' },
      { ...marriage, url: 'https://example.org/abc:123/en' },
      { ...marriage, url: 'http://www.openarchieven.nl/abc:123/en' },
      { ...marriage, url: `${OPEN_ARCHIVES_RECORD_URL}abc:123/en\nhttps://example.org` },
    ]) {
      expect(sharedRecordOf(record, openArchivesManifest)).toMatchObject({
        ok: false,
        reason: 'not-of-source',
      });
    }
  });
});

describe('the texts of a record, for checking a quote on the screen of the user', () => {
  it('are those that are passed on, for a source whose records are', () => {
    const shared = sharedRecordOf(marriage, openArchivesManifest);
    expect(shared.ok && shared.record).toEqual(recordTextsOf(marriage, openArchivesManifest));
  });

  it('are made whatever the terms of the source say, since nothing of them is passed on', () => {
    const { mayShareWithAi: _left, ...unread } = openArchivesManifest;
    expect(sharedRecordOf(marriage, unread).ok).toBe(false);
    expect(recordTextsOf(marriage, unread).fields).toEqual(
      recordTextsOf(marriage, openArchivesManifest).fields,
    );
  });
});
