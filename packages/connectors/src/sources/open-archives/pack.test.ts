import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { OA_BUILDER_VERSION, OA_PACK_KIND, oaLayout, oaRecordsOf, splitOaLine } from './pack';
import { openArchivesRecordUrl } from './search';

// The people, places and identifiers in the fixtures are made up. Their
// columns are those of Open Archives' CSV dumps, measured on 2026-11-15.
const FIXTURES = join(import.meta.dirname, 'fixtures');

function load(file: string): {
  header: string[];
  rows: Record<string, string>[];
  skipped: number;
} {
  const lines = readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  const header = splitOaLine(lines[0] ?? '');
  const rows: Record<string, string>[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const fields = splitOaLine(line);
    if (fields.length !== header.length) {
      skipped += 1;
      continue;
    }
    rows.push(Object.fromEntries(header.map((name, i) => [name, fields[i] ?? ''])));
  }
  return { header, rows, skipped };
}

const THIS_YEAR = 2026;
const query = (given: string, surname: string): PersonQuery => ({
  given,
  surname,
  birthYear: null,
  deathYear: null,
});
const keys = (file: string, q: PersonQuery | null) =>
  load(file).rows.flatMap((row) => oaRecordsOf(row, THIS_YEAR, q).records.map((r) => r.key));

describe('splitOaLine', () => {
  it('splits on pipes, keeps empty fields, and drops a carriage return at the end', () => {
    expect(splitOaLine('a||c|')).toEqual(['a', '', 'c', '']);
    expect(splitOaLine('a|b\r')).toEqual(['a', 'b']);
    expect(splitOaLine('say "hi", ok')).toEqual(['say "hi", ok']);
  });
});

describe('oaLayout', () => {
  it('finds the slots of a marriage file and the columns to search', () => {
    const { header } = load('pack-sample.csv');
    expect(header).toHaveLength(27 + 12 * 17);
    const layout = oaLayout(header);
    expect(layout.slots).toEqual([
      'GROOM',
      'GROOM_FTHR',
      'GROOM_MTHR',
      'BRIDE',
      'BRIDE_FTHR',
      'BRIDE_MTHR',
      'WITNESS_1',
      'WITNESS_2',
      'WITNESS_3',
      'WITNESS_4',
      'WITNESS_5',
      'OTHER',
    ]);
    expect(layout.ftsNames).toHaveLength(12 * 5);
    expect(layout.ftsNames.slice(0, 5)).toEqual([
      'GROOM_NAME',
      'GROOM_NAME_GN',
      'GROOM_NAME_PATR',
      'GROOM_NAME_SPRE',
      'GROOM_NAME_SURN',
    ]);
    expect(layout.ftsPlaces[0]).toBe('EVENT_PLACE');
    expect(layout.ftsPlaces).toContain('BRIDE_RES_PLACE');
    expect(layout.ftsPlaces).toContain('OTHER_BIR_PLACE');
    // the places of the archive itself are not searched as places of the event
    expect(layout.ftsPlaces).not.toContain('SOURCEREFERENCE_PLACE');
    expect(layout.ftsPlaces).not.toContain('SOURCE_PLACE');
    for (const column of [...layout.ftsNames, ...layout.ftsPlaces]) {
      expect(header).toContain(column);
    }
  });

  it('finds the slots of a births file', () => {
    const { header } = load('pack-sample-births.csv');
    expect(header).toHaveLength(27 + 9 * 17);
    expect(oaLayout(header).slots).toEqual([
      'PR',
      'PR_FTHR',
      'PR_MTHR',
      'WITNESS_1',
      'WITNESS_2',
      'WITNESS_3',
      'WITNESS_4',
      'WITNESS_5',
      'OTHER',
    ]);
  });

  it('throws a format error when a column every record has is missing', () => {
    const { header } = load('pack-sample.csv');
    for (const missing of ['SOURCE_RECORD_GUID', 'SOURCEREFERENCE_INSTITUTIONCODE', 'EVENT_TYPE']) {
      const thrown = (() => {
        try {
          oaLayout(header.filter((name) => name !== missing));
        } catch (error) {
          return error;
        }
        return null;
      })();
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect((thrown as ConnectorError).kind).toBe('format');
      expect((thrown as Error).message).toContain(missing);
    }
  });
});

describe('the fixtures', () => {
  it('have one row with the wrong number of fields, which a reader skips', () => {
    const marriages = load('pack-sample.csv');
    expect(marriages.skipped).toBe(1);
    expect(marriages.rows).toHaveLength(4);
    const births = load('pack-sample-births.csv');
    expect(births.skipped).toBe(0);
    expect(births.rows).toHaveLength(4);
  });
});

