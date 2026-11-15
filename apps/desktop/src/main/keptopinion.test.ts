import { describe, expect, it } from 'vitest';
import { checkProposal, sharedRecordOf } from '@rulz/ai';
import { OPEN_ARCHIVES_RECORD_URL, openArchivesManifest } from '@rulz/connectors';
import type { EventRecord } from '@rulz/core';
import { RECORD_MARK_AI_JSON_MAX, type RecordMark } from '@rulz/db';
import { OPINION_UNREADABLE, keptOpinionJson, keptOpinionOf } from './keptopinion';
import { keptFormOf, keptRecordOf } from './keptrecord';

/** A record of someone made up, with letters and marks that have more than one form. */
const marriage: EventRecord = {
  connectorId: 'open-archives',
  key: 'abc:123/p1',
  kind: 'event',
  title: 'Jikke Zandstra-Kühn',
  url: `${OPEN_ARCHIVES_RECORD_URL}abc:123/en`,
  role: 'Bride',
  event: 'Marriage',
  date: '12 MAY 1875',
  place: 'Voorbeeldstad',
  held: 'Civil registration marriages, Example Municipal Archive',
};

/** What an AI proposed about it, as the session holds it after its check. */
function proposed(reasons: { side: 'for' | 'against'; text: string; quote: string }[]) {
  const shared = sharedRecordOf(marriage, openArchivesManifest);
  if (!shared.ok) throw new Error(shared.message);
  const checked = checkProposal({ verdict: 'fits', confidence: 'medium', reasons }, shared.record);
  if (!checked.ok) throw new Error(checked.message);
  return { ...checked, at: 5000 };
}

const usual = () =>
  proposed([
    {
      side: 'for',
      text: 'The name is hers, with the name of her husband.',
      quote: 'zandstra-kühn',
    },
    { side: 'for', text: 'She married in the year the tree has.', quote: '1875' },
    { side: 'against', text: 'The tree has another town.', quote: 'Voorbeeldstad' },
  ]);

/** The mark as the tree would hold it, kept from the record and what the AI said. */
function markOf(aiJson: string | null, record: EventRecord = marriage): RecordMark {
  const form = keptFormOf(record, openArchivesManifest);
  if (form === null) throw new Error('too long to keep');
  return {
    id: 'mark-1',
    personId: 'person-1',
    sourceId: 'open-archives',
    key: record.key,
    state: 'kept',
    title: form.title,
    url: record.url,
    recordJson: form.recordJson,
    aiJson,
    readAt: 1000,
    markedAt: 2000,
  };
}

/** Reads a mark back as the inbox does: the record first, then what the AI said of it. */
function readBack(mark: RecordMark) {
  const record = keptRecordOf(mark, { manifest: openArchivesManifest });
  return keptOpinionOf(mark, record, openArchivesManifest);
}

describe('what an AI said of a record, as the tree keeps it', () => {
  it('is the verdict, how sure it was, when, and the reasons with their quotes', () => {
    const json = keptOpinionJson(usual());
    expect(JSON.parse(json ?? '')).toEqual({
      v: 1,
      verdict: 'fits',
      confidence: 'medium',
      proposedAt: 5000,
      reasons: [
        {
          side: 'for',
          text: 'The name is hers, with the name of her husband.',
          // The words as they stand in the record, not as the AI wrote them.
          quote: 'Zandstra-Kühn',
        },
        { side: 'for', text: 'She married in the year the tree has.', quote: '1875' },
        { side: 'against', text: 'The tree has another town.', quote: 'Voorbeeldstad' },
      ],
    });
  });

  it('is not kept when it is too long', () => {
    const one = usual();
    const long = { ...one, reasons: Array.from({ length: 12 }, () => one.reasons[0]!) };
    expect(keptOpinionJson(long)).not.toBeNull();
    const text = '"'.repeat(RECORD_MARK_AI_JSON_MAX / 2);
    expect(keptOpinionJson({ ...one, reasons: [{ ...one.reasons[0]!, text }] })).toBeNull();
  });
});

