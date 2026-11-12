import { describe, expect, it } from 'vitest';
import type { Sex } from '@rulz/core';
import { addChildOf, addParent, addPartner, addPersonFromDraft, type PersonDraft } from './actions';
import { markNotDuplicate } from './duplicates';
import { addFamilyEvent, addPersonEvent, listFamilyEvents, listPersonEvents } from './events';
import {
  getChildIds,
  getParents,
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
} from './families';
import { keptLinesOf } from './gedcom/store';
import { exportLines, file, importText, recordOf } from './gedcom/testing';
import { mergeObstacle, mergePersons, mergedInto } from './merge';
import { addName, createPerson, deletePerson, getPerson, listNames, updatePerson } from './persons';
import { searchPersons } from './search';
import { listPersonCitations } from './sources';
import { cleanUpAfterEach, memoryTree, snapshot } from './testing';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

cleanUpAfterEach();

function add(tree: Tree, given: string, surname = 'Wood', extra: PersonDraft = {}): string {
  return addPersonFromDraft(tree, { given, surname, ...extra }).id;
}

function parentOf(tree: Tree, childId: string, given: string, sex: Sex): string {
  return addParent(tree, childId, { create: { given, surname: 'Wood', sex } }).personId;
}

const eventsOf = (tree: Tree, personId: string) =>
  listPersonEvents(tree, personId).map((event) =>
    [event.type, event.dateText, event.placeText].join('/'),
  );