describe('oaRecordsOf', () => {
  it('gives one record for each named slot of a long-ago marriage, keyed by its slot', () => {
    const [first] = load('pack-sample.csv').rows;
    const { records, hidden } = oaRecordsOf(first ?? {}, THIS_YEAR, null);
    expect(hidden).toBe(0);
    expect(records.map((r) => r.key)).toEqual([
      'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_GROOM',
      'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_GROOM_FTHR',
      'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_BRIDE',
      'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_BRIDE_FTHR',
      'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_WITNESS_1',
    ]);
    expect(records[0]).toEqual({
      connectorId: 'open-archives',
      key: 'tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/_GROOM',
      kind: 'event',
      title: 'Jan de Vries',
      url: 'https://www.openarchieven.nl/tst:1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001/en',
      role: 'Bruidegom',
      event: 'Huwelijk',
      date: '21 MAY 1851',
      place: 'Ashvale',
      held: 'BS Huwelijk, Test Town Archive',
    });
    expect(records.map((r) => r.role)).toEqual([
      'Bruidegom',
      'Vader van de bruidegom',
      'Bruid',
      'Vader van de bruid',
      'Getuige',
    ]);
  });

  it('builds the address as the live search does, never from the row', () => {
    const [first] = load('pack-sample.csv').rows;
    const record = oaRecordsOf(first ?? {}, THIS_YEAR, null).records[0];
    expect(record?.url).toBe(openArchivesRecordUrl('tst', '1A2B3C4D-0001-4E5F-8A9B-0C1D2E3F0001'));
    expect(openArchivesRecordUrl('exa', 'ABC-1')).toBe('https://www.openarchieven.nl/exa:ABC-1/en');
  });

  it('applies the living rule: a record not long ago gives nobody, and counts them as hidden', () => {
    const recent = load('pack-sample.csv').rows[2] ?? {};
    expect(recent['EVENT_YEAR']).toBe('2010');
    expect(oaRecordsOf(recent, THIS_YEAR, null)).toEqual({ records: [], hidden: 2 });
    expect(oaRecordsOf(recent, THIS_YEAR, query('Alex', 'Baker'))).toEqual({
      records: [],
      hidden: 1,
    });
    // the same record, long ago
    expect(oaRecordsOf(recent, 2200, null).records).toHaveLength(2);
    // 110 years back is not yet long ago; 111 is
    const row = { ...recent, EVENT_YEAR: String(THIS_YEAR - 110) };
    expect(oaRecordsOf(row, THIS_YEAR, null).records).toHaveLength(0);
    expect(
      oaRecordsOf({ ...row, EVENT_YEAR: String(THIS_YEAR - 111) }, THIS_YEAR, null).records,
    ).toHaveLength(2);
  });

  it('keeps a recent record of the death of the one who died, and hides the rest of it', () => {
    const death = load('pack-sample-births.csv').rows[3] ?? {};
    expect(death['EVENT_TYPE']).toBe('Overlijden');
    const { records, hidden } = oaRecordsOf(death, THIS_YEAR, null);
    expect(records.map((r) => [r.key, r.role, r.date])).toEqual([
      ['tst:2B3C4D5E-0004-4F60-9BAC-1D2E3F400004/_PR', 'Overledene', '4 JUL 2015'],
    ]);
    expect(hidden).toBe(1);
  });

  it('gives no record for an event with no year that is not a death', () => {
    const row = { ...(load('pack-sample.csv').rows[0] ?? {}), EVENT_YEAR: '' };
    expect(oaRecordsOf(row, THIS_YEAR, null)).toEqual({ records: [], hidden: 5 });
  });

  it('passes over a slot with no name, and over rows whose key does not pass', () => {
    // BRIDE of the fourth marriage has a place and no name
    const withEmpty = load('pack-sample.csv').rows[3] ?? {};
    expect(withEmpty['BRIDE_RES_PLACE']).toBe('Dunmere');
    expect(oaRecordsOf(withEmpty, THIS_YEAR, null).records.map((r) => r.key)).toEqual([
      'tst:1A2B3C4D-0004-4E5F-8A9B-0C1D2E3F0004/_GROOM',
    ]);
    const base = load('pack-sample.csv').rows[0] ?? {};
    const none = { records: [], hidden: 0 };
    for (const bad of [
      { SOURCE_RECORD_GUID: '' },
      { SOURCE_RECORD_GUID: '{../../x}' },
      { SOURCE_RECORD_GUID: '{' + 'A'.repeat(81) + '}' },
      { SOURCEREFERENCE_INSTITUTIONCODE: '' },
      { SOURCEREFERENCE_INSTITUTIONCODE: 'T' },
      { SOURCEREFERENCE_INSTITUTIONCODE: 'tst/..' },
      { SOURCEREFERENCE_INSTITUTIONCODE: 'abcdefghijklm' },
    ]) {
      expect(oaRecordsOf({ ...base, ...bad }, THIS_YEAR, null)).toEqual(none);
    }
    expect(oaRecordsOf({}, THIS_YEAR, null)).toEqual(none);
  });

  it('skips a slot whose name is not a slot name', () => {
    const base = load('pack-sample.csv').rows[0] ?? {};
    const odd = {
      ...base,
      lower_NAME_SURN: 'Smit',
      [`${'X'.repeat(30)}_NAME_SURN`]: 'Smit',
      '1ST_NAME_SURN': 'Smit',
    };
    expect(oaRecordsOf(odd, THIS_YEAR, null).records).toHaveLength(5);
  });

  it('takes only the slots of the person asked for', () => {
    const first = load('pack-sample.csv').rows[0] ?? {};
    const of = (given: string, surname: string) =>
      oaRecordsOf(first, THIS_YEAR, query(given, surname)).records.map((r) => r.key.split('/')[1]);
    // Jansen is the surname of the bride, her father and a witness: one name, three slots
    expect(of('', 'Jansen')).toEqual(['_BRIDE', '_BRIDE_FTHR', '_WITNESS_1']);
    // a given name narrows it to the slot whose own given name fits
    expect(of('Pieter', 'Jansen')).toEqual(['_WITNESS_1']);
    expect(of('Maria', 'Jansen')).toEqual(['_BRIDE']);
    expect(of('M', 'Jansen')).toEqual(['_BRIDE']);
    // the right given name with another slot's surname is nobody
    expect(of('Maria', 'Vries')).toEqual([]);
    expect(of('Pieter', 'Smit')).toEqual([]);
    // the prefix of a surname is part of it
    expect(of('', 'de Vries')).toEqual(['_GROOM', '_GROOM_FTHR']);
    expect(of('', 'Vries')).toEqual(['_GROOM', '_GROOM_FTHR']);
    expect(of('Jan', 'de Vries')).toEqual(['_GROOM']);
  });

  it('folds accents and case when it matches', () => {
    const second = load('pack-sample.csv').rows[1] ?? {};
    const of = (given: string, surname: string) =>
      oaRecordsOf(second, THIS_YEAR, query(given, surname)).records.map((r) => r.key.split('/')[1]);
    expect(of('jose', 'gomez')).toEqual(['_GROOM']);
    expect(of('JOSÉ', 'GÓMEZ')).toEqual(['_GROOM']);
    expect(of('francoise', 'lefevre')).toEqual(['_BRIDE']);
    expect(of('ZOE', 'MULLER')).toEqual(['_BRIDE_MTHR']);
    expect(of('', 'Müller')).toEqual(['_BRIDE_MTHR']);
    expect(oaRecordsOf(second, THIS_YEAR, null).records[0]?.title).toBe('José Gómez');
  });

  it('takes births in their own layout, with the child and both parents', () => {
    expect(keys('pack-sample-births.csv', null)).toEqual([
      'tst:2B3C4D5E-0001-4F60-9BAC-1D2E3F400001/_PR',
      'tst:2B3C4D5E-0001-4F60-9BAC-1D2E3F400001/_PR_FTHR',
      'tst:2B3C4D5E-0001-4F60-9BAC-1D2E3F400001/_PR_MTHR',
      'tst:2B3C4D5E-0002-4F60-9BAC-1D2E3F400002/_PR_FTHR',
      'tst:2B3C4D5E-0002-4F60-9BAC-1D2E3F400002/_PR_MTHR',
      'tst:2B3C4D5E-0004-4F60-9BAC-1D2E3F400004/_PR',
    ]);
    // the father of one birth has the same name as the father of another: one slot each
    expect(keys('pack-sample-births.csv', query('Willem', 'Smit'))).toEqual([
      'tst:2B3C4D5E-0001-4F60-9BAC-1D2E3F400001/_PR_FTHR',
      'tst:2B3C4D5E-0002-4F60-9BAC-1D2E3F400002/_PR_FTHR',
    ]);
    const first = load('pack-sample-births.csv').rows[0] ?? {};
    expect(oaRecordsOf(first, THIS_YEAR, query('Ilse', 'Smit')).records[0]).toMatchObject({
      role: 'Kind',
      event: 'Geboorte',
      date: '3 APR 1860',
      place: 'Ashvale',
    });
  });

  it('gives a key that cannot be one of the live search', () => {
    const live = /^[A-Za-z0-9:-]{1,80}$/;
    for (const key of keys('pack-sample-births.csv', null)) {
      expect(live.test(key.split('/')[1] ?? '')).toBe(false);
    }
  });

  it('names the pack kind and the version of its reading', () => {
    expect(OA_PACK_KIND).toBe('open-archives');
    expect(OA_BUILDER_VERSION).toBe(1);
  });
});
