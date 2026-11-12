import { describe, expect, it } from 'vitest';
import { addPersonEvent } from './events';
import { addName, createPerson, deleteName, deletePerson, listNames, updateName } from './persons';
import { getPersonSummary, listPersons, searchPersons, toFtsQuery } from './search';
import { cleanUpAfterEach, memoryTree } from './testing';
import type { Tree } from './tree';

cleanUpAfterEach();

function people(tree: Tree) {
  const johann = createPerson(tree, { sex: 'M', name: { given: 'Johann', surname: 'Müller' } });
  const zoe = createPerson(tree, { sex: 'F', name: { given: 'Zoë', surname: 'Brontë' } });
  const john = createPerson(tree, { sex: 'M', name: { given: 'John', surname: 'Smith' } });
  const mary = createPerson(tree, { sex: 'F', name: { given: 'Mary Ann', surname: 'Smith' } });
  const obrien = createPerson(tree, { name: { given: 'Seán', surname: "O'Brien" } });
  return { johann, zoe, john, mary, obrien };
}

const found = (tree: Tree, query: string) =>
  searchPersons(tree, query).map((p) => `${p.name?.given} ${p.name?.surname}`);

describe('toFtsQuery', () => {
  it('quotes each word and matches on word beginnings', () => {
    expect(toFtsQuery('joh smi')).toBe('"joh"* "smi"*');
    expect(toFtsQuery("  O'Brien, Seán ")).toBe('"O"* "Brien"* "Seán"*');
    expect(toFtsQuery('')).toBe('');
    expect(toFtsQuery(' ,;- ')).toBe('');
  });
});

describe('searchPersons', () => {
  it('ignores case and accents', () => {
    const tree = memoryTree();
    people(tree);
    expect(found(tree, 'muller')).toEqual(['Johann Müller']);
    expect(found(tree, 'MÜLLER')).toEqual(['Johann Müller']);
    expect(found(tree, 'bronte zoe')).toEqual(['Zoë Brontë']);
    expect(found(tree, 'sean obrien')).toEqual([]);
    expect(found(tree, "sean o'brien")).toEqual(["Seán O'Brien"]);
  });

  it('needs every word and matches while a word is still being typed', () => {
    const tree = memoryTree();
    people(tree);
    expect(found(tree, 'smith').sort()).toEqual(['John Smith', 'Mary Ann Smith']);
    expect(found(tree, 'joh')).toEqual(['Johann Müller', 'John Smith']);
    expect(found(tree, 'joh smi')).toEqual(['John Smith']);
    expect(found(tree, 'smith ann mary')).toEqual(['Mary Ann Smith']);
    expect(found(tree, 'schmidt')).toEqual([]);
    expect(found(tree, '   ')).toEqual([]);
  });

  it('treats search syntax typed by the user as plain words', () => {
    const tree = memoryTree();
    people(tree);
    for (const query of [
      '"smith',
      'smith OR',
      'NOT smith',
      'smith*',
      'text:smith',
      '(smith',
      'a AND',
    ]) {
      expect(() => searchPersons(tree, query), query).not.toThrow();
    }
    expect(found(tree, 'smith OR muller')).toEqual([]);
    expect(found(tree, '"john" (smith)')).toEqual(['John Smith']);
  });

  it('finds a person by any of their names and lists them once', () => {
    const tree = memoryTree();
    const { mary } = people(tree);
    addName(tree, mary.id, { type: 'married', given: 'Mary Ann', surname: 'Cross' });
    addName(tree, mary.id, { type: 'aka', given: 'Polly', nickname: 'Mary' });

    expect(found(tree, 'cross')).toEqual(['Mary Ann Smith']);
    expect(found(tree, 'polly')).toEqual(['Mary Ann Smith']);
    // "mary" matches all three of her names.
    expect(found(tree, 'mary')).toEqual(['Mary Ann Smith']);
  });

  it('follows edits and deletions', () => {
    const tree = memoryTree();
    const { john, mary } = people(tree);
    const [name] = listNames(tree, john.id);

    updateName(tree, name!.id, { surname: 'Smythe' });
    expect(found(tree, 'smythe')).toEqual(['John Smythe']);
    expect(found(tree, 'smith')).toEqual(['Mary Ann Smith']);

    const alias = addName(tree, john.id, { type: 'aka', given: 'Jack' });
    expect(found(tree, 'jack')).toEqual(['John Smythe']);
    deleteName(tree, alias.id);
    expect(found(tree, 'jack')).toEqual([]);

    deletePerson(tree, mary.id);
    expect(found(tree, 'smith')).toEqual([]);
    expect(tree.db.prepare('SELECT count(*) FROM search_doc').pluck().get()).toBe(4);
    expect(tree.db.prepare('SELECT count(*) FROM search_fts').pluck().get()).toBe(4);
  });

  it('returns results a page at a time', () => {
    const tree = memoryTree();
    tree.transact('Add many', () => {
      for (let i = 0; i < 25; i++) {
        createPerson(tree, {
          name: { given: `Child${String(i).padStart(2, '0')}`, surname: 'Large' },
        });
      }
    });
    const firstPage = searchPersons(tree, 'large', { limit: 10 });
    const secondPage = searchPersons(tree, 'large', { limit: 10, offset: 10 });
    const lastPage = searchPersons(tree, 'large', { limit: 10, offset: 20 });
    expect([firstPage.length, secondPage.length, lastPage.length]).toEqual([10, 10, 5]);
    const ids = [...firstPage, ...secondPage, ...lastPage].map((p) => p.id);
    expect(new Set(ids).size).toBe(25);
  });
});

