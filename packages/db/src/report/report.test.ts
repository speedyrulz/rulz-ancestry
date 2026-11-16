import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPORT_KINDS, renderHtml, type ReportKind } from '@rulz/core';
import { addPartner } from '../actions';
import { addFamilyEvent, addPersonEvent } from '../events';
import { createFamily, addChild } from '../families';
import { presumedLivingIds } from '../living';
import { addMediaFiles, updateMedia, type MediaTarget } from '../media';
import { createPerson, updatePerson } from '../persons';
import { addCitation, linkCitation, type CitationTarget } from '../sources';
import { cleanUpAfterEach, pngBytes, tempDir, track } from '../testing';
import { createTree, NotFoundError, type Tree } from '../tree';
import {
  REPORT_BUILDERS,
  ReportRefusedError,
  buildReport,
  type ReportBuild,
  type ReportPrivacy,
} from './index';

cleanUpAfterEach();

/** What a marker is expected to do. */
interface Marker {
  text: string;
  /** With the filter on, the report must not hold it. */
  hiddenWhenOn: boolean;
  /** With the filter off, some report must hold it. */
  shownWhenOff: boolean;
}

/** A tree made up for the leak test, with a unique marker string in every field of the living. */
class Fixture {
  readonly tree: Tree = track(createTree(tempDir(), { name: 'Leak' }));
  readonly markers: Marker[] = [];
  /** Every id of a person who may be living; none may appear in a report. */
  readonly livingPeople: string[] = [];
  readonly families: string[] = [];
  readonly #files = tempDir();
  #count = 0;
  #seed = 0;

  /** A new marker: letters and digits only, so that escaping cannot change it. */
  mark(field: string, expected: Pick<Marker, 'hiddenWhenOn' | 'shownWhenOff'>): string {
    this.#count += 1;
    const text = `ZQ${String(this.#count).padStart(3, '0')}${field}`;
    this.markers.push({ text, ...expected });
    return text;
  }

  /** A marker of someone living: hidden whenever the filter is on. */
  living(field: string, printed = true): string {
    return this.mark(field, { hiddenWhenOn: true, shownWhenOff: printed });
  }

  /** A note, transcription or picture of someone dead: left out with the filter on. */
  leftOut(field: string): string {
    return this.mark(field, { hiddenWhenOn: true, shownWhenOff: true });
  }

  /** A fact of someone dead that the report always prints. */
  kept(field: string): string {
    return this.mark(field, { hiddenWhenOn: false, shownWhenOff: true });
  }

  /** A person with a name, and facts. `owner` says whose markers they are. */
  person(owner: 'living' | 'dead', label: string, extra: { sex?: 'M' | 'F' } = {}) {
    const mark = (field: string, printed = true) =>
      owner === 'living' || !printed
        ? this.living(`${label}${field}`, printed)
        : this.kept(`${label}${field}`);
    const person = createPerson(this.tree, {
      sex: extra.sex ?? 'U',
      living: owner === 'living' ? true : false,
      name: {
        given: mark('Given'),
        surname: mark('Surname'),
        nickname: mark('Nick'),
      },
    });
    if (owner === 'living') this.livingPeople.push(person.id);
    const birth = addPersonEvent(this.tree, person.id, {
      type: 'birth',
      date: mark('BirthDate'),
      place: mark('BirthPlace'),
      description: mark('BirthDetail'),
      note:
        owner === 'living' ? this.living(`${label}BirthNote`) : this.leftOut(`${label}BirthNote`),
    });
    // Not on the sheet at all: it must still never reach it.
    addPersonEvent(this.tree, person.id, {
      type: 'occupation',
      date: '1900',
      description: mark('Job', false),
    });
    return { id: person.id, birthId: birth.id, label };
  }

  /** A note on the person, a citation with a transcription and a note, and a picture. */
  attachments(owner: 'living' | 'dead', label: string, personId: string, eventId: string): void {
    const kind = (field: string) =>
      owner === 'living' ? this.living(`${label}${field}`) : this.leftOut(`${label}${field}`);
    updatePerson(this.tree, personId, { note: kind('Note') });
    this.cite(owner, label, { type: 'event', id: eventId });
    this.cite(owner, `${label}Whole`, { type: 'person', id: personId });
    this.picture(kind(`Picture`), { type: 'person', id: personId });
    this.picture(kind(`EventPicture`), { type: 'event', id: eventId });
  }

