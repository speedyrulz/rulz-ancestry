import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPORT_GENERATIONS,
  REPORT_KINDS,
  checkSvg,
  renderHtml,
  type PersonReportKind,
  type ReportKind,
} from '@rulz/core';
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
  type ReportSubject,
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
  /** Every person of the tree, living or not. */
  readonly everyone: string[] = [];
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
    this.everyone.push(person.id);
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

  // A dead child of the dead couple, so that their marriage is part of someone's ancestry.
  const cove = fx.person('dead', 'Cove');
  addChild(fx.tree, deadCouple, cove.id);

  // A living man between two dead ones: Elm's father Hob was marked living by hand, and his father Ivo is dead.
  const ivo = fx.person('dead', 'Ivo');
  addPersonEvent(fx.tree, ivo.id, { type: 'death', date: fx.kept('IvoDeathDate') });
  const hob = fx.person('living', 'Hob');
  addChild(fx.tree, fx.family(ivo.id, null), hob.id);
  const nell = fx.person('dead', 'Nell');
  const elm = fx.person('dead', 'Elm');
  addChild(fx.tree, fx.family(hob.id, nell.id), elm.id);

  // Pedigree collapse: first cousins Mo and Ned are the parents of Oz, so that
  // Gus and Pia, the grandparents of both, are Oz's ancestors twice. Pia is marked living.
  const gus = fx.person('dead', 'Gus');
  const pia = fx.person('living', 'Pia');
  const grandparents = fx.family(gus.id, pia.id);
  const kai = fx.person('dead', 'Kai');
  const lou = fx.person('dead', 'Lou');
  addChild(fx.tree, grandparents, kai.id);
  addChild(fx.tree, grandparents, lou.id);
  const wynn = fx.person('dead', 'Wynn');
  const xan = fx.person('dead', 'Xan');
  const mo = fx.person('dead', 'Mo');
  const ned = fx.person('dead', 'Ned');
  addChild(fx.tree, fx.family(kai.id, wynn.id), mo.id);
  addChild(fx.tree, fx.family(lou.id, xan.id), ned.id);
  const oz = fx.person('dead', 'Oz');
  addChild(fx.tree, fx.family(mo.id, ned.id), oz.id);

  // Two living people: nothing of this family can be shown.
  const first = fx.person('living', 'Yarrow');
  const second = fx.person('living', 'Zinnia');
  fx.family(first.id, second.id);

  return fx;
}

/** One report that can be asked of the fixture: its subject, as the page would name it. */
interface LeakCase {
  label: string;
  subject: ReportSubject;
  /** The person the report is of, when it is of one person. */
  of: string | null;
}

interface LeakRow {
  /** Every report of this kind that the page could ask for in the fixture. */
  cases(fx: Fixture): LeakCase[];
  /** The markers of the dead that this kind of report prints however the filter is set. */
  prints: RegExp;
  /** The markers of the living that it prints with the filter off. */
  printsLiving: RegExp;
  /** How many of its reports the filter on must refuse. */
  refusedWhenOn(fx: Fixture): number;
}

/** The names, years and places a report of one person prints, and the facts a pedigree states. */
const NAMES = /(Given|Surname|Nick)$/;
const AHNENTAFEL_FACTS =
  /(Given|Surname|Nick|BirthDate|BirthPlace|DeathDate|WeddingDate|WeddingPlace)$/;

/** One report of a person for each generation count a kind allows, at its least and its most. */
function personCases(fx: Fixture, kind: PersonReportKind): LeakCase[] {
  const { min, max } = REPORT_GENERATIONS[kind];
  const cases: LeakCase[] = [];
  for (const [index, personId] of fx.everyone.entries()) {
    for (const generations of [min, max]) {
      cases.push({
        label: `${kind} of person ${index} over ${generations}`,
        subject: { kind, personId, generations } as ReportSubject,
        of: personId,
      });
    }
  }
  return cases;
}

const personRow = (kind: PersonReportKind, prints: RegExp, printsLiving: RegExp): LeakRow => ({
  cases: (fx) => personCases(fx, kind),
  prints,
  printsLiving,
  // Every report of a living person is refused, with the filter on.
  refusedWhenOn: (fx) => fx.livingPeople.length * 2,
});

