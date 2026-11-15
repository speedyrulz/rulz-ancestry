import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import {
  OA_CATALOGUE_URL,
  OA_CSV_HOST,
  oaDatasetPageUrl,
  parseOaCatalogue,
  parseOaDatasetPage,
} from './catalogue';

// The archives, codes and texts in the fixtures are made up.
const FIXTURES = join(import.meta.dirname, 'fixtures');
const catalogue = (): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, 'catalogue.sample.jsonld'), 'utf8'));
const page = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('addresses', () => {
  it('names the catalogue, the page of an archive and the file host', () => {
    expect(OA_CATALOGUE_URL).toBe('https://www.openarchieven.nl/datasets/datacatalog.jsonld');
    expect(oaDatasetPageUrl('tst1')).toBe('https://www.openarchieven.nl/datasets/tst1');
    expect(OA_CSV_HOST).toBe('oa-export.s3.nl-ams.scw.cloud');
  });
});

describe('parseOaCatalogue', () => {
  it('keeps the CC0 datasets with a valid code and a name, sorted by name', () => {
    const archives = parseOaCatalogue(catalogue());
    expect(archives.map((a) => a.code)).toEqual(['tst1', 'tst2']);
  });

  it('reads the English name, period, record count and day', () => {
    const [first] = parseOaCatalogue(catalogue());
    expect(first).toEqual({
      code: 'tst1',
      name: 'Test Town Archive',
      period: '1798/1909',
      records: 6379,
      modified: '2026-02-01',
      licence: 'CC0',
    });
  });

  it('falls back to the Dutch name, cleans it, and nulls what is missing or malformed', () => {
    const second = parseOaCatalogue(catalogue()).find((a) => a.code === 'tst2');
    expect(second).toEqual({
      code: 'tst2',
      name: 'Voorbeeldstad Archief',
      period: null,
      records: null,
      modified: null,
      licence: 'CC0',
    });
  });

  it('leaves out other licences, bad codes, datasets without a name and other node types', () => {
    const codes = parseOaCatalogue(catalogue()).map((a) => a.code);
    for (const left of ['tst3', 'tst4', 'tst5', 'Bad_Code']) expect(codes).not.toContain(left);
  });

  it('refuses a shape it cannot read', () => {
    expect(() => parseOaCatalogue({})).toThrow(ConnectorError);
    expect(() => parseOaCatalogue('x')).toThrow(ConnectorError);
    expect(() => parseOaCatalogue([{ '@type': ['https://schema.org/Thing'] }])).toThrow(
      ConnectorError,
    );
    expect(() => parseOaCatalogue([])).toThrow(ConnectorError);
  });

  it('gives an empty list, not an error, for datasets of which none is offered', () => {
    const only = (catalogue() as Record<string, unknown>[]).filter(
      (node) => node['@id'] === 'https://www.openarchieven.nl/id/dataset_tst3',
    );
    expect(parseOaCatalogue(only)).toEqual([]);
  });

  it('looks at no more than 1000 datasets', () => {
    const base = (catalogue() as Record<string, unknown>[])[0] as Record<string, unknown>;
    const many = Array.from({ length: 1005 }, (_, index) => ({
      ...base,
      '@id': `https://www.openarchieven.nl/id/dataset_a${index}`,
    }));
    expect(parseOaCatalogue(many)).toHaveLength(1000);
  });

  it('cuts a very long name', () => {
    const base = (catalogue() as Record<string, unknown>[])[0] as Record<string, unknown>;
    const long = {
      ...base,
      'https://schema.org/name': [{ '@language': 'en', '@value': 'x'.repeat(500) }],
    };
    expect(parseOaCatalogue([long])[0]?.name).toHaveLength(200);
  });
});

describe('parseOaDatasetPage', () => {
  it('lists the CSV files of its own code, once each, in page order, and sees the CC0 deed', () => {
    expect(parseOaDatasetPage(page('dataset-page-tst1.html'), 'tst1')).toEqual({
      files: [
        'https://oa-export.s3.nl-ams.scw.cloud/csv/tst1.bsh.csv.gz',
        'https://oa-export.s3.nl-ams.scw.cloud/csv/tst1.bsg.csv.gz',
      ],
      cc0: true,
    });
  });

  it('ignores the links of another code', () => {
    const found = parseOaDatasetPage(page('dataset-page-tst1.html'), 'tst9');
    expect(found.files).toEqual(['https://oa-export.s3.nl-ams.scw.cloud/csv/tst9.bsg.csv.gz']);
  });

  it('finds no file where none is linked', () => {
    expect(parseOaDatasetPage(page('dataset-page-nocsv.html'), 'tst1')).toEqual({
      files: [],
      cc0: true,
    });
  });

  it('is not CC0 without a licence link, or when any licence link is another', () => {
    expect(parseOaDatasetPage(page('dataset-page-nolicence.html'), 'tst1').cc0).toBe(false);
    expect(parseOaDatasetPage(page('dataset-page-mixed-licence.html'), 'tst1').cc0).toBe(false);
  });

  it('reads licence links written with single quotes, no quotes, or as a link tag', () => {
    const cc0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
    const other = 'https://creativecommons.org/licenses/by/4.0/';
    const cc0Link = `<a rel="license" href="${cc0}">CC0</a>`;
    const others = [
      `<a rel='license' href='${other}'>x</a>`,
      `<a rel=license href=${other}>x</a>`,
      `<link rel="license" href="${other}">`,
      `<link rel='license' href='${other}'>`,
      `<a href='${other}' rel='nofollow License'>x</a>`,
      `<a rel="license">x</a>`,
    ];
    for (const extra of others) {
      expect(parseOaDatasetPage(cc0Link + extra, 'tst1').cc0).toBe(false);
      expect(parseOaDatasetPage(extra + cc0Link, 'tst1').cc0).toBe(false);
    }
    for (const good of [
      `<a rel='license' href='${cc0}'>x</a>`,
      `<a rel=license href=${cc0}>x</a>`,
      `<link rel="license" href="${cc0}">`,
    ]) {
      expect(parseOaDatasetPage(good, 'tst1').cc0).toBe(true);
    }
  });

  it('finds CSV links written with single quotes or no quotes', () => {
    const a = `https://${OA_CSV_HOST}/csv/tst1.aa.csv.gz`;
    const b = `https://${OA_CSV_HOST}/csv/tst1.bb.csv.gz`;
    const found = parseOaDatasetPage(`<a href='${a}'>x</a><a href=${b}>y</a>`, 'tst1');
    expect(found.files).toEqual([a, b]);
  });

  it('refuses an invalid code and caps the files at 40', () => {
    expect(parseOaDatasetPage(page('dataset-page-tst1.html'), 'a.*')).toEqual({
      files: [],
      cc0: false,
    });
    const links = Array.from(
      { length: 60 },
      (_, index) => `<a href="https://${OA_CSV_HOST}/csv/tst1.s${index}.csv.gz">x</a>`,
    ).join('');
    expect(parseOaDatasetPage(links, 'tst1').files).toHaveLength(40);
  });
});