describe('mergePersons', () => {
  it('moves names and events to the person kept, dropping exact repeats', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Eliza', 'Wood', { birthDate: '1840', birthPlace: 'York' });
    const other = add(tree, 'Eliza', 'Wood', {
      birthDate: '1840',
      birthPlace: 'York',
      deathDate: '1901',
    });
    addName(tree, other, { given: 'Elizabeth', surname: 'Wood' });
    addName(tree, other, { given: 'Eliza', surname: 'Marsh', type: 'married' });
    addPersonEvent(tree, other, { type: 'birth', date: '2 Jan 1840', place: 'York' });

    const result = mergePersons(tree, keep, other);
    expect(result).toEqual({ personId: keep, names: 2, events: 2, families: 0 });
    expect(getPerson(tree, other)).toBeNull();
    expect(listNames(tree, keep).map((name) => [name.given, name.surname, name.isPrimary])).toEqual(
      [
        ['Eliza', 'Wood', true],
        ['Elizabeth', 'Wood', false],
        ['Eliza', 'Marsh', false],
      ],
    );
    expect(eventsOf(tree, keep)).toEqual([
      'birth/1840/York',
      'death/1901/',
      'birth/2 Jan 1840/York',
    ]);
    // Nothing of the merged record is left behind.
    expect(
      tree.db.prepare('SELECT count(*) FROM person_name WHERE person_id = ?').pluck().get(other),
    ).toBe(0);
    expect(tree.db.prepare('SELECT count(*) FROM event').pluck().get()).toBe(3);
    expect(tree.undoStatus().undo?.label).toBe('Merge people');
  });

  it('keeps what the person kept says of sex and living, and fills in what it leaves open', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Sam');
    const other = add(tree, 'Sam', 'Wood', { sex: 'M', living: true });
    mergePersons(tree, keep, other);
    expect(getPerson(tree, keep)).toMatchObject({ sex: 'M', living: true });

    const stated = add(tree, 'Pat', 'Wood', { sex: 'F', living: true });
    const dead = add(tree, 'Pat', 'Wood', { sex: 'M', living: false });
    mergePersons(tree, stated, dead);
    expect(getPerson(tree, stated)).toMatchObject({ sex: 'F', living: false });
  });

  it('gives a person with no name the main name of the other', () => {
    const tree = memoryTree();
    const keep = createPerson(tree).id;
    const other = add(tree, 'Named', 'Wood');
    addName(tree, other, { given: 'Also', surname: 'Wood' });
    mergePersons(tree, keep, other);
    expect(listNames(tree, keep).map((name) => [name.given, name.isPrimary])).toEqual([
      ['Named', true],
      ['Also', false],
    ]);
  });

  it('is found by the names that came over, and the merged record is not', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Margaret', 'Wood');
    const other = add(tree, 'Peggy', 'Wood');
    mergePersons(tree, keep, other);
    expect(searchPersons(tree, 'peggy').map((person) => person.id)).toEqual([keep]);
    expect(searchPersons(tree, 'wood')).toHaveLength(1);
  });

  it('gives the person kept the parents of both records', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Jo');
    const other = add(tree, 'Jo');
    const father = parentOf(tree, keep, 'Abel', 'M');
    const otherFather = parentOf(tree, other, 'Abel', 'M');
    mergePersons(tree, keep, other);
    expect(
      getParents(tree, keep)
        .map((link) => link.parentId)
        .sort(),
    ).toEqual([father, otherFather].sort());
    expect(listFamiliesAsChild(tree, keep)).toHaveLength(2);
  });

  it('leaves one link when both records are children of the same family', () => {
    const tree = memoryTree();
    const father = add(tree, 'Abel', 'Wood', { sex: 'M' });
    const keep = addChildOf(tree, father, { create: { given: 'Jo', surname: 'Wood' } });
    const other = addChildOf(tree, father, { create: { given: 'Jo', surname: 'Wood' } });
    mergePersons(tree, keep.personId, other.personId);
    expect(listChildren(tree, keep.familyId).map((child) => child.childId)).toEqual([
      keep.personId,
    ]);
    expect(getChildIds(tree, father)).toEqual([keep.personId]);
  });

  it('takes over the partners and children of the other record', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Ned', 'Wood', { sex: 'M' });
    const other = add(tree, 'Ned', 'Wood', { sex: 'M' });
    const wife = addPartner(tree, other, { create: { given: 'Ivy', surname: 'Wood', sex: 'F' } });
    const child = addChildOf(
      tree,
      other,
      { create: { given: 'Kit', surname: 'Wood' } },
      { familyId: wife.familyId },
    );
    addFamilyEvent(tree, wife.familyId, { type: 'marriage', date: '1870' });

    mergePersons(tree, keep, other);
    const families = listFamiliesAsPartner(tree, keep);
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({
      id: wife.familyId,
      partner1Id: keep,
      partner2Id: wife.personId,
    });
    expect(getChildIds(tree, keep)).toEqual([child.personId]);
    expect(listFamilyEvents(tree, wife.familyId)).toHaveLength(1);
  });

  it('joins two families that end up with the same two partners', () => {
    const tree = memoryTree();
    // The same couple entered twice, each time with children and a marriage.
    const husband = add(tree, 'Ned', 'Wood', { sex: 'M' });
    const wife = addPartner(tree, husband, { create: { given: 'Ivy', surname: 'Wood', sex: 'F' } });
    const kit = addChildOf(
      tree,
      husband,
      { create: { given: 'Kit', surname: 'Wood' } },
      { familyId: wife.familyId },
    );
    addFamilyEvent(tree, wife.familyId, { type: 'marriage', date: '1870', place: 'Hull' });

    const husband2 = add(tree, 'Ned', 'Wood', { sex: 'M' });
    const wife2 = addPartner(tree, husband2, {
      create: { given: 'Ivy', surname: 'Wood', sex: 'F' },
    });
    const lou = addChildOf(
      tree,
      husband2,
      { create: { given: 'Lou', surname: 'Wood' } },
      { familyId: wife2.familyId },
    );
    addFamilyEvent(tree, wife2.familyId, { type: 'marriage', date: '1870', place: 'Hull' });
    addFamilyEvent(tree, wife2.familyId, { type: 'divorce', date: '1880' });

    // After the husbands are merged there are still two families: the wives differ.
    expect(mergePersons(tree, husband, husband2).families).toBe(0);
    expect(listFamiliesAsPartner(tree, husband)).toHaveLength(2);

    // Merging the wives makes the two families one.
    expect(mergePersons(tree, wife.personId, wife2.personId).families).toBe(1);
    const families = listFamiliesAsPartner(tree, husband);
    expect(families.map((family) => family.id)).toEqual([wife.familyId]);
    expect(listChildren(tree, wife.familyId).map((child) => child.childId)).toEqual([
      kit.personId,
      lou.personId,
    ]);
    expect(listFamilyEvents(tree, wife.familyId).map((event) => event.type)).toEqual([
      'marriage',
      'divorce',
    ]);
    expect(mergedInto(tree, wife.familyId)).toEqual([wife2.familyId]);
    expect(tree.db.prepare('SELECT count(*) FROM family').pluck().get()).toBe(1);
    expect(
      tree.db.prepare('SELECT count(*) FROM event WHERE type = ?').pluck().get('marriage'),
    ).toBe(1);
  });

  it('joins the parents of a merged child once both parents are merged too', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Jo');
    const other = add(tree, 'Jo');
    const father = parentOf(tree, keep, 'Abel', 'M');
    const mother = parentOf(tree, keep, 'Bess', 'F');
    const father2 = parentOf(tree, other, 'Abel', 'M');
    const mother2 = parentOf(tree, other, 'Bess', 'F');
    mergePersons(tree, keep, other);
    mergePersons(tree, father, father2);
    expect(listFamiliesAsChild(tree, keep)).toHaveLength(2);
    mergePersons(tree, mother, mother2);
    expect(listFamiliesAsChild(tree, keep)).toHaveLength(1);
    expect(getParents(tree, keep).map((link) => link.parentId)).toEqual([father, mother]);
    expect(tree.db.prepare('SELECT count(*) FROM person').pluck().get()).toBe(3);
    expect(tree.db.prepare('SELECT count(*) FROM family').pluck().get()).toBe(1);
  });

  it('refuses a merge that would make a person their own ancestor or their own partner', () => {
    const tree = memoryTree();
    const child = add(tree, 'Al');
    const father = parentOf(tree, child, 'Al', 'M');
    const grandfather = parentOf(tree, father, 'Al', 'M');
    const partner = addPartner(tree, child, { create: { given: 'Al', surname: 'Wood' } }).personId;
    const before = snapshot(tree);

    expect(() => mergePersons(tree, child, child)).toThrow(TreeRuleError);
    expect(() => mergePersons(tree, child, father)).toThrow(/ancestor or descendant/);
    expect(() => mergePersons(tree, grandfather, child)).toThrow(/ancestor or descendant/);
    expect(() => mergePersons(tree, child, partner)).toThrow(/partners of each other/);
    expect(mergeObstacle(tree, child, grandfather)).toMatch(/ancestor/);
    expect(mergeObstacle(tree, father, partner)).toBeNull();
    expect(() => mergePersons(tree, child, '00000000-0000-7000-8000-000000000000')).toThrow(
      NotFoundError,
    );
    expect(snapshot(tree)).toBe(before);
  });

  it('is one undo step that puts everything back, and can be redone', () => {
    const tree = memoryTree();
    const keep = add(tree, 'Ned', 'Wood', { sex: 'M', birthDate: '1840' });
    const wife = addPartner(tree, keep, { create: { given: 'Ivy', surname: 'Wood', sex: 'F' } });
    addChildOf(
      tree,
      keep,
      { create: { given: 'Kit', surname: 'Wood' } },
      { familyId: wife.familyId },
    );
    parentOf(tree, keep, 'Abel', 'M');

    const other = add(tree, 'Edward', 'Wood', { sex: 'M', birthDate: '1840', deathDate: '1900' });
    addPartner(tree, other, { existingId: wife.personId });
    addChildOf(tree, other, { create: { given: 'Lou', surname: 'Wood' } });
    parentOf(tree, other, 'Abel', 'M');
    const bystander = add(tree, 'Ned', 'Wood');
    markNotDuplicate(tree, other, bystander);
    updatePerson(tree, other, { living: false });

    const before = snapshot(tree);
    mergePersons(tree, keep, other);
    const after = snapshot(tree);
    expect(after).not.toBe(before);
    expect(tree.db.prepare('SELECT count(*) FROM not_duplicate').pluck().get()).toBe(0);

    expect(tree.undo()?.label).toBe('Merge people');
    expect(snapshot(tree)).toBe(before);
    expect(searchPersons(tree, 'edward').map((person) => person.id)).toEqual([other]);
    expect(tree.redo()?.label).toBe('Merge people');
    expect(snapshot(tree)).toBe(after);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('remembers what was merged into whom, through a chain of merges', () => {
    const tree = memoryTree();
    const [a, b, c] = [add(tree, 'Ann'), add(tree, 'Ann'), add(tree, 'Ann')];
    mergePersons(tree, b, c);
    expect(mergedInto(tree, b)).toEqual([c]);
    mergePersons(tree, a, b);
    expect(mergedInto(tree, a).sort()).toEqual([b, c].sort());
    expect(mergedInto(tree, b)).toEqual([]);
  });
});