/**
 * One row for every kind of report. The type makes a new kind in REPORT_KINDS
 * a compile error until it has a row, and the test below checks the same.
 */
const LEAK_ROWS: Record<ReportKind, LeakRow> = {
  'family-group': {
    cases: (fx) =>
      fx.families.map((familyId, index) => ({
        label: `family ${index}`,
        subject: { kind: 'family-group', familyId },
        of: null,
      })),
    prints: /./,
    printsLiving: /./,
    // The couple who are both living.
    refusedWhenOn: () => 1,
  },
  ahnentafel: personRow('ahnentafel', AHNENTAFEL_FACTS, AHNENTAFEL_FACTS),
  'chart-pedigree': personRow('chart-pedigree', NAMES, NAMES),
  'chart-descendants': personRow('chart-descendants', NAMES, NAMES),
  'chart-hourglass': personRow('chart-hourglass', NAMES, NAMES),
  'chart-fan': personRow('chart-fan', NAMES, NAMES),
};

function privacyOf(fx: Fixture, includeLiving: boolean): ReportPrivacy {
  return { livingIds: presumedLivingIds(fx.tree), includeLiving };
}

/** Every SVG drawing in a page of HTML. */
function drawingsOf(html: string): string[] {
  return html.match(/<svg[\s\S]*?<\/svg>/g) ?? [];
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
      const made: { label: string; built: ReportBuild; html: string }[] = [];
      const refused: LeakCase[] = [];
      for (const entry of row.cases(fx)) {
        try {
          const built = buildReport(fx.tree, entry.subject, privacy);
          made.push({ label: entry.label, built, html: renderHtml(built.model) });
        } catch (error) {
          if (!(error instanceof ReportRefusedError)) throw error;
          refused.push(entry);
        }
      }
      return { made, refused };
    }

    it('leaves out every marker of the living, and every id, when the filter is on', () => {
      const fx = leakTree();
      const { made, refused } = everyReport(fx, false);
      // Only what is of someone living (or of a couple who are all living) is refused.
      expect(refused).toHaveLength(row.refusedWhenOn(fx));
      expect(made.length).toBeGreaterThan(0);
      for (const entry of refused) {
        if (entry.of !== null) expect(fx.livingPeople).toContain(entry.of);
      }
      for (const { label, built, html } of made) {
        // The page, the model, and so the title that a footer and a file name are made from.
        const everything = `${html}\n${JSON.stringify(built.model)}`;
        for (const marker of fx.markers.filter((entry) => entry.hiddenWhenOn)) {
          expect(everything, `${marker.text} in ${label}`).not.toContain(marker.text);
        }
        for (const id of [...fx.everyone, ...fx.families]) {
          expect(everything, `an id in ${label}`).not.toContain(id);
        }
        // Every drawing is plain shapes and text.
        for (const drawing of drawingsOf(html)) expect(() => checkSvg(drawing)).not.toThrow();
      }
      // A hidden person's sex is not said either (the pages say a sex only in a family sheet).
      if (kind === 'family-group') {
        const words = made.map((entry) => entry.html).join(' ');
        expect(words).not.toMatch(/(?<![a-z])Male(?![a-z])/);
        expect(words.match(/(?<![a-z])Female(?![a-z])/g)).toHaveLength(1);
      }
      // What is kept is still there.
      const all = made.map((entry) => entry.html).join('\n');
      for (const marker of fx.markers.filter((entry) => !entry.hiddenWhenOn)) {
        if (row.prints.test(marker.text)) expect(all, marker.text).toContain(marker.text);
      }
      expect(all).toContain('Living');
    });

    it('holds the markers when the filter is off', () => {
      const fx = leakTree();
      const { made, refused } = everyReport(fx, true);
      expect(refused).toEqual([]);
      const all = made.map((entry) => entry.html).join('\n');
      if (kind === 'family-group') {
        expect(all).toMatch(/(?<![a-z])Male(?![a-z])/);
        expect(all).toMatch(/(?<![a-z])Female(?![a-z])/);
      }
      for (const marker of fx.markers.filter((entry) => entry.shownWhenOff)) {
        if (row.printsLiving.test(marker.text)) expect(all, marker.text).toContain(marker.text);
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
    const a = createPerson(tree, { living: true, name: { given: 'Odile', surname: 'Now' } });
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
    expect(built.model.title).toBe('Family group sheet: Odile Now and Ben');
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

/** A small tree of dead people for the tests of one report: parents, a marriage, and a place for the person. */
function lineage() {
  const tree = track(createTree(tempDir(), { name: 'Lineage' }));
  const dead = (given: string, surname: string, extra: { birth?: string; place?: string } = {}) => {
    const person = createPerson(tree, { sex: 'U', living: false, name: { given, surname } });
    if (extra.birth !== undefined) {
      addPersonEvent(tree, person.id, {
        type: 'birth',
        date: extra.birth,
        place: extra.place ?? '',
      });
    }
    return person;
  };
  return { tree, dead };
}

const OFF: ReportPrivacy = { livingIds: new Set(), includeLiving: false };

describe('the Ahnentafel', () => {
  const build = (tree: Tree, personId: string, generations: number, privacy: ReportPrivacy = OFF) =>
    buildReport(tree, { kind: 'ahnentafel', personId, generations }, privacy);

  /** The cells of the row for a number, as text with " | " between them; empty when there is no such row. */
  const rowOf = (html: string, number: number): string => {
    const found = html.match(new RegExp(`<tr><td>${number}</td>(.*?)</tr>`));
    if (found === null) return '';
    return (found[1] ?? '')
      .split('</td><td>')
      .map((cell) => cell.replace(/<[^>]*>/g, ''))
      .join(' | ');
  };

  it('numbers the father 2n and the mother 2n + 1, grouped by generation, with births, deaths and marriages', () => {
    const { tree, dead } = lineage();
    const pat = dead('Pat', 'Marsh', { birth: '1880', place: 'Newtown' });
    const hal = dead('Hal', 'Marsh', { birth: '1850', place: 'Oldtown' });
    const eve = dead('Eve', 'Fallow', { birth: '1852' });
    const abe = dead('Abe', 'Marsh', { birth: '1820' });
    addPersonEvent(tree, hal.id, { type: 'death', date: '1 JAN 1910', place: 'Hilltop' });
    addPersonEvent(tree, eve.id, { type: 'burial', date: '4 JAN 1912' });
    const parents = createFamily(tree, { partner1Id: hal.id, partner2Id: eve.id });
    addChild(tree, parents.id, pat.id);
    addFamilyEvent(tree, parents.id, { type: 'marriage', date: '3 MAY 1875', place: 'Hilltop' });
    addChild(tree, createFamily(tree, { partner1Id: abe.id, partner2Id: null }).id, hal.id);

    const built = build(tree, pat.id, 3);
    const html = renderHtml(built.model);
    expect(built.model.title).toBe('Ahnentafel: Pat Marsh');
    expect(html).toContain('<h2>Generation 2: Parents</h2>');
    expect(html).toContain('<h2>Generation 3: Grandparents</h2>');
    expect(html).not.toContain('Generation 4');
    expect(rowOf(html, 1)).toContain('Pat Marsh');
    expect(rowOf(html, 2)).toContain('Hal Marsh');
    expect(rowOf(html, 3)).toContain('Eve Fallow');
    expect(rowOf(html, 4)).toContain('Abe Marsh');
    // Hal has no mother recorded, so number 5 is not listed.
    expect(rowOf(html, 5)).toBe('');
    expect(rowOf(html, 2)).toContain('1850, Oldtown');
    expect(rowOf(html, 2)).toContain('1 JAN 1910, Hilltop');
    // A burial stands in for a death that is not recorded, and says so.
    expect(rowOf(html, 3)).toContain('bur. 4 JAN 1912');
    // The couple's marriage is on both rows, each pointing at the other.
    expect(rowOf(html, 2)).toContain('3 MAY 1875, Hilltop (to 3)');
    expect(rowOf(html, 3)).toContain('3 MAY 1875, Hilltop (to 2)');
    expect(html).toContain('<h2>Generation 1: The person</h2>');
    expect(built).toMatchObject({ livingOmitted: 0, notesOmitted: 0, mediaOmitted: 0 });
  });

  it('says so when a person has no parents recorded', () => {
    const { tree, dead } = lineage();
    const pat = dead('Pat', 'Marsh');
    const html = renderHtml(build(tree, pat.id, 4).model);
    expect(html).toContain('No parents are recorded for this person.');
  });

  it('writes an ancestor of two lines once, at the lowest number, and refers to it after', () => {
    const { tree, dead } = lineage();
    const gus = dead('Gus', 'Grand', { birth: '1790', place: 'Firsttown' });
    const pia = dead('Pia', 'Grand');
    const gusFather = dead('Ivor', 'Grand', { birth: '1760' });
    addChild(tree, createFamily(tree, { partner1Id: gusFather.id, partner2Id: null }).id, gus.id);
    const grandparents = createFamily(tree, { partner1Id: gus.id, partner2Id: pia.id });
    const kai = dead('Kai', 'Grand');
    const lou = dead('Lou', 'Grand');
    addChild(tree, grandparents.id, kai.id);
    addChild(tree, grandparents.id, lou.id);
    const mo = dead('Mo', 'Cousin');
    const ned = dead('Ned', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: kai.id, partner2Id: null }).id, mo.id);
    addChild(tree, createFamily(tree, { partner1Id: lou.id, partner2Id: null }).id, ned.id);
    const oz = dead('Oz', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: mo.id, partner2Id: ned.id }).id, oz.id);

    const built = build(tree, oz.id, 6);
    const html = renderHtml(built.model);
    // Oz 1; Mo 2, Ned 3; Kai 4, Lou 6; Gus 8 and 12, Pia 9 and 13; Gus's father 16 and 24.
    expect(rowOf(html, 8)).toContain('Gus Grand');
    expect(rowOf(html, 8)).toContain('1790, Firsttown');
    expect(rowOf(html, 12)).toContain('Gus Grand, see 8');
    expect(rowOf(html, 12)).not.toContain('Firsttown');
    expect(rowOf(html, 13)).toContain('Pia Grand, see 9');
    // His father is written out once, at 16; 24 is the same person on the same line and is not repeated.
    expect(rowOf(html, 16)).toContain('Ivor Grand');
    expect(rowOf(html, 24)).toBe('');
    expect(html.match(/Firsttown/g)).toHaveLength(1);
    expect(html.match(/Ivor Grand/g)).toHaveLength(1);
    expect(html).toContain('written out once, at the lowest number');
    expect(built.model.metadata.find((row) => row.label === 'People listed')?.value).toEqual([
      '8 people, and 2 numbers that refer to someone listed above.',
    ]);
  });

  it('shows a living ancestor between two dead ones only as "Living", and the dead beyond as they are', () => {
    const { tree, dead } = lineage();
    const elm = dead('Elm', 'Dead', { birth: '1900' });
    const hob = createPerson(tree, {
      sex: 'M',
      living: true,
      name: { given: 'Hob', surname: 'Secretname' },
    });
    addPersonEvent(tree, hob.id, { type: 'birth', date: '1870', place: 'Secretville' });
    const ivo = dead('Ivo', 'Dead', { birth: '1840', place: 'Oldtown' });
    addChild(tree, createFamily(tree, { partner1Id: ivo.id, partner2Id: null }).id, hob.id);
    addChild(tree, createFamily(tree, { partner1Id: hob.id, partner2Id: null }).id, elm.id);
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };

    const built = build(tree, elm.id, 3, privacy);
    const html = renderHtml(built.model);
    expect(rowOf(html, 2)).toContain('Living');
    expect(rowOf(html, 4)).toContain('Ivo Dead');
    expect(rowOf(html, 4)).toContain('1840, Oldtown');
    expect(built.livingOmitted).toBe(1);
    expect(html).not.toMatch(/Hob|Secret/);
    expect(html).toContain('1 entry is shown only as &quot;Living&quot;');

    const full = renderHtml(build(tree, elm.id, 3, { ...privacy, includeLiving: true }).model);
    expect(rowOf(full, 2)).toContain('Hob Secretname');
    expect(rowOf(full, 2)).toContain('1870, Secretville');
  });

  it('says a marriage only when neither partner is living, and the root has the partner as "Living"', () => {
    const { tree, dead } = lineage();
    const pat = dead('Pat', 'Marsh');
    const hal = dead('Hal', 'Marsh');
    const eve = createPerson(tree, { living: true, name: { given: 'Eve', surname: 'Secretname' } });
    const parents = createFamily(tree, { partner1Id: hal.id, partner2Id: eve.id });
    addChild(tree, parents.id, pat.id);
    addFamilyEvent(tree, parents.id, { type: 'marriage', date: '3 MAY 1875', place: 'Hilltop' });
    const wife = createPerson(tree, {
      living: true,
      name: { given: 'Una', surname: 'Secretname' },
    });
    const own = createFamily(tree, { partner1Id: pat.id, partner2Id: wife.id });
    addFamilyEvent(tree, own.id, { type: 'marriage', date: '9 JUN 1900', place: 'Secretchurch' });
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };

    const html = renderHtml(build(tree, pat.id, 2, privacy).model);
    expect(rowOf(html, 2)).not.toContain('Hilltop');
    expect(rowOf(html, 3)).not.toContain('Hilltop');
    expect(rowOf(html, 1)).toContain('Living');
    expect(html).not.toMatch(/Una|Eve|Secret|1900|1875/);

    const full = renderHtml(build(tree, pat.id, 2, { ...privacy, includeLiving: true }).model);
    expect(rowOf(full, 2)).toContain('3 MAY 1875, Hilltop (to 3)');
    expect(rowOf(full, 1)).toContain('Una Secretname: 9 JUN 1900, Secretchurch');
  });

  it('never says that two "Living" rows are one person, and writes the ancestors of each out again', () => {
    const { tree, dead } = lineage();
    // Gus is living, and the grandfather of both Mo and Ned, who are cousins and the parents of Oz.
    const gus = createPerson(tree, { living: true, name: { given: 'Gus', surname: 'Secretname' } });
    addPersonEvent(tree, gus.id, { type: 'birth', date: '1960', place: 'Secretville' });
    const ivor = dead('Ivor', 'Elder', { birth: '1760' });
    addChild(tree, createFamily(tree, { partner1Id: ivor.id, partner2Id: null }).id, gus.id);
    const grandparents = createFamily(tree, { partner1Id: gus.id, partner2Id: null });
    const kai = dead('Kai', 'Grand');
    const lou = dead('Lou', 'Grand');
    addChild(tree, grandparents.id, kai.id);
    addChild(tree, grandparents.id, lou.id);
    const mo = dead('Mo', 'Cousin');
    const ned = dead('Ned', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: kai.id, partner2Id: null }).id, mo.id);
    addChild(tree, createFamily(tree, { partner1Id: lou.id, partner2Id: null }).id, ned.id);
    const oz = dead('Oz', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: mo.id, partner2Id: ned.id }).id, oz.id);
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };

    // Oz 1; Mo 2, Ned 3; Kai 4, Lou 6; Gus 8 and 12; Gus's father Ivor 16 and 24.
    const built = build(tree, oz.id, 6, privacy);
    const html = renderHtml(built.model);
    expect(rowOf(html, 8)).toBe('Living |  |  | ');
    expect(rowOf(html, 12)).toBe('Living |  |  | ');
    expect(html).not.toMatch(/see (8|12)/);
    // The numbers have no gap, and the dead ancestor of each is written out and is the repeat.
    expect(rowOf(html, 16)).toContain('Ivor Elder');
    expect(rowOf(html, 24)).toContain('Ivor Elder, see 16');
    expect(html).not.toContain('numbers that refer');
    expect(html).toContain('<td>8</td>');
    expect(html).not.toMatch(/Gus|Secret/);
    expect(built.livingOmitted).toBe(2);

    // With living people included the same person is one person, written once.
    const full = renderHtml(build(tree, oz.id, 6, { ...privacy, includeLiving: true }).model);
    expect(rowOf(full, 8)).toContain('Gus Secretname');
    expect(rowOf(full, 12)).toContain('Gus Secretname, see 8');
    expect(rowOf(full, 24)).toBe('');
  });

  it('counts the places that say "Living", so that a repeated living person is not told by the count', () => {
    const { tree, dead } = lineage();
    // Gus is living and is the grandfather of both Mo and Ned, who are the parents of Oz.
    const gus = createPerson(tree, { living: true, name: { given: 'Gus', surname: 'Secretname' } });
    const grandparents = createFamily(tree, { partner1Id: gus.id, partner2Id: null });
    const kai = dead('Kai', 'Grand');
    const lou = dead('Lou', 'Grand');
    addChild(tree, grandparents.id, kai.id);
    addChild(tree, grandparents.id, lou.id);
    const mo = dead('Mo', 'Cousin');
    const ned = dead('Ned', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: kai.id, partner2Id: null }).id, mo.id);
    addChild(tree, createFamily(tree, { partner1Id: lou.id, partner2Id: null }).id, ned.id);
    const oz = dead('Oz', 'Cousin');
    addChild(tree, createFamily(tree, { partner1Id: mo.id, partner2Id: ned.id }).id, oz.id);
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };

    const list = buildReport(
      tree,
      { kind: 'ahnentafel', personId: oz.id, generations: 4 },
      privacy,
    );
    const page = renderHtml(list.model);
    expect(page.match(/<td><span class="person living">Living<\/span><\/td>/g)).toHaveLength(2);
    expect(list.livingOmitted).toBe(2);
    expect(page).toContain('2 entries are shown only as &quot;Living&quot;');
    expect(page).not.toContain('1 person');

    for (const kind of ['chart-pedigree', 'chart-hourglass', 'chart-fan'] as const) {
      const chart = buildReport(tree, { kind, personId: oz.id, generations: 4 }, privacy);
      const drawn = renderHtml(chart.model).match(/>Living<\/(?:text|tspan)>/g);
      expect(drawn, kind).toHaveLength(2);
      expect(chart.livingOmitted, kind).toBe(2);
    }
  });

  it('refuses the Ahnentafel of a living person unless living people are included', () => {
    const { tree } = lineage();
    const ann = createPerson(tree, { living: true, name: { given: 'Odile', surname: 'Now' } });
    const living = presumedLivingIds(tree);
    expect(() => build(tree, ann.id, 4, { livingIds: living, includeLiving: false })).toThrow(
      ReportRefusedError,
    );
    expect(build(tree, ann.id, 4, { livingIds: living, includeLiving: true }).model.title).toBe(
      'Ahnentafel: Odile Now',
    );
  });

  it('keeps to the generations allowed and to people who exist', () => {
    const { tree, dead } = lineage();
    const pat = dead('Pat', 'Marsh');
    for (const generations of [0, 1, 11, 2.5, Number.NaN]) {
      expect(() => build(tree, pat.id, generations), String(generations)).toThrow(
        ReportRefusedError,
      );
    }
    expect(() => build(tree, pat.id, 10)).not.toThrow();
    expect(() => build(tree, '00000000-0000-7000-8000-000000000000', 4)).toThrow(NotFoundError);
  });
});