  cite(owner: 'living' | 'dead', label: string, target: CitationTarget): void {
    const printed = (field: string) =>
      owner === 'living' ? this.living(`${label}${field}`) : this.kept(`${label}${field}`);
    const left = (field: string) =>
      owner === 'living' ? this.living(`${label}${field}`) : this.leftOut(`${label}${field}`);
    addCitation(
      this.tree,
      target,
      { create: { title: printed('SourceTitle') } },
      { page: printed('Page'), text: left('CiteText'), note: left('CiteNote') },
    );
  }

  picture(title: string, target: MediaTarget): void {
    this.#seed += 1;
    const file = join(this.#files, `picture-${this.#seed}.png`);
    writeFileSync(file, pngBytes(8, 8, this.#seed));
    const [added] = addMediaFiles(this.tree, [file], target);
    updateMedia(this.tree, added!.media.id, { title });
  }

  family(partner1: string | null, partner2: string | null): string {
    const family = createFamily(this.tree, { partner1Id: partner1, partner2Id: partner2 });
    this.families.push(family.id);
    return family.id;
  }
}

/** The made-up tree: couples of every mix of living and dead, and living and dead children. */
function leakTree(): Fixture {
  const fx = new Fixture();

  // Ada is dead, her husband Lionel is living; their marriage says things that name him.
  const ada = fx.person('dead', 'Ada', { sex: 'F' });
  addPersonEvent(fx.tree, ada.id, { type: 'death', date: fx.kept('AdaDeathDate') });
  fx.attachments('dead', 'Ada', ada.id, ada.birthId);
  const lionel = fx.person('living', 'Lionel', { sex: 'M' });
  fx.attachments('living', 'Lionel', lionel.id, lionel.birthId);
  const marriage = fx.family(ada.id, lionel.id);
  const wedding = addFamilyEvent(fx.tree, marriage, {
    type: 'marriage',
    date: fx.living('WeddingDate'),
    place: fx.living('WeddingPlace'),
    description: fx.living('WeddingDetail'),
    note: fx.living('WeddingNote'),
  });
  fx.cite('living', 'Wedding', { type: 'event', id: wedding.id });
  fx.cite('living', 'Family', { type: 'family', id: marriage });
  fx.picture(fx.living('WeddingPicture'), { type: 'event', id: wedding.id });
  fx.picture(fx.living('FamilyPicture'), { type: 'family', id: marriage });

  // Their children: one living, one dead; the dead one has a living partner.
  const liveChild = fx.person('living', 'Rowan', { sex: 'M' });
  addChild(fx.tree, marriage, liveChild.id);
  const deadChild = fx.person('dead', 'Wren');
  fx.attachments('dead', 'Wren', deadChild.id, deadChild.birthId);
  addChild(fx.tree, marriage, deadChild.id);
  const inLaw = fx.person('living', 'Sage');
  fx.family(deadChild.id, inLaw.id);

  // Ada's parents: her mother is living.
  const mother = fx.person('living', 'Maeve', { sex: 'F' });
  const father = fx.person('dead', 'Fergus', { sex: 'M' });
  addPersonEvent(fx.tree, father.id, { type: 'death', date: fx.kept('FergusDeathDate') });
  const parents = fx.family(father.id, mother.id);
  addChild(fx.tree, parents, ada.id);

  // A couple who are both dead, with a living child.
  const dadA = fx.person('dead', 'Dara', { sex: 'M' });
  addPersonEvent(fx.tree, dadA.id, { type: 'death', date: fx.kept('DaraDeathDate') });
  const momB = fx.person('dead', 'Bea', { sex: 'F' });
  addPersonEvent(fx.tree, momB.id, { type: 'death', date: fx.kept('BeaDeathDate') });
  const deadCouple = fx.family(dadA.id, momB.id);
  const deadWedding = addFamilyEvent(fx.tree, deadCouple, {
    type: 'marriage',
    date: fx.kept('DeadWeddingDate'),
    place: fx.kept('DeadWeddingPlace'),
    note: fx.leftOut('DeadWeddingNote'),
  });
  fx.cite('dead', 'DeadWedding', { type: 'event', id: deadWedding.id });
  const liveKid = fx.person('living', 'Tern', { sex: 'F' });
  addChild(fx.tree, deadCouple, liveKid.id);

  // Two living people: nothing of this family can be shown.
  const first = fx.person('living', 'Yarrow');
  const second = fx.person('living', 'Zinnia');
  fx.family(first.id, second.id);

  return fx;
}

interface LeakRow {
  /** Builds the report and its HTML for one family. */
  build(
    fx: Fixture,
    familyId: string,
    privacy: ReportPrivacy,
  ): { built: ReportBuild; html: string };
}

/**
 * One row for every kind of report. The type makes a new kind in REPORT_KINDS
 * a compile error until it has a row, and the test below checks the same.
 */
const LEAK_ROWS: Record<ReportKind, LeakRow> = {
  'family-group': {
    build: (fx, familyId, privacy) => {
      const built = buildReport(fx.tree, { kind: 'family-group', familyId }, privacy);
      return { built, html: renderHtml(built.model) };
    },
  },
};

function privacyOf(fx: Fixture, includeLiving: boolean): ReportPrivacy {
  return { livingIds: presumedLivingIds(fx.tree), includeLiving };
}

describe('the leak table', () => {
  it('has a row for every kind of report and a builder for every row', () => {
    expect(Object.keys(LEAK_ROWS).sort()).toEqual([...REPORT_KINDS].sort());
    expect(Object.keys(REPORT_BUILDERS).sort()).toEqual([...REPORT_KINDS].sort());
  });

  it('is built from people who really count as living', () => {
    const fx = leakTree();
    const living = presumedLivingIds(fx.tree);
    for (const id of fx.livingPeople) expect(living.has(id)).toBe(true);
    expect(living.size).toBe(fx.livingPeople.length);
  });

  describe.each(REPORT_KINDS)('%s', (kind) => {
    const row = LEAK_ROWS[kind];

    /** Every report of the kind that can be made, as the page would ask for them. */
    function everyReport(fx: Fixture, includeLiving: boolean) {
      const privacy = privacyOf(fx, includeLiving);
      const made: { familyId: string; built: ReportBuild; html: string }[] = [];
      const refused: string[] = [];
      for (const familyId of fx.families) {
        try {
          made.push({ familyId, ...row.build(fx, familyId, privacy) });
        } catch (error) {
          if (!(error instanceof ReportRefusedError)) throw error;
          refused.push(familyId);
        }
      }
      return { made, refused };
    }

    it('leaves out every marker of the living, and every id, when the filter is on', () => {
      const fx = leakTree();
      const { made, refused } = everyReport(fx, false);
      // The couple who are both living is refused, the rest are made.
      expect(refused).toHaveLength(1);
      expect(made).toHaveLength(fx.families.length - 1);
      for (const { familyId, built, html } of made) {
        const everything = `${html}\n${JSON.stringify(built.model)}`;
        for (const marker of fx.markers.filter((entry) => entry.hiddenWhenOn)) {
          expect(everything, `${marker.text} in the report of ${familyId}`).not.toContain(
            marker.text,
          );
        }
        for (const id of [...fx.livingPeople, ...fx.families]) {
          expect(everything, `an id in the report of ${familyId}`).not.toContain(id);
        }
      }
      // A hidden child's sex is not said either. The only shown child with a sex is Ada, a daughter;
      // the living son and the living daughter must add no "Male" and no second "Female".
      const words = made.map((entry) => entry.html).join(' ');
      expect(words).not.toMatch(/(?<![a-z])Male(?![a-z])/);
      expect(words.match(/(?<![a-z])Female(?![a-z])/g)).toHaveLength(1);
      // What is kept is still there.
      const all = made.map((entry) => entry.html).join('\n');
      for (const marker of fx.markers.filter((entry) => !entry.hiddenWhenOn)) {
        expect(all, marker.text).toContain(marker.text);
      }
      expect(all).toContain('Living');
    });

    it('holds the markers when the filter is off', () => {
      const fx = leakTree();
      const { made, refused } = everyReport(fx, true);
      expect(refused).toEqual([]);
      const all = made.map((entry) => entry.html).join('\n');
      expect(all).toMatch(/(?<![a-z])Male(?![a-z])/);
      expect(all).toMatch(/(?<![a-z])Female(?![a-z])/);
      for (const marker of fx.markers.filter((entry) => entry.shownWhenOff)) {
        expect(all, marker.text).toContain(marker.text);
      }
      for (const { built } of made) {
        expect(built).toMatchObject({
          livingOmitted: 0,
          notesOmitted: 0,
          citationTextsOmitted: 0,
          mediaOmitted: 0,
        });
      }
    });
  });
});

describe('the family group sheet', () => {
  /** A dead couple and their dead child, with a living child and a living partner of the dead child. */
  function small(husbandGiven = 'Hal') {
    const tree = track(createTree(tempDir(), { name: 'Small' }));
    const husband = createPerson(tree, {
      sex: 'M',
      living: false,
      name: { given: husbandGiven, surname: 'Marsh' },
    });
    const wife = createPerson(tree, {
      sex: 'F',
      living: false,
      name: { given: 'Eve', surname: 'Marsh' },
    });
    const couple = createFamily(tree, { partner1Id: husband.id, partner2Id: wife.id }).id;
    return { tree, husband, wife, couple };
  }

  it('says why it refuses a family whose partners are all living, but only with the filter on', () => {
    const tree = track(createTree(tempDir(), { name: 'Living' }));
    const a = createPerson(tree, { living: true, name: { given: 'Ann', surname: 'Now' } });
    const family = addPartner(tree, a.id, { create: { given: 'Ben' } }).familyId;
    const living = presumedLivingIds(tree);
    expect(() =>
      buildReport(
        tree,
        { kind: 'family-group', familyId: family },
        { livingIds: living, includeLiving: false },
      ),
    ).toThrow(ReportRefusedError);
    const built = buildReport(
      tree,
      { kind: 'family-group', familyId: family },
      { livingIds: living, includeLiving: true },
    );
    expect(built.model.title).toBe('Family group sheet: Ann Now and Ben');
  });

  it('accepts a family with one living and one dead partner, and names the living one "Living"', () => {
    const { tree, husband, wife, couple } = small();
    updatePerson(tree, wife.id, { living: true });
    addFamilyEvent(tree, couple, { type: 'marriage', date: '1 JAN 1901', place: 'Hidden Place' });
    const built = buildReport(
      tree,
      { kind: 'family-group', familyId: couple },
      { livingIds: presumedLivingIds(tree), includeLiving: false },
    );
    const html = renderHtml(built.model);
    expect(built.model.title).toBe('Family group sheet: Hal Marsh and Living');
    expect(built.livingOmitted).toBe(1);
    // The couple rule: a marriage is said of both partners, so it goes with one of them.
    expect(html).not.toContain('Hidden Place');
    expect(html).not.toContain('1 JAN 1901');
    expect(html).not.toContain('Eve');
    expect(html).toContain('What is recorded of this couple is left out');
    expect(husband.id).not.toBe(wife.id);
  });

  it('counts the notes, citation texts and pictures it leaves out, and nothing else', () => {
    const { tree, husband, wife, couple } = small();
    const files = tempDir();
    updatePerson(tree, husband.id, { note: 'A note of the husband' });
    const child = createPerson(tree, { living: false, name: { given: 'Kit', surname: 'Marsh' } });
    updatePerson(tree, child.id, { note: 'A note of the child' });
    addChild(tree, couple, child.id);
    const birth = addPersonEvent(tree, husband.id, {
      type: 'birth',
      date: '1850',
      note: 'A note of the birth',
    });
    addPersonEvent(tree, wife.id, { type: 'birth', date: '1852', note: 'A note of the wife' });
    addCitation(
      tree,
      { type: 'event', id: birth.id },
      { create: { title: 'Parish register' } },
      { page: 'folio 4', text: 'A transcription', note: 'A remark' },
    );
    // The same citation on a second event is one citation, and one text.
    addCitation(
      tree,
      { type: 'family', id: couple },
      { create: { title: 'Second book' } },
      { text: 'Another transcription' },
    );
    for (const [seed, target] of [
      [1, { type: 'person', id: husband.id }],
      [2, { type: 'event', id: birth.id }],
      [3, { type: 'family', id: couple }],
    ] as const) {
      const file = join(files, `p${seed}.png`);
      writeFileSync(file, pngBytes(8, 8, seed));
      addMediaFiles(tree, [file], target);
    }
    const living = presumedLivingIds(tree);
    const off = buildReport(
      tree,
      { kind: 'family-group', familyId: couple },
      { livingIds: living, includeLiving: false },
    );
    expect(off).toMatchObject({
      livingOmitted: 0,
      // The husband's, the birth's, the wife's and the child's notes, and the remark of the citation.
      notesOmitted: 5,
      citationTextsOmitted: 2,
      mediaOmitted: 3,
    });
    const html = renderHtml(off.model);
    expect(html).toContain('Parish register, folio 4.');
    expect(html).toContain('Second book.');
    for (const hidden of ['A note of', 'A transcription', 'Another transcription', 'A remark']) {
      expect(html).not.toContain(hidden);
    }
    expect(html).toContain('5 notes, 2 source texts, 3 pictures and documents');

    const on = buildReport(
      tree,
      { kind: 'family-group', familyId: couple },
      { livingIds: living, includeLiving: true },
    );
    expect(on).toMatchObject({ notesOmitted: 0, citationTextsOmitted: 0, mediaOmitted: 0 });
    const full = renderHtml(on.model);
    for (const shown of [
      'A note of the husband',
      'A note of the child',
      'A transcription',
      'Another transcription',
      'A remark',
    ]) {
      expect(full).toContain(shown);
    }
  });

  it('numbers the citations in the order they appear and gives a repeated one one number', () => {
    const { tree, husband, wife, couple } = small();
    const birthH = addPersonEvent(tree, husband.id, { type: 'birth', date: '1850' });
    const birthW = addPersonEvent(tree, wife.id, { type: 'birth', date: '1852' });
    const cited = addCitation(
      tree,
      { type: 'event', id: birthH.id },
      { create: { title: 'First' } },
      {},
    );
    // The same citation supports the wife's birth too.
    linkCitation(tree, cited.id, { type: 'event', id: birthW.id });
    addCitation(tree, { type: 'family', id: couple }, { create: { title: 'Second' } }, {});
    const built = buildReport(
      tree,
      { kind: 'family-group', familyId: couple },
      { livingIds: new Set(), includeLiving: true },
    );
    const html = renderHtml(built.model);
    expect(html.match(/<sup class="note">1<\/sup>/g)).toHaveLength(2);
    expect(html.match(/<sup class="note">2<\/sup>/g)).toHaveLength(1);
    expect(html).toContain('<ol><li>First.</li><li>Second.</li></ol>');
  });

  it('prints a name with markup in it as text', () => {
    const nasty = '<script>alert("x")</script>';
    const { tree, husband, couple } = small(nasty);
    addPersonEvent(tree, husband.id, {
      type: 'birth',
      date: '1850',
      place: '"><img src=x onerror=alert(1)>',
    });
    const html = renderHtml(
      buildReport(
        tree,
        { kind: 'family-group', familyId: couple },
        { livingIds: new Set(), includeLiving: false },
      ).model,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Marsh');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('names no address, with a web address in a note, a citation or a picture', () => {
    const { tree, husband, wife, couple } = small();
    updatePerson(tree, husband.id, {
      note: 'See <img src="http://evil.example/x.png"> and https://evil.example/',
    });
    const birth = addPersonEvent(tree, husband.id, { type: 'birth', date: '1850' });
    addCitation(
      tree,
      { type: 'event', id: birth.id },
      { create: { title: 'Register' } },
      {
        text: 'http://evil.example/text',
        url: 'https://evil.example/record',
        note: '//evil.example',
      },
    );
    const file = join(tempDir(), 'a.png');
    writeFileSync(file, pngBytes(8, 8));
    const [added] = addMediaFiles(tree, [file], { type: 'person', id: wife.id });
    updateMedia(tree, added!.media.id, { title: 'url(https://evil.example/pic.png)' });
    const filtered = renderHtml(
      buildReport(
        tree,
        { kind: 'family-group', familyId: couple },
        { livingIds: new Set(), includeLiving: false },
      ).model,
    );
    expect(filtered).not.toMatch(/https?:/i);
    expect(filtered).not.toContain('//');
    expect(filtered).not.toMatch(/url\((?!\s*['"]?data:)/i);
    expect(filtered).not.toMatch(/\b(?:src|href)\s*=/i);
    // With the filter off the texts are printed, as text and never as markup or a link.
    const full = renderHtml(
      buildReport(
        tree,
        { kind: 'family-group', familyId: couple },
        { livingIds: new Set(), includeLiving: true },
      ).model,
    );
    expect(full).not.toMatch(/<(?:img|a|link|iframe|script|object)\b/i);
    expect(full).toContain('&lt;img src=&quot;http://evil.example/x.png&quot;&gt;');
    // The address field of a citation is never printed.
    expect(full).not.toContain('https://evil.example/record');
  });

  it('reports a family that does not exist as not found', () => {
    const { tree } = small();
    expect(() =>
      buildReport(
        tree,
        { kind: 'family-group', familyId: '00000000-0000-7000-8000-000000000000' },
        { livingIds: new Set(), includeLiving: false },
      ),
    ).toThrow(NotFoundError);
  });
});