describe('listPersons', () => {
  it('sorts by surname then given name, with unnamed people last', () => {
    const tree = memoryTree();
    people(tree);
    createPerson(tree);
    createPerson(tree, { name: { given: 'adam', surname: 'smith' } });

    expect(
      listPersons(tree).map((p) => (p.name ? `${p.name.surname}, ${p.name.given}` : null)),
    ).toEqual([
      'Brontë, Zoë',
      'Müller, Johann',
      "O'Brien, Seán",
      'smith, adam',
      'Smith, John',
      'Smith, Mary Ann',
      null,
    ]);
    expect(listPersons(tree, { limit: 2, offset: 5 })).toHaveLength(2);
  });

  it('shows the primary name and the first birth and death', () => {
    const tree = memoryTree();
    const person = createPerson(tree, {
      sex: 'F',
      living: false,
      name: { given: 'Mary', surname: 'Evans' },
    });
    addName(tree, person.id, { type: 'married', given: 'Mary', surname: 'Cross', primary: true });
    addPersonEvent(tree, person.id, { type: 'residence', date: '1851', place: 'Coventry' });
    addPersonEvent(tree, person.id, { type: 'birth', date: '22 Nov 1819', place: 'Nuneaton' });
    addPersonEvent(tree, person.id, { type: 'birth', date: '1820', place: 'Warwickshire' });
    addPersonEvent(tree, person.id, { type: 'death', date: '22 Dec 1880', place: 'London' });

    expect(getPersonSummary(tree, person.id)).toEqual({
      id: person.id,
      sex: 'F',
      living: false,
      name: { prefix: '', given: 'Mary', nickname: '', surname: 'Cross', suffix: '' },
      birth: { dateText: '22 Nov 1819', placeText: 'Nuneaton' },
      death: { dateText: '22 Dec 1880', placeText: 'London' },
    });

    const bare = createPerson(tree);
    expect(getPersonSummary(tree, bare.id)).toEqual({
      id: bare.id,
      sex: 'U',
      living: null,
      name: null,
      birth: null,
      death: null,
    });
    expect(getPersonSummary(tree, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });
});