describe('the charts', () => {
  const CHARTS = ['chart-pedigree', 'chart-descendants', 'chart-hourglass', 'chart-fan'] as const;
  const build = (
    tree: Tree,
    kind: (typeof CHARTS)[number],
    personId: string,
    generations: number,
    privacy: ReportPrivacy = OFF,
  ) => buildReport(tree, { kind, personId, generations }, privacy);
  const svgOf = (built: ReportBuild): string => {
    const html = renderHtml(built.model);
    const drawings = drawingsOf(html);
    expect(drawings).toHaveLength(1);
    return drawings[0] ?? '';
  };

  /** Pat, with parents Hal and Eve, a partner Una and a child Kit. */
  function family() {
    const { tree, dead } = lineage();
    const pat = dead('Pat', 'Marsh', { birth: '1880' });
    const hal = dead('Hal', 'Marsh', { birth: '1850' });
    const eve = dead('Eve', 'Fallow');
    const una = dead('Una', 'Cole');
    const kit = dead('Kit', 'Marsh', { birth: '1905' });
    addChild(tree, createFamily(tree, { partner1Id: hal.id, partner2Id: eve.id }).id, pat.id);
    addChild(tree, createFamily(tree, { partner1Id: pat.id, partner2Id: una.id }).id, kit.id);
    return { tree, dead, pat, hal, eve, una, kit };
  }

  it('draws each chart whole as one drawing of plain shapes, named from its person', () => {
    const { tree, pat } = family();
    const expected: Record<(typeof CHARTS)[number], { title: string; names: string[] }> = {
      'chart-pedigree': {
        title: 'Ancestor chart: Pat Marsh',
        names: ['Pat Marsh', 'Hal Marsh', 'Eve Fallow'],
      },
      'chart-descendants': {
        title: 'Descendant chart: Pat Marsh',
        names: ['Pat Marsh', 'Una Cole', 'Kit Marsh'],
      },
      'chart-hourglass': {
        title: 'Hourglass chart: Pat Marsh',
        names: ['Pat Marsh', 'Hal Marsh', 'Eve Fallow', 'Una Cole', 'Kit Marsh'],
      },
      'chart-fan': {
        title: 'Fan chart: Pat Marsh',
        names: ['Pat Marsh', 'Hal Marsh', 'Eve Fallow'],
      },
    };
    for (const kind of CHARTS) {
      const built = build(tree, kind, pat.id, 3);
      expect(built.model.title).toBe(expected[kind].title);
      const svg = svgOf(built);
      expect(() => checkSvg(svg)).not.toThrow();
      for (const name of expected[kind].names) expect(svg, `${kind}: ${name}`).toContain(name);
      // Plain drawing: no id, no label that carries a person, no link.
      expect(svg).not.toMatch(/\b(?:id|data-[a-z]+|href|style)=/);
      expect(built.model.sections[0]?.blocks[0]).toMatchObject({ kind: 'svg', fitPage: true });
    }
    // One box for each person, drawn once.
    expect(svgOf(build(tree, 'chart-pedigree', pat.id, 3)).match(/<rect /g)).toHaveLength(3);
    expect(svgOf(build(tree, 'chart-descendants', pat.id, 3)).match(/<rect /g)).toHaveLength(3);
    expect(svgOf(build(tree, 'chart-hourglass', pat.id, 3)).match(/<rect /g)).toHaveLength(5);
    // A fan has a place for each ring of ancestors as far as any is recorded (two parents), and the person.
    expect(svgOf(build(tree, 'chart-fan', pat.id, 3)).match(/<path /g)).toHaveLength(2);
    expect(svgOf(build(tree, 'chart-fan', pat.id, 3)).match(/<circle /g)).toHaveLength(1);
  });

  it('turns the paper the way the chart fits best', () => {
    const { tree, pat } = family();
    expect(build(tree, 'chart-pedigree', pat.id, 4).model.orientation).toBe('landscape');
    expect(build(tree, 'chart-fan', pat.id, 4).model.orientation).toBe('landscape');
  });

  it('says that a person has more behind them only for people who are shown', () => {
    const { tree, dead } = lineage();
    const root = dead('Pat', 'Marsh');
    const living = createPerson(tree, { living: true, name: { given: 'Liv', surname: 'Secret' } });
    const shown = dead('Hal', 'Marsh');
    const above = dead('Abe', 'Marsh');
    addChild(tree, createFamily(tree, { partner1Id: living.id, partner2Id: shown.id }).id, root.id);
    // Both parents have parents of their own, beyond the two generations drawn.
    addChild(tree, createFamily(tree, { partner1Id: above.id, partner2Id: null }).id, living.id);
    addChild(tree, createFamily(tree, { partner1Id: above.id, partner2Id: null }).id, shown.id);
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };
    const svg = svgOf(build(tree, 'chart-pedigree', root.id, 2, privacy));
    expect(svg).toContain('Living');
    expect(svg).not.toMatch(/Liv\b|Secret/);
    // Only the dead parent is said to have more behind him.
    expect(svg.match(/more…/g)).toHaveLength(1);
    const full = svgOf(
      build(tree, 'chart-pedigree', root.id, 2, { ...privacy, includeLiving: true }),
    );
    expect(full).toContain('Liv Secret');
    expect(full.match(/more…/g)).toHaveLength(2);
  });

  it('draws a name with markup in it as text', () => {
    const { tree, dead } = lineage();
    const nasty = dead('A & <b>"x"</b> \'y\'', `Z${String.fromCharCode(7)}`);
    for (const kind of CHARTS) {
      const svg = svgOf(build(tree, kind, nasty.id, 3));
      expect(svg, kind).not.toContain('<b>');
      expect(svg, kind).toContain('A &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt; &#39;y&#39;');
      expect(() => checkSvg(svg)).not.toThrow();
    }
  });

  it('refuses a chart too big to read on one page, and one of a living person', () => {
    const { tree, dead } = lineage();
    const root = dead('Pat', 'Marsh');
    const wife = dead('Una', 'Cole');
    const own = createFamily(tree, { partner1Id: root.id, partner2Id: wife.id });
    for (let index = 0; index < 8; index += 1) {
      addChild(tree, own.id, dead(`Kid${index}`, 'Marsh').id);
    }
    expect(() => build(tree, 'chart-descendants', root.id, 3)).not.toThrow();
    for (let index = 8; index < 40; index += 1) {
      addChild(tree, own.id, dead(`Kid${index}`, 'Marsh').id);
    }
    expect(() => build(tree, 'chart-descendants', root.id, 3)).toThrow(/too big to print/);
    // One generation fewer is still the same children, so it is still too big.
    expect(() => build(tree, 'chart-descendants', root.id, 2)).toThrow(ReportRefusedError);

    const ann = createPerson(tree, { living: true, name: { given: 'Odile', surname: 'Now' } });
    const privacy = { livingIds: presumedLivingIds(tree), includeLiving: false };
    for (const kind of CHARTS) {
      expect(() => build(tree, kind, ann.id, 3, privacy), kind).toThrow(/may be living/);
      expect(
        build(tree, kind, ann.id, 3, { ...privacy, includeLiving: true }).model.title,
      ).toContain('Odile Now');
    }
  });

  it('refuses a descendant chart that was cut off at the most people a chart holds', () => {
    const { tree, dead } = lineage();
    const root = dead('Pat', 'Marsh');
    const own = createFamily(tree, { partner1Id: root.id, partner2Id: null });
    for (let index = 0; index < 1001; index += 1) {
      addChild(tree, own.id, dead(`Kid${index}`, 'Marsh').id);
    }
    expect(() => build(tree, 'chart-descendants', root.id, 2)).toThrow(
      /too large to show whole.*fewer generations/,
    );
    expect(() => build(tree, 'chart-hourglass', root.id, 2)).toThrow(ReportRefusedError);
  });

  it('keeps to the generations each chart allows', () => {
    const { tree, pat } = family();
    for (const kind of CHARTS) {
      const { min, max } = REPORT_GENERATIONS[kind];
      expect(() => build(tree, kind, pat.id, min - 1), kind).toThrow(ReportRefusedError);
      expect(() => build(tree, kind, pat.id, max + 1), kind).toThrow(ReportRefusedError);
      // The most each chart allows is drawn, for a small family.
      expect(() => build(tree, kind, pat.id, max), kind).not.toThrow();
    }
    expect(() => build(tree, 'chart-pedigree', '00000000-0000-7000-8000-000000000000', 3)).toThrow(
      NotFoundError,
    );
  });

  it('draws a full pedigree of the most generations allowed at a size that can be read', () => {
    const { tree, dead } = lineage();
    const max = REPORT_GENERATIONS['chart-pedigree'].max;
    // Everyone has two parents for the whole pedigree.
    const root = dead('Root', 'Full');
    let level = [root.id];
    for (let generation = 1; generation < max; generation += 1) {
      const next: string[] = [];
      for (const childId of level) {
        const father = dead(`F${next.length}`, `G${generation}`);
        const mother = dead(`M${next.length}`, `G${generation}`);
        const parents = createFamily(tree, { partner1Id: father.id, partner2Id: mother.id });
        addChild(tree, parents.id, childId);
        next.push(father.id, mother.id);
      }
      level = next;
    }
    const svg = svgOf(build(tree, 'chart-pedigree', root.id, max));
    expect(svg.match(/<rect /g)).toHaveLength(2 ** max - 1);
  });
});
