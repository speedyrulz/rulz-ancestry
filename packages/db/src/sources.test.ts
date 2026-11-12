import { describe, expect, it } from 'vitest';
import { addPartner, addPersonFromDraft } from './actions';
import { UNTRACKED_WRITE_MESSAGE } from './changelog';
import { addFamilyEvent, addPersonEvent, deleteEvent, listPersonEvents } from './events';
import { getPersonPage } from './personpage';
import { deleteName, deletePerson, listNames } from './persons';
import {
  addCitation,
  countSourceCitations,
  countSources,
  createSource,
  deleteCitation,
  deleteSource,
  getSource,
  linkCitation,
  listCitations,
  listCitationUses,
  listPersonCitations,
  listSourceCitations,
  listSources,
  unlinkCitation,
  updateCitation,
  updateSource,
  type CitationTarget,
} from './sources';
import { cleanUpAfterEach, memoryTree, snapshot, undoDepth } from './testing';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

cleanUpAfterEach();

const MISSING = '00000000-0000-7000-8000-000000000000';

function count(tree: Tree, table: 'source' | 'citation' | 'citation_link'): number {
  return tree.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
}

/** A tree with one person who has a birth, and one source. */
function start(): { tree: Tree; personId: string; birth: CitationTarget; sourceId: string } {
  const tree = memoryTree();
  const personId = addPersonFromDraft(tree, {
    given: 'John',
    surname: 'Hale',
    birthDate: '1870',
  }).id;
  const birthId = listPersonEvents(tree, personId)[0]?.id ?? '';
  const sourceId = createSource(tree, { title: 'Parish register' }).id;
  return { tree, personId, birth: { type: 'event', id: birthId }, sourceId };
}

describe('sources', () => {
  it('are stored trimmed, and need a title or a short title', () => {
    const tree = memoryTree();
    const source = createSource(tree, {
      title: '  1900 United States\n Federal Census ',
      author: ' Census Bureau ',
      publication: ' Washington\r\n1901 ',
    });
    expect(source).toMatchObject({
      title: '1900 United States Federal Census',
      author: 'Census Bureau',
      publication: 'Washington\n1901',
      abbreviation: '',
      text: '',
    });
    expect(getSource(tree, source.id)).toEqual(source);
    expect(tree.info().sources).toBe(1);

    expect(() => createSource(tree, { author: 'Nobody' })).toThrow(TreeRuleError);
    expect(createSource(tree, { abbreviation: 'Bible' }).abbreviation).toBe('Bible');
    expect(() => updateSource(tree, source.id, { title: ' ' })).toThrow(TreeRuleError);
  });

  it('are listed by title and found by title, author or short title', () => {
    const tree = memoryTree();
    createSource(tree, { title: 'Parish register of York', author: 'Church of England' });
    createSource(tree, { title: '1900 Census', author: 'Census Bureau' });
    createSource(tree, { abbreviation: 'Family bible' });
    createSource(tree, { title: '100% of a_b' });

    expect(listSources(tree).map((source) => source.title || source.abbreviation)).toEqual([
      '100% of a_b',
      '1900 Census',
      'Family bible',
      'Parish register of York',
    ]);
    expect(countSources(tree)).toBe(4);
    expect(listSources(tree, { query: 'census' }).map((source) => source.title)).toEqual([
      '1900 Census',
    ]);
    expect(listSources(tree, { query: 'church' })).toHaveLength(1);
    expect(listSources(tree, { query: 'BIBLE' })).toHaveLength(1);
    expect(countSources(tree, 'e')).toBe(3);
    // The signs a pattern gives meaning to are taken as typed.
    expect(listSources(tree, { query: '%' }).map((source) => source.title)).toEqual([
      '100% of a_b',
    ]);
    expect(listSources(tree, { query: 'a_b' })).toHaveLength(1);
    expect(listSources(tree, { query: '_' })).toHaveLength(1);
    expect(listSources(tree, { limit: 2, offset: 1 })).toHaveLength(2);
  });

  it('can be edited and deleted, and each step undone', () => {
    const tree = memoryTree();
    const source = createSource(tree, { title: 'Register' });
    const depth = undoDepth(tree);

    expect(updateSource(tree, source.id, { title: 'Register' })).toEqual(source);
    expect(undoDepth(tree)).toBe(depth);

    const edited = updateSource(tree, source.id, { author: 'The parish' });
    expect(edited).toMatchObject({ title: 'Register', author: 'The parish' });
    expect(tree.undoStatus().undo?.label).toBe('Edit source');

    deleteSource(tree, source.id);
    expect(getSource(tree, source.id)).toBeNull();
    tree.undo();
    expect(getSource(tree, source.id)).toMatchObject({ author: 'The parish' });
    tree.undo();
    expect(getSource(tree, source.id)?.author).toBe('');

    expect(() => updateSource(tree, MISSING, { title: 'x' })).toThrow(NotFoundError);
    expect(() => deleteSource(tree, MISSING)).toThrow(NotFoundError);
  });

  it('cannot be written outside a change', () => {
    const tree = memoryTree();
    expect(() =>
      tree.db
        .prepare("INSERT INTO source (id, title, created_at, updated_at) VALUES ('x', 'y', 0, 0)")
        .run(),
    ).toThrow(UNTRACKED_WRITE_MESSAGE);
  });
});

