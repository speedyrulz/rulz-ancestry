import { describe, expect, it } from 'vitest';
import { addPersonEvent, getEvent } from './events';
import { addChild, createFamily, getFamily, listChildren } from './families';
import {
  addName,
  countPersons,
  createPerson,
  deleteName,
  deletePerson,
  getPerson,
  listNames,
  setPrimaryName,
  updateName,
  updatePerson,
} from './persons';
import { cleanUpAfterEach, memoryTree, undoDepth } from './testing';
import { NotFoundError, TreeRuleError } from './tree';

cleanUpAfterEach();

const MISSING = '00000000-0000-7000-8000-000000000000';

describe('persons', () => {
  it('creates a person with defaults', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    expect(person).toMatchObject({ sex: 'U', living: null });
    expect(person.createdAt).toBe(person.updatedAt);
    expect(getPerson(tree, person.id)).toEqual(person);
    expect(listNames(tree, person.id)).toEqual([]);
  });

  it('stores sex and the three states of living', () => {
    const tree = memoryTree();
    expect(createPerson(tree, { sex: 'F', living: true })).toMatchObject({
      sex: 'F',
      living: true,
    });
    expect(createPerson(tree, { living: false }).living).toBe(false);
    expect(createPerson(tree, { living: null }).living).toBeNull();
    expect(() => createPerson(tree, { sex: 'Q' as never })).toThrow(TreeRuleError);
    expect(countPersons(tree)).toBe(3);
  });

  it('edits a person, and an edit that changes nothing is not an undo step', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { sex: 'M', living: true });
    const depth = undoDepth(tree);

    expect(updatePerson(tree, person.id, { sex: 'M' })).toEqual(person);
    expect(undoDepth(tree)).toBe(depth);

    const edited = updatePerson(tree, person.id, { living: null });
    expect(edited).toMatchObject({ sex: 'M', living: null });
    expect(undoDepth(tree)).toBe(depth + 1);
  });

  it('reports a person that does not exist', () => {
    const tree = memoryTree();
    expect(getPerson(tree, MISSING)).toBeNull();
    expect(() => updatePerson(tree, MISSING, { sex: 'F' })).toThrow(NotFoundError);
    expect(() => deletePerson(tree, MISSING)).toThrow(NotFoundError);
    expect(() => addName(tree, MISSING, { given: 'Nobody' })).toThrow(NotFoundError);
  });
});

describe('names', () => {
  it('makes the first name primary and tidies spacing', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { name: { given: '  Mary   Ann ', surname: 'Evans' } });
    expect(listNames(tree, person.id)).toMatchObject([
      { given: 'Mary Ann', surname: 'Evans', type: 'birth', isPrimary: true, sortOrder: 0 },
    ]);
  });

  it('keeps one primary name per person', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { name: { given: 'Mary Ann', surname: 'Evans' } });
    const pen = addName(tree, person.id, { type: 'aka', given: 'George', surname: 'Eliot' });
    const married = addName(tree, person.id, {
      type: 'married',
      given: 'Mary Ann',
      surname: 'Cross',
      primary: true,
    });

    expect(pen.isPrimary).toBe(false);
    expect(married.isPrimary).toBe(true);
    expect(listNames(tree, person.id).map((n) => [n.surname, n.isPrimary])).toEqual([
      ['Cross', true],
      ['Evans', false],
      ['Eliot', false],
    ]);

    setPrimaryName(tree, pen.id);
    expect(
      listNames(tree, person.id)
        .filter((n) => n.isPrimary)
        .map((n) => n.surname),
    ).toEqual(['Eliot']);
  });

  it('edits only the parts that are given', () => {
    const tree = memoryTree();
    const person = createPerson(tree, {
      name: { prefix: 'Dr.', given: 'John', surname: 'Smith', suffix: 'Jr.' },
    });
    const [name] = listNames(tree, person.id);
    const edited = updateName(tree, name!.id, { given: 'Jon', suffix: '' });
    expect(edited).toMatchObject({ prefix: 'Dr.', given: 'Jon', surname: 'Smith', suffix: '' });
    expect(() => updateName(tree, name!.id, { type: 'stage' as never })).toThrow(TreeRuleError);
    expect(() => updateName(tree, MISSING, { given: 'x' })).toThrow(NotFoundError);
  });

  it('promotes the next name when the primary one is deleted', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { name: { given: 'First' } });
    addName(tree, person.id, { given: 'Second' });
    addName(tree, person.id, { given: 'Third' });
    const [primary] = listNames(tree, person.id);

    deleteName(tree, primary!.id);
    expect(listNames(tree, person.id).map((n) => [n.given, n.isPrimary])).toEqual([
      ['Second', true],
      ['Third', false],
    ]);
  });
});

describe('deletePerson', () => {
  it('removes the person with their names and events', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { name: { given: 'Gone' } });
    const birth = addPersonEvent(tree, person.id, { type: 'birth', date: '1900' });
    const other = createPerson(tree, { name: { given: 'Stays' } });
    const otherBirth = addPersonEvent(tree, other.id, { type: 'birth', date: '1901' });

    deletePerson(tree, person.id);

    expect(getPerson(tree, person.id)).toBeNull();
    expect(listNames(tree, person.id)).toEqual([]);
    expect(getEvent(tree, birth.id)).toBeNull();
    expect(getPerson(tree, other.id)).not.toBeNull();
    expect(getEvent(tree, otherBirth.id)).not.toBeNull();
    for (const table of ['person_name', 'event', 'event_participant']) {
      expect(tree.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), table).toBe(1);
    }
  });

  it('keeps a family that still has someone in it, and removes one that is empty', () => {
    const tree = memoryTree();
    const father = createPerson(tree);
    const mother = createPerson(tree);
    const child = createPerson(tree);
    const family = createFamily(tree, { partner1Id: father.id, partner2Id: mother.id });
    addChild(tree, family.id, child.id);
    const lonely = createFamily(tree, { partner1Id: father.id });

    deletePerson(tree, father.id);
    expect(getFamily(tree, family.id)).toMatchObject({ partner1Id: null, partner2Id: mother.id });
    expect(getFamily(tree, lonely.id)).toBeNull();

    deletePerson(tree, mother.id);
    // Still holds the child, so brothers and sisters added later stay linked.
    expect(getFamily(tree, family.id)).toMatchObject({ partner1Id: null, partner2Id: null });
    expect(listChildren(tree, family.id)).toHaveLength(1);

    deletePerson(tree, child.id);
    expect(getFamily(tree, family.id)).toBeNull();
    expect(tree.info()).toMatchObject({ persons: 0, families: 0, events: 0 });
  });
});
