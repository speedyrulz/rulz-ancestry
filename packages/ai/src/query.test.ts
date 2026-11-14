import { describe, expect, it } from 'vitest';
import {
  GUESS_YEARS_AGO,
  LONGEST_LIFE,
  QUERY_YEAR_REACH,
  checkQuery,
  type QuerySubject,
} from './query';

// The people are made up.
const marten: QuerySubject = {
  names: [
    { given: 'Marten', surname: 'Veldkamp' },
    { given: 'Martinus Douwe', surname: 'Veldkamp' },
  ],
  birthYear: 1850,
  deathYear: 1921,
};

const ask = (asked: object, subject: QuerySubject = marten) =>
  checkQuery(
    { given: 'Marten', surname: 'Veldkamp', birthYear: null, deathYear: null, ...asked },
    subject,
    2026,
  );

describe('what an AI may ask a source about a person', () => {
  it('is a name the tree has for them, with the years the tree has', () => {
    expect(ask({ birthYear: 1850, deathYear: 1921 })).toEqual({
      ok: true,
      query: { given: 'Marten', surname: 'Veldkamp', birthYear: 1850, deathYear: 1921 },
    });
    expect(ask({ given: 'Martinus Douwe' }).ok).toBe(true);
  });

  it('is another spelling of their name, a middle name left out, or an initial', () => {
    expect(ask({ surname: 'Veltkamp' }).ok).toBe(true);
    expect(ask({ given: 'Martinus' }).ok).toBe(true);
    expect(ask({ given: 'M' }).ok).toBe(true);
    expect(ask({ given: 'marten', surname: 'VELDKAMP' }).ok).toBe(true);
  });

  it('is cleaned to one line before it is sent', () => {
    const bell = String.fromCharCode(7);
    expect(ask({ given: `  Marten${bell}\n`, surname: 'Veldkamp\t' })).toEqual({
      ok: true,
      query: { given: 'Marten', surname: 'Veldkamp', birthYear: null, deathYear: null },
    });
  });

  it('is not another name', () => {
    for (const asked of [
      { given: 'Jikke', surname: 'Zandstra' },
      { given: 'Marten', surname: 'Zandstra' },
      { given: 'Jikke', surname: 'Veldkamp' },
    ]) {
      expect(ask(asked), JSON.stringify(asked)).toMatchObject({ ok: false, problem: 'name' });
    }
  });

  it('carries no word along that is no word of their name', () => {
    for (const asked of [
      // The name of someone else, a place, a remark.
      { given: 'Marten Tessel Oort', surname: 'Veldkamp' },
      { given: 'Marten', surname: 'Veldkamp Zwolle' },
      { given: 'Marten lives at Dorpsstraat', surname: 'Veldkamp' },
      // The same word twice is one word of the name, and one that is not.
      { given: 'Marten Marten', surname: 'Veldkamp' },
      // Nothing that is not written with letters.
      { given: 'Marten 1850', surname: 'Veldkamp' },
      { given: 'Marten', surname: 'Veldkamp; x' },
      { given: 'Marten', surname: 'Veldkamp/x' },
    ]) {
      expect(ask(asked), JSON.stringify(asked)).toMatchObject({ ok: false, problem: 'name' });
    }
    // Both given names of the second name of the tree, and one of them.
    expect(ask({ given: 'Martinus Douwe' }).ok).toBe(true);
    expect(ask({ given: 'Martinus D.' }).ok).toBe(true);
  });

  it('carries no letters along that are hung onto a word of their name', () => {
    for (const asked of [
      { given: 'Martenxqzvwk' },
      { surname: 'Veldkampxqzvwkp' },
      { surname: 'Veldkampxyz' },
      // Two words written as one.
      { given: 'Martentessel' },
    ]) {
      expect(ask(asked), JSON.stringify(asked)).toMatchObject({ ok: false, problem: 'name' });
    }
    // Another spelling lies a letter or two from the tree's.
    expect(ask({ given: 'Maarten' }).ok).toBe(true);
    expect(ask({ given: 'Martin', surname: 'Veltcamp' }).ok).toBe(true);
  });

  it('lets a short word differ by less, and the shortest not at all', () => {
    const short: QuerySubject = {
      names: [{ given: 'Jo', surname: 'Smit' }],
      birthYear: null,
      deathYear: null,
    };
    expect(ask({ given: 'Jo', surname: 'Smit' }, short).ok).toBe(true);
    expect(ask({ given: 'Jo', surname: 'Smits' }, short).ok).toBe(true);
    expect(ask({ given: 'Jo', surname: 'Smitje' }, short)).toMatchObject({ ok: false });
    expect(ask({ given: 'Jox', surname: 'Smit' }, short)).toMatchObject({ ok: false });
  });

  it('takes an initial of the tree for itself only, not for any word that begins with it', () => {
    const initials: QuerySubject = {
      names: [{ given: 'J W', surname: 'Veldkamp' }],
      birthYear: null,
      deathYear: null,
    };
    expect(ask({ given: 'J W' }, initials).ok).toBe(true);
    expect(ask({ given: 'J. W.' }, initials).ok).toBe(true);
    expect(ask({ given: 'J' }, initials).ok).toBe(true);
    for (const given of ['Jikke Wiersma', 'J Wiersma', 'Jikkelivingpersonwiersma']) {
      expect(ask({ given }, initials), given).toMatchObject({ ok: false, problem: 'name' });
    }
    const one: QuerySubject = { ...marten, names: [{ given: 'Marten D', surname: 'Veldkamp' }] };
    expect(ask({ given: 'Marten Dorpsstraat' }, one)).toMatchObject({ ok: false });
  });

  it('carries nothing along in marks, accents, other forms of a letter or punctuation', () => {
    const acute = String.fromCharCode(0x301);
    const umlaut = String.fromCharCode(0x308);
    const grave = String.fromCharCode(0x300);
    for (const given of [
      // A row of marks on the last letter.
      `Marten${acute.repeat(90)}`,
      `Marten${acute.repeat(3)}`,
      // An accent on three letters: three letters apart.
      `Ma${umlaut}rte${grave}n${acute}`,
      // A modifier letter, and a letter of full width.
      `Marten${String.fromCharCode(0x2b0)}`,
      `${String.fromCharCode(0xff2d)}arten`,
      // Punctuation that is strung together, or stands alone.
      "Marten.'-.'-",
      'Marten . . .',
      'Marten--',
      "Marten''",
      'Marten..',
      '-Marten',
    ]) {
      expect(ask({ given }), JSON.stringify(given)).toMatchObject({ ok: false, problem: 'name' });
    }
    // One accent is another spelling, and it is sent as one composed letter.
    const accented = ask({ given: `Ma${umlaut}rten` });
    expect(accented.ok).toBe(true);
    if (accented.ok) expect(accented.query.given).toBe(`Ma${umlaut}rten`.normalize('NFC'));
    expect(ask({ given: 'Marten.' }).ok).toBe(true);
  });

  it('carries no character along that is not seen, and no letter of another script', () => {
    const at = (code: number) => String.fromCodePoint(code);
    for (const given of [
      // Selectors of a variant, a joiner of marks, fillers: nothing of them shows.
      `Marten${at(0xe0101)}${at(0xe0102)}`,
      `Marten${at(0xfe0f)}`,
      `Marten${at(0x34f)}${at(0x34f)}`,
      `Mar${at(0x1160)}ten`,
      `Marten${at(0x115f)}`,
      `M${at(0xe0100)}`,
      // A mark that encloses, and one that takes room.
      `Mar${at(0x20dd)}ten`,
      `Mar${at(0x903)}ten`,
      // Letters of another script inside the name, and one that only looks like a Latin letter.
      `Mar${at(0x4e00)}ten`,
      `M${at(0x430)}rten`,
      `Marten${at(0x5d0)}`,
    ]) {
      expect(
        ask({ given }),
        [...given].map((c) => c.codePointAt(0)?.toString(16)).join(' '),
      ).toMatchObject({ ok: false, problem: 'name' });
    }
  });

  it('takes another spelling in Latin, Greek or Cyrillic letters, and any other script as the tree writes it', () => {
    const word = (...codes: number[]) => String.fromCodePoint(...codes);
    // Made-up names: five Cyrillic letters, and five Hebrew ones.
    const cyrillic = word(0x43c, 0x430, 0x440, 0x442, 0x435);
    const hebrew = word(0x5de, 0x5e8, 0x5d8, 0x5e0, 0x5d0);
    const subject: QuerySubject = {
      names: [
        { given: cyrillic, surname: 'Veldkamp' },
        { given: hebrew, surname: 'Veldkamp' },
      ],
      birthYear: null,
      deathYear: null,
    };
    expect(ask({ given: cyrillic }, subject).ok).toBe(true);
    expect(ask({ given: hebrew }, subject).ok).toBe(true);
    // One letter more: another spelling in Cyrillic, nothing in Hebrew.
    expect(ask({ given: cyrillic + word(0x43d) }, subject).ok).toBe(true);
    expect(ask({ given: hebrew + word(0x5d4) }, subject)).toMatchObject({ ok: false });
    // Not half in one script and half in another.
    expect(ask({ given: `${cyrillic.slice(0, 4)}e` }, subject)).toMatchObject({ ok: false });
  });

  it('takes a letter that is written out as two for the same letter', () => {
    const subject: QuerySubject = {
      names: [
        { given: 'Jörg', surname: 'Kühn' },
        { given: 'Joerg', surname: 'Groß' },
      ],
      birthYear: null,
      deathYear: null,
    };
    for (const asked of [
      { given: 'Joerg', surname: 'Kuehn' },
      { given: 'Jörg', surname: 'Gross' },
      { given: 'Jorg', surname: 'Kuhn' },
    ]) {
      expect(ask(asked, subject).ok, JSON.stringify(asked)).toBe(true);
    }
    expect(ask({ given: 'Joerg', surname: 'Kuehnen' }, subject)).toMatchObject({ ok: false });
  });

  it('takes initials that are written without a space between them', () => {
    const subject: QuerySubject = {
      names: [
        { given: 'Jan Pieter', surname: 'Veldkamp' },
        { given: 'Jean-Pierre', surname: 'Veldkamp' },
      ],
      birthYear: null,
      deathYear: null,
    };
    for (const given of ['J.P.', 'J. P.', 'J.-P.', 'J.P']) {
      expect(ask({ given }, subject).ok, given).toBe(true);
    }
    for (const given of ['J.P.X.', 'J..P.', 'J.-.P.', 'J.P.-']) {
      expect(ask({ given }, subject), given).toMatchObject({ ok: false, problem: 'name' });
    }
  });

  it('takes the punctuation of a name as names are written, and the tree’s own as it stands', () => {
    const written: QuerySubject = {
      names: [{ given: 'Jean-Pierre', surname: "van 't Hof" }],
      birthYear: null,
      deathYear: null,
    };
    for (const asked of [
      { given: 'Jean-Pierre', surname: "van 't Hof" },
      { given: 'Jean Pierre', surname: 'van t Hof' },
      { given: 'jean-pierre', surname: "VAN 'T HOF" },
      { given: 'Jean-Piere', surname: "van 't Hoff" },
    ]) {
      expect(ask(asked, written).ok, JSON.stringify(asked)).toBe(true);
    }
    expect(ask({ given: 'Jean-Pierre-Marten', surname: "van 't Hof" }, written)).toMatchObject({
      ok: false,
    });
    // A part the tree writes in its own way is taken as the tree writes it, and in no other way.
    const odd: QuerySubject = { ...marten, names: [{ given: 'Marten', surname: 'Veldkamp (2)' }] };
    expect(ask({ surname: 'Veldkamp (2)' }, odd).ok).toBe(true);
    expect(ask({ surname: 'Veldkamp (3)' }, odd)).toMatchObject({ ok: false, problem: 'name' });
  });

  it('needs a given name and a last name, neither of them too long', () => {
    expect(ask({ given: '' })).toMatchObject({ ok: false, problem: 'name' });
    expect(ask({ surname: '   ' })).toMatchObject({ ok: false, problem: 'name' });
    expect(ask({ given: `Marten ${'x'.repeat(100)}` })).toMatchObject({
      ok: false,
      problem: 'name',
    });
  });

  it('is a year within ten years of the year the tree has', () => {
    expect(ask({ birthYear: 1850 - QUERY_YEAR_REACH }).ok).toBe(true);
    expect(ask({ birthYear: 1850 + QUERY_YEAR_REACH }).ok).toBe(true);
    expect(ask({ deathYear: 1921 - QUERY_YEAR_REACH }).ok).toBe(true);
    expect(ask({ birthYear: 1850 - QUERY_YEAR_REACH - 1 })).toMatchObject({
      ok: false,
      problem: 'years',
    });
    expect(ask({ deathYear: 1921 + QUERY_YEAR_REACH + 1 })).toMatchObject({
      ok: false,
      problem: 'years',
    });
  });

  it('is no year after this one, no year before the first, and no death before the birth', () => {
    const noYears: QuerySubject = { ...marten, birthYear: null, deathYear: null };
    expect(ask({ birthYear: 2027 }, noYears)).toMatchObject({ ok: false, problem: 'years' });
    expect(ask({ birthYear: 0 }, noYears)).toMatchObject({ ok: false, problem: 'years' });
    expect(ask({ birthYear: 1855, deathYear: 1854 })).toMatchObject({
      ok: false,
      problem: 'years',
    });
  });

  it('may be a year the tree does not have, when a life can hold it', () => {
    const noDeath: QuerySubject = { ...marten, deathYear: null };
    expect(ask({ deathYear: 1921 }, noDeath).ok).toBe(true);
    expect(ask({ deathYear: 1850 + LONGEST_LIFE }, noDeath).ok).toBe(true);
    expect(ask({ deathYear: 1850 + LONGEST_LIFE + 1 }, noDeath)).toMatchObject({
      ok: false,
      problem: 'years',
    });
    expect(ask({ deathYear: 1849 }, noDeath)).toMatchObject({ ok: false, problem: 'years' });

    const noBirth: QuerySubject = { ...marten, birthYear: null };
    expect(ask({ birthYear: 1921 - LONGEST_LIFE }, noBirth).ok).toBe(true);
    expect(ask({ birthYear: 1922 }, noBirth)).toMatchObject({ ok: false, problem: 'years' });

    const noYears: QuerySubject = { ...marten, birthYear: null, deathYear: null };
    expect(ask({ birthYear: 1700, deathYear: 1760 }, noYears).ok).toBe(true);
    expect(ask({ birthYear: 1700, deathYear: 1900 }, noYears)).toMatchObject({
      ok: false,
      problem: 'years',
    });
  });

  it('counts a life from the year the tree has, not from the year that was asked for', () => {
    const noDeath: QuerySubject = { ...marten, deathYear: null };
    // Ten years after the tree's birth may be asked for, but the life is counted from 1850.
    expect(ask({ birthYear: 1860, deathYear: 1850 + LONGEST_LIFE }, noDeath).ok).toBe(true);
    expect(ask({ birthYear: 1860, deathYear: 1850 + LONGEST_LIFE + 1 }, noDeath)).toMatchObject({
      ok: false,
      problem: 'years',
    });
    // A death before the birth the tree has is no year of this life.
    expect(ask({ birthYear: 1845, deathYear: 1848 }, noDeath)).toMatchObject({
      ok: false,
      problem: 'years',
    });
    expect(ask({ birthYear: 1840, deathYear: 1840 }, noDeath)).toMatchObject({ ok: false });

    const noBirth: QuerySubject = { ...marten, birthYear: null };
    expect(ask({ birthYear: 1931, deathYear: 1931 }, noBirth)).toMatchObject({ ok: false });
    expect(ask({ birthYear: 1791, deathYear: 1911 }, noBirth)).toMatchObject({ ok: false });

    // Nor is a year near the tree's that lies beyond the other end of the life as the tree has it.
    const short: QuerySubject = { ...marten, birthYear: 1850, deathYear: 1852 };
    expect(ask({ birthYear: 1852 }, short).ok).toBe(true);
    expect(ask({ birthYear: 1858 }, short)).toMatchObject({ ok: false, problem: 'years' });
    expect(ask({ deathYear: 1849 }, short)).toMatchObject({ ok: false, problem: 'years' });
  });

  it('is no name that is punctuation only', () => {
    const noGiven: QuerySubject = { ...marten, names: [{ given: '', surname: 'Veldkamp' }] };
    for (const given of ['.', "'", '-']) {
      expect(ask({ given }, noGiven), given).toMatchObject({ ok: false, problem: 'name' });
      expect(ask({ given }), given).toMatchObject({ ok: false, problem: 'name' });
    }
  });

  it('is no year of the last hundred where the tree has no year at all', () => {
    const noYears: QuerySubject = { ...marten, birthYear: null, deathYear: null };
    expect(ask({ birthYear: 2026 - GUESS_YEARS_AGO }, noYears).ok).toBe(true);
    expect(ask({ birthYear: 2026 - GUESS_YEARS_AGO + 1 }, noYears)).toMatchObject({
      ok: false,
      problem: 'years',
    });
    expect(ask({ birthYear: 1900, deathYear: 1980 }, noYears)).toMatchObject({
      ok: false,
      problem: 'years',
    });
    // With one year in the tree, the other is held against it and may be recent.
    expect(ask({ deathYear: 1990 }, { ...marten, birthYear: 1920, deathYear: null }).ok).toBe(true);
  });

  it('is nothing that has another shape', () => {
    for (const asked of [
      null,
      'Marten Veldkamp',
      { given: 'Marten', surname: 'Veldkamp' },
      { given: 'Marten', surname: 'Veldkamp', birthYear: '1850', deathYear: null },
      { given: 'Marten', surname: 'Veldkamp', birthYear: 1850.5, deathYear: null },
      { given: 'Marten', surname: 'Veldkamp', birthYear: null, deathYear: null, place: 'Zwolle' },
      { given: 'x'.repeat(1001), surname: 'Veldkamp', birthYear: null, deathYear: null },
    ]) {
      expect(checkQuery(asked, marten, 2026), JSON.stringify(asked)).toMatchObject({
        ok: false,
        problem: 'shape',
      });
    }
  });

  it('is nothing for a person the tree has no name for', () => {
    expect(ask({}, { names: [], birthYear: 1850, deathYear: null })).toMatchObject({
      ok: false,
      problem: 'name',
    });
    // A name of one part is asked for only as it stands, and that is refused for want of the other part.
    expect(
      ask(
        { given: '', surname: 'Veldkamp' },
        { ...marten, names: [{ given: '', surname: 'Veldkamp' }] },
      ),
    ).toMatchObject({ ok: false, problem: 'name' });
  });
});