describe('citations', () => {
  it('link a place in a source to a fact', () => {
    const { tree, birth, sourceId } = start();
    const citation = addCitation(
      tree,
      birth,
      { sourceId },
      {
        page: ' p.  12 ',
        text: 'John, son of Tom',
        quality: 3,
        note: 'Hard to read',
      },
    );
    expect(citation).toMatchObject({
      sourceId,
      page: 'p. 12',
      text: 'John, son of Tom',
      quality: 3,
      note: 'Hard to read',
    });
    expect(listCitations(tree, birth)).toEqual([{ ...citation, sourceTitle: 'Parish register' }]);
    expect(listSources(tree)[0]?.citations).toBe(1);
    expect(countSourceCitations(tree, sourceId)).toBe(1);
    expect(tree.undoStatus().undo?.label).toBe('Add citation');
  });

  it('can make their source in the same step', () => {
    const { tree, birth } = start();
    const depth = undoDepth(tree);
    const citation = addCitation(tree, birth, { create: { title: 'Family bible' } }, { page: '1' });
    expect(getSource(tree, citation.sourceId)?.title).toBe('Family bible');
    expect(undoDepth(tree)).toBe(depth + 1);
    tree.undo();
    expect(count(tree, 'source')).toBe(1);
    expect(count(tree, 'citation')).toBe(0);
    // A source with no title is refused, and nothing is left behind.
    expect(() => addCitation(tree, birth, { create: {} })).toThrow(TreeRuleError);
    expect(count(tree, 'source')).toBe(1);
  });

  it('refuse a source or a fact that does not exist', () => {
    const { tree, birth, sourceId } = start();
    expect(() => addCitation(tree, birth, { sourceId: MISSING })).toThrow(NotFoundError);
    expect(() => addCitation(tree, { type: 'event', id: MISSING }, { sourceId })).toThrow(
      NotFoundError,
    );
    expect(() => addCitation(tree, { type: 'name', id: birth.id }, { sourceId })).toThrow(
      NotFoundError,
    );
    expect(count(tree, 'citation')).toBe(0);
  });

  it('are edited once for every fact they support', () => {
    const { tree, personId, birth, sourceId } = start();
    const citation = addCitation(tree, birth, { sourceId }, { page: 'p. 12' });
    const person: CitationTarget = { type: 'person', id: personId };
    linkCitation(tree, citation.id, person);
    const depth = undoDepth(tree);
    // Linking the same fact again changes nothing.
    linkCitation(tree, citation.id, person);
    expect(undoDepth(tree)).toBe(depth);
    expect(count(tree, 'citation_link')).toBe(2);

    updateCitation(tree, citation.id, { page: 'p. 13', quality: 1 });
    expect(listCitations(tree, birth)[0]).toMatchObject({ page: 'p. 13', quality: 1 });
    expect(listCitations(tree, person)[0]).toMatchObject({ page: 'p. 13', quality: 1 });
    // Null clears the quality; leaving it out keeps it.
    updateCitation(tree, citation.id, { note: 'n' });
    expect(listCitations(tree, birth)[0]?.quality).toBe(1);
    updateCitation(tree, citation.id, { quality: null });
    expect(listCitations(tree, birth)[0]?.quality).toBeNull();
  });

  it('go when the last fact they support is taken away', () => {
    const { tree, personId, birth, sourceId } = start();
    const citation = addCitation(tree, birth, { sourceId }, { page: 'p. 12' });
    const person: CitationTarget = { type: 'person', id: personId };
    linkCitation(tree, citation.id, person);
    const both = snapshot(tree);

    unlinkCitation(tree, citation.id, birth);
    expect(listCitations(tree, birth)).toEqual([]);
    expect(listCitations(tree, person)).toHaveLength(1);
    const one = snapshot(tree);

    unlinkCitation(tree, citation.id, person);
    expect(count(tree, 'citation')).toBe(0);
    expect(count(tree, 'citation_link')).toBe(0);
    expect(getSource(tree, sourceId)).not.toBeNull();
    expect(tree.undoStatus().undo?.label).toBe('Remove citation');
    const none = snapshot(tree);

    tree.undo();
    expect(snapshot(tree)).toBe(one);
    tree.undo();
    expect(snapshot(tree)).toBe(both);
    tree.redo();
    tree.redo();
    expect(snapshot(tree)).toBe(none);
  });

  it('go with the event, name or person they support, and come back with undo', () => {
    const { tree, personId, birth, sourceId } = start();
    const nameId = listNames(tree, personId)[0]?.id ?? '';
    addCitation(tree, birth, { sourceId }, { page: 'birth' });
    addCitation(tree, { type: 'name', id: nameId }, { sourceId }, { page: 'name' });
    addCitation(tree, { type: 'person', id: personId }, { sourceId }, { page: 'person' });
    const full = snapshot(tree);

    deleteEvent(tree, birth.id);
    expect(count(tree, 'citation')).toBe(2);
    tree.undo();
    expect(snapshot(tree)).toBe(full);

    deleteName(tree, nameId);
    expect(count(tree, 'citation')).toBe(2);
    tree.undo();
    expect(snapshot(tree)).toBe(full);

    deletePerson(tree, personId);
    expect(count(tree, 'citation')).toBe(0);
    expect(count(tree, 'citation_link')).toBe(0);
    const empty = snapshot(tree);
    tree.undo();
    expect(snapshot(tree)).toBe(full);
    tree.redo();
    expect(snapshot(tree)).toBe(empty);
  });

  it('stay while another fact still rests on them', () => {
    const { tree, personId, birth, sourceId } = start();
    const other = addPersonFromDraft(tree, { given: 'Mary', surname: 'Hale' }).id;
    const citation = addCitation(tree, birth, { sourceId }, { page: 'household' });
    linkCitation(tree, citation.id, { type: 'person', id: other });

    deletePerson(tree, personId);
    expect(count(tree, 'citation')).toBe(1);
    expect(listPersonCitations(tree, other).map((entry) => entry.page)).toEqual(['household']);
  });

  it('all go with their source', () => {
    const { tree, personId, birth, sourceId } = start();
    addCitation(tree, birth, { sourceId }, { page: '1' });
    addCitation(tree, { type: 'person', id: personId }, { sourceId }, { page: '2' });
    const other = addCitation(tree, birth, { create: { title: 'Other' } }, { page: '3' });
    const full = snapshot(tree);

    deleteSource(tree, sourceId);
    expect(count(tree, 'citation')).toBe(1);
    expect(listCitations(tree, birth).map((entry) => entry.id)).toEqual([other.id]);
    tree.undo();
    expect(snapshot(tree)).toBe(full);

    deleteCitation(tree, other.id);
    expect(listCitations(tree, birth).map((entry) => entry.page)).toEqual(['1']);
    expect(getSource(tree, other.sourceId)).not.toBeNull();
    expect(() => deleteCitation(tree, other.id)).toThrow(NotFoundError);
  });

  it('are listed for a person once each, with the facts of the page they support', () => {
    const { tree, personId, birth, sourceId } = start();
    const partner = addPartner(tree, personId, { create: { given: 'Mary', surname: 'Stone' } });
    const familyId = partner.familyId;
    const marriageId = addFamilyEvent(tree, familyId, { type: 'marriage', date: '1895' }).id;
    const residenceId = addPersonEvent(tree, personId, { type: 'residence', date: '1900' }).id;
    const nameId = listNames(tree, personId)[0]?.id ?? '';

    const census = addCitation(tree, birth, { sourceId }, { page: 'census' });
    linkCitation(tree, census.id, { type: 'event', id: residenceId });
    linkCitation(tree, census.id, { type: 'name', id: nameId });
    const wedding = addCitation(
      tree,
      { type: 'event', id: marriageId },
      { sourceId },
      {
        page: 'wedding',
      },
    );
    linkCitation(tree, wedding.id, { type: 'family', id: familyId });
    const general = addCitation(
      tree,
      { type: 'person', id: personId },
      { sourceId },
      {
        page: 'general',
      },
    );

    const listed = listPersonCitations(tree, personId);
    expect(listed.map((entry) => [entry.page, entry.uses.map((use) => use.type).sort()])).toEqual([
      ['general', ['person']],
      ['census', ['event', 'event', 'name']],
      ['wedding', ['event', 'family']],
    ]);
    expect(listed[0]?.sourceTitle).toBe('Parish register');
    expect(getPersonPage(tree, personId)?.citations).toEqual(listed);
    // The partner's page shows what rests on the family, not what rests on the other partner.
    expect(listPersonCitations(tree, partner.personId).map((entry) => entry.page)).toEqual([
      'wedding',
    ]);

    // On the source's page each citation says which facts it supports, and of whom.
    const bySource = listSourceCitations(tree, sourceId);
    expect(bySource.map((entry) => entry.page)).toEqual(['census', 'general', 'wedding']);
    const uses = (id: string) =>
      listCitationUses(tree, id)
        .map((use) => `${use.what}:${use.personIds.length}`)
        .sort();
    expect(uses(census.id)).toEqual(['birth:1', 'name:1', 'residence:1']);
    expect(uses(wedding.id)).toEqual(['family:2', 'marriage:2']);
    expect(uses(general.id)).toEqual(['person:1']);
    expect(listSourceCitations(tree, sourceId, { limit: 1, offset: 1 })[0]?.page).toBe('general');
  });

  it('are found quickly in a large tree', () => {
    const tree = memoryTree();
    const sourceId = createSource(tree, { title: 'Census' }).id;
    let last = '';
    tree.transact('Fill', () => {
      for (let index = 0; index < 2000; index += 1) {
        last = addPersonFromDraft(tree, {
          given: `P${index}`,
          surname: 'Test',
          birthDate: '1900',
        }).id;
        const birthId = listPersonEvents(tree, last)[0]?.id ?? '';
        addCitation(tree, { type: 'event', id: birthId }, { sourceId }, { page: String(index) });
      }
    });
    const started = performance.now();
    for (let round = 0; round < 200; round += 1) listPersonCitations(tree, last);
    const each = (performance.now() - started) / 200;
    // A scan of every link would take far longer than this.
    expect(each).toBeLessThan(5);
    expect(listPersonCitations(tree, last)).toHaveLength(1);
  });
});
