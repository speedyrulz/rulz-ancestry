import { describe, expect, it } from 'vitest';
import { PROPOSAL_REASONS_MAX, REASON_TEXT_MAX, checkProposal } from './proposal';
import type { SharedRecord } from './record';

const record: SharedRecord = {
  sourceId: 'open-archives',
  sourceName: 'Open Archives',
  attribution: 'Open Archives',
  kind: 'event',
  sex: null,
  url: 'https://www.openarchieven.nl/abc:123/en',
  fields: [
    { name: 'title', value: 'Jikke Zandstra' },
    { name: 'role', value: 'Bride' },
    { name: 'event', value: 'Marriage' },
    { name: 'date', value: '12 MAY 1875' },
    { name: 'place', value: 'Utrecht' },
  ],
};

const reason = (side: 'for' | 'against', text: string, quote: string) => ({ side, text, quote });

describe('checking what an AI proposes about a record', () => {
  it('keeps the reasons whose quotes are in the record, with the words as the record has them', () => {
    const checked = checkProposal(
      {
        verdict: 'fits',
        confidence: 'high',
        reasons: [
          reason('for', 'The name is the same.', 'jikke zandstra'),
          reason('for', 'She married in the year the tree gives.', '"1875"'),
          reason('against', 'The tree has the wedding in Zwolle.', 'Utrecht'),
        ],
      },
      record,
    );

    expect(checked).toEqual({
      ok: true,
      verdict: 'fits',
      confidence: 'high',
      reasons: [
        { side: 'for', text: 'The name is the same.', quote: 'Jikke Zandstra', field: 'title' },
        {
          side: 'for',
          text: 'She married in the year the tree gives.',
          quote: '1875',
          field: 'date',
        },
        {
          side: 'against',
          text: 'The tree has the wedding in Zwolle.',
          quote: 'Utrecht',
          field: 'place',
        },
      ],
      dropped: [],
    });
  });

  it('drops a reason whose quote is not in the record, and says which and why', () => {
    const checked = checkProposal(
      {
        verdict: 'may-fit',
        confidence: 'low',
        reasons: [
          reason('for', 'Her father is named as a farmer.', 'father: farmer'),
          reason('for', 'The name is the same.', 'Jikke Zandstra'),
          reason('for', 'The day fits.', '12'),
          reason('against', '', 'Utrecht'),
          reason('against', 'Nothing to point at.', '...'),
        ],
      },
      record,
    );

    expect(checked).toMatchObject({
      ok: true,
      reasons: [{ side: 'for', quote: 'Jikke Zandstra' }],
      dropped: [
        {
          side: 'for',
          text: 'Her father is named as a farmer.',
          quote: 'father: farmer',
          why: 'not-in-record',
        },
        { side: 'for', text: 'The day fits.', quote: '12', why: 'too-short' },
        { side: 'against', text: '', quote: 'Utrecht', why: 'no-text' },
        { side: 'against', text: 'Nothing to point at.', quote: '...', why: 'empty' },
      ],
    });
  });

  it('refuses a proposal that is left without a reason', () => {
    const checked = checkProposal(
      {
        verdict: 'fits',
        confidence: 'high',
        reasons: [
          reason('for', 'She was born in 1852 in Sneek.', 'born 1852 in Sneek'),
          reason('for', 'Her husband was Marten Veldkamp.', 'Marten Veldkamp'),
        ],
      },
      record,
    );

    expect(checked).toMatchObject({ ok: false, problem: 'no-reason' });
    expect(!checked.ok && checked.dropped).toHaveLength(2);
  });

  it('refuses a verdict that no kept reason stands behind', () => {
    const against = [reason('against', 'The tree has the wedding in Zwolle.', 'Utrecht')];
    const forIt = [reason('for', 'The name is the same.', 'Jikke Zandstra')];

    expect(
      checkProposal({ verdict: 'fits', confidence: 'low', reasons: against }, record),
    ).toMatchObject({ ok: false, problem: 'unsupported' });
    expect(
      checkProposal({ verdict: 'does-not-fit', confidence: 'low', reasons: forIt }, record),
    ).toMatchObject({ ok: false, problem: 'unsupported' });
    // "It fits" with a reason for it that was dropped is not supported either.
    expect(
      checkProposal(
        {
          verdict: 'fits',
          confidence: 'high',
          reasons: [...against, reason('for', 'Born in Sneek.', 'Sneek')],
        },
        record,
      ),
    ).toMatchObject({ ok: false, problem: 'unsupported', dropped: [{ why: 'not-in-record' }] });
    for (const reasons of [against, forIt]) {
      expect(checkProposal({ verdict: 'may-fit', confidence: 'low', reasons }, record).ok).toBe(
        true,
      );
    }
    expect(
      checkProposal({ verdict: 'does-not-fit', confidence: 'high', reasons: against }, record).ok,
    ).toBe(true);
  });

  it('refuses what has not the shape of a proposal', () => {
    const good = {
      verdict: 'fits',
      confidence: 'high',
      reasons: [reason('for', 'The name is the same.', 'Jikke Zandstra')],
    };
    expect(checkProposal(good, record).ok).toBe(true);

    const many = Array.from({ length: PROPOSAL_REASONS_MAX + 1 }, () => good.reasons[0]);
    for (const input of [
      null,
      undefined,
      'fits',
      [],
      {},
      { ...good, verdict: 'certain' },
      { ...good, confidence: 0.9 },
      { ...good, reasons: [] },
      { ...good, reasons: many },
      { ...good, reasons: [{ side: 'for', text: 'No quote.' }] },
      { ...good, reasons: [{ ...good.reasons[0], side: 'neutral' }] },
      { ...good, reasons: [{ ...good.reasons[0], quote: 'x'.repeat(4001) }] },
      { ...good, reasons: [{ ...good.reasons[0], field: 'title' }] },
      { ...good, personId: 'someone-else' },
    ]) {
      expect(checkProposal(input, record)).toMatchObject({
        ok: false,
        problem: 'shape',
        dropped: [],
      });
    }
  });

  it('cleans the words of a reason and cuts them', () => {
    const bell = String.fromCharCode(7);
    const checked = checkProposal(
      {
        verdict: 'may-fit',
        confidence: 'medium',
        reasons: [
          reason('for', `The name${bell}\n\n  is the same.`, 'Jikke Zandstra'),
          reason('for', 'y'.repeat(3000), 'Marriage'),
        ],
      },
      record,
    );

    expect(checked.ok && checked.reasons[0]?.text).toBe('The name is the same.');
    expect(checked.ok && checked.reasons[1]?.text).toHaveLength(REASON_TEXT_MAX);
  });

  it('counts the same reason once', () => {
    const same = reason('for', 'The name is the same.', 'Jikke Zandstra');
    const checked = checkProposal(
      {
        verdict: 'fits',
        confidence: 'high',
        reasons: [same, { ...same, quote: 'JIKKE ZANDSTRA' }, { ...same, text: 'Her name.' }],
      },
      record,
    );

    expect(checked.ok && checked.reasons.map((entry) => entry.text)).toEqual([
      'The name is the same.',
      'Her name.',
    ]);
  });
});