describe('what an AI said of a record, read back from a tree', () => {
  it('comes back as it was kept, each quote found again in the kept record', () => {
    expect(readBack(markOf(keptOpinionJson(usual())))).toEqual({
      ai: {
        verdict: 'fits',
        confidence: 'medium',
        proposedAt: 5000,
        reasons: [
          {
            side: 'for',
            text: 'The name is hers, with the name of her husband.',
            quote: 'Zandstra-Kühn',
            field: 'title',
          },
          {
            side: 'for',
            text: 'She married in the year the tree has.',
            quote: '1875',
            field: 'date',
          },
          {
            side: 'against',
            text: 'The tree has another town.',
            quote: 'Voorbeeldstad',
            field: 'place',
          },
        ],
      },
      problem: '',
    });
  });

  it('is nothing, and no problem, for a mark that holds none', () => {
    expect(readBack(markOf(null))).toEqual({ ai: null, problem: '' });
  });

  it('drops a reason whose quote is not in the kept record', () => {
    const held = JSON.parse(keptOpinionJson(usual()) ?? '') as {
      reasons: { quote: string; text: string }[];
    };
    // Someone wrote into the file: words the record does not have.
    held.reasons[1] = { ...held.reasons[1]!, quote: 'born in Ashford, Vermont' };
    const back = readBack(markOf(JSON.stringify(held)));
    expect(back.problem).toBe('');
    expect(back.ai?.reasons.map((reason) => reason.quote)).toEqual([
      'Zandstra-Kühn',
      'Voorbeeldstad',
    ]);
  });

  it('is not shown when no reason is left that stands behind its verdict', () => {
    const held = JSON.parse(keptOpinionJson(usual()) ?? '') as {
      verdict: string;
      reasons: { side: string; quote: string }[];
    };
    const against = held.reasons.filter((reason) => reason.side === 'against');
    // "It fits" with only a reason against it, as a file could hold it.
    expect(readBack(markOf(JSON.stringify({ ...held, reasons: against })))).toEqual({
      ai: null,
      problem: OPINION_UNREADABLE,
    });
    const none = held.reasons.map((reason) => ({ ...reason, quote: 'not in the record' }));
    expect(readBack(markOf(JSON.stringify({ ...held, reasons: none }))).ai).toBeNull();
  });

  it('is not shown when the kept record reads otherwise than the reasons quote', () => {
    const json = keptOpinionJson(usual());
    const other = { ...marriage, title: 'Aaltje Brouwer', date: '3 JUN 1880', place: 'Elders' };
    expect(readBack(markOf(json, other))).toEqual({ ai: null, problem: OPINION_UNREADABLE });
  });

  it('is not shown when it is no JSON, has another shape, or is of a form this version does not know', () => {
    const good = JSON.parse(keptOpinionJson(usual()) ?? '') as Record<string, unknown>;
    const cases = [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, verdict: 'certain' }),
      JSON.stringify({ ...good, reasons: [] }),
      JSON.stringify({ ...good, reasons: 'For: everything' }),
      JSON.stringify({ ...good, extra: 'a remark' }),
      JSON.stringify({ ...good, padding: 'x'.repeat(RECORD_MARK_AI_JSON_MAX) }),
    ];
    for (const aiJson of cases) {
      expect(readBack(markOf(aiJson)), aiJson.slice(0, 40)).toEqual({
        ai: null,
        problem: OPINION_UNREADABLE,
      });
    }
  });

  it('leaves out a moment that is none, and cleans the text of a reason again', () => {
    const good = JSON.parse(keptOpinionJson(usual()) ?? '') as {
      reasons: { side: string; text: string; quote: string }[];
    };
    const first = good.reasons[0]!;
    const back = readBack(
      markOf(
        JSON.stringify({
          ...good,
          proposedAt: 'yesterday',
          reasons: [{ ...first, text: 'A reason\nover two lines\twith a tab.' }],
        }),
      ),
    );
    expect(back.ai?.proposedAt).toBeNull();
    expect(back.ai?.reasons[0]?.text).toBe('A reason over two lines with a tab.');
  });

  it('is not shown where the record itself cannot be used, or the mark is no kept one', () => {
    const mark = markOf(keptOpinionJson(usual()));
    expect(keptOpinionOf(mark, null, openArchivesManifest).ai).toBeNull();
    expect(keptOpinionOf(mark, marriage, undefined).problem).toBe(OPINION_UNREADABLE);
    expect(keptOpinionOf({ ...mark, state: 'declined' }, marriage, openArchivesManifest).ai).toBe(
      null,
    );
  });
});