describe('merging people who came from a GEDCOM file', () => {
  const SOURCE = file(
    '5.5.1',
    '0 @I1@ INDI',
    '1 NAME Ann /Lee/',
    '1 SEX F',
    '1 BIRT',
    '2 DATE 1850',
    '1 NOTE First record of Ann',
    '1 FAMS @F1@',
    '0 @I2@ INDI',
    '1 NAME Ann /Lee/',
    '2 SOUR @S1@',
    '3 PAGE 12',
    '1 NAME Annie /Lee/',
    '1 SEX F',
    '1 BIRT',
    '2 DATE 1850',
    '1 DEAT',
    '2 DATE 1910',
    '2 SOUR @S1@',
    '1 NOTE Second record of Ann',
    '1 SOUR @S1@',
    '1 FAMC @F2@',
    '0 @I3@ INDI',
    '1 NAME Tom /Lee/',
    '1 SEX M',
    '1 FAMS @F1@',
    '0 @I4@ INDI',
    '1 NAME Sam /Lee/',
    '1 SEX M',
    '1 ASSO @I2@',
    '2 RELA Witness',
    '1 FAMS @F2@',
    '0 @F1@ FAM',
    '1 HUSB @I3@',
    '1 WIFE @I1@',
    '0 @F2@ FAM',
    '1 HUSB @I4@',
    '1 CHIL @I2@',
    '0 @S1@ SOUR',
    '1 TITL Parish register',
  );

  function imported(): { tree: Tree; id: (xref: string) => string } {
    const tree = memoryTree();
    importText(tree, SOURCE);
    const id = (xref: string) =>
      tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    return { tree, id };
  }

  it('writes one record with the lines of both, and points everything at it', () => {
    const { tree, id } = imported();
    const result = mergePersons(tree, id('I1'), id('I2'));
    // The second "Ann Lee" has a source under it, so it is not dropped as a
    // repeat. The second birth says nothing new and is.
    expect(result).toMatchObject({ names: 2, events: 1 });
    const lines = exportLines(tree);

    expect(recordOf(lines, '0 @I2@ INDI')).toEqual([]);
    expect(recordOf(lines, '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 NAME Ann /Lee/',
      '2 SOUR @S1@',
      '3 PAGE 12',
      '1 NAME Annie /Lee/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1850',
      '1 DEAT',
      '2 DATE 1910',
      '2 SOUR @S1@',
      '1 FAMC @F2@',
      '1 NOTE First record of Ann',
      '1 FAMS @F1@',
      '1 NOTE Second record of Ann',
      '1 SOUR @S1@',
    ]);
    // The line of Sam that pointed at the merged record points at the one that is left.
    expect(recordOf(lines, '0 @I4@ INDI')).toEqual([
      '0 @I4@ INDI',
      '1 NAME Sam /Lee/',
      '1 SEX M',
      '1 ASSO @I1@',
      '2 RELA Witness',
      '1 FAMS @F2@',
    ]);
    expect(recordOf(lines, '0 @F2@ FAM')).toEqual(['0 @F2@ FAM', '1 HUSB @I4@', '1 CHIL @I1@']);
    expect(lines.filter((line) => line.includes('@I2@'))).toEqual([]);
    expect(recordOf(lines, '0 @S1@ SOUR')).toEqual(['0 @S1@ SOUR', '1 TITL Parish register']);
  });

  it('shows the kept lines of both records on the person who is left', () => {
    const { tree, id } = imported();
    expect(keptLinesOf(tree, id('I1'))).toEqual(['1 NOTE First record of Ann']);
    mergePersons(tree, id('I1'), id('I2'));
    expect(keptLinesOf(tree, id('I1'))).toEqual([
      '1 NOTE First record of Ann',
      '1 NOTE Second record of Ann',
    ]);
  });

  it('moves the citations of the merged record to the person who is left', () => {
    const { tree, id } = imported();
    expect(listPersonCitations(tree, id('I1'))).toEqual([]);
    const before = listPersonCitations(tree, id('I2')).map((citation) => ({
      page: citation.page,
      uses: citation.uses.map((use) => use.type),
    }));
    // Two citations: the bare one supports the person and the death, the one with a page a name.
    expect(before).toEqual([
      { page: '', uses: ['person', 'event'] },
      { page: '12', uses: ['name'] },
    ]);

    mergePersons(tree, id('I1'), id('I2'));
    const after = listPersonCitations(tree, id('I1'));
    expect(after.map((citation) => citation.page)).toEqual(['', '12']);
    expect(after[0]?.uses).toContainEqual({ type: 'person', id: id('I1') });

    tree.undo();
    expect(listPersonCitations(tree, id('I1'))).toEqual([]);
    expect(listPersonCitations(tree, id('I2'))).toHaveLength(2);
  });

  it('gives the file back as it was once the merge is undone', () => {
    const { tree, id } = imported();
    const before = exportLines(tree);
    mergePersons(tree, id('I1'), id('I2'));
    expect(exportLines(tree)).not.toEqual(before);
    tree.undo();
    expect(exportLines(tree)).toEqual(before);
  });

  it('drops a line that points at a person deleted since the import', () => {
    const { tree, id } = imported();
    deletePerson(tree, id('I2'));
    const lines = exportLines(tree);
    expect(lines.filter((line) => line.includes('@I2@'))).toEqual([]);
    expect(recordOf(lines, '0 @I4@ INDI')).toEqual(['0 @I4@ INDI', '1 NAME Sam /Lee/', '1 SEX M']);
  });
});
