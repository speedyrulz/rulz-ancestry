import { describe, expect, it } from 'vitest';
import { addPersonFromDraft } from './actions';
import { addPersonEvent, deleteEvent, listPersonEvents, updateEvent } from './events';
import { openDatabase } from './connection';
import { importGedcom } from './gedcom/import';
import { exportLines, file, importText, inputOf } from './gedcom/testing';
import { migrate, schemaVersion } from './migrate';
import { mergePersons } from './merge';
import { createPerson, deletePerson } from './persons';
import {
  countPlaces,
  getPlaceLink,
  linkPlace,
  listPlaces,
  suggestTreePlaces,
  unlinkPlace,
  type PlaceLink,
} from './places';
import { treeMigrations } from './schema';
import { cleanUpAfterEach, memoryTree, snapshot, track, undoDepth } from './testing';
import { TREE_APPLICATION_ID, Tree, TreeRuleError } from './tree';

cleanUpAfterEach();

const SPRINGFIELD: PlaceLink = {
  geonamesId: 4250542,
  name: 'Springfield, Sangamon County, Illinois, USA',
  lat: 39.80172,
  lon: -89.64371,
};
const YORK: PlaceLink = {
  geonamesId: 2633352,
  name: 'York, England',
  lat: 53.95763,
  lon: -1.08271,
};

function person(tree: Tree, given = 'Ann'): string {
  return createPerson(tree, { name: { given, surname: 'Lee' } }).id;
}

/** A tree with events at three places, one of them written in two ways. */
function treeWithPlaces(): { tree: Tree; ann: string } {
  const tree = memoryTree();
  const ann = person(tree);
  addPersonEvent(tree, ann, { type: 'birth', date: '1900', place: 'Springfield, Illinois' });
  addPersonEvent(tree, ann, { type: 'residence', date: '1910', place: 'springfield, illinois' });
  addPersonEvent(tree, ann, { type: 'residence', date: '1920', place: 'York, England' });
  addPersonEvent(tree, ann, { type: 'death', date: '1980', place: 'Zürich' });
  addPersonEvent(tree, ann, { type: 'burial', date: '1980' });
  return { tree, ann };
}

describe('listPlaces', () => {
  it('lists each place once, however often and in whatever case it is written', () => {
    const { tree } = treeWithPlaces();
    expect(listPlaces(tree)).toEqual([
      { text: 'Springfield, Illinois', events: 2, link: null },
      { text: 'York, England', events: 1, link: null },
      { text: 'Zürich', events: 1, link: null },
    ]);
    expect(countPlaces(tree)).toBe(3);
  });

  it('takes two ways of writing a letter outside A to Z for two places', () => {
    // A known limit: SQLite sets upper and lower case alike for A to Z only.
    const { tree, ann } = treeWithPlaces();
    addPersonEvent(tree, ann, { type: 'residence', date: '1970', place: 'ZÜRICH' });
    expect(listPlaces(tree, { query: 'rich' }).map((place) => place.text)).toEqual([
      'ZÜRICH',
      'Zürich',
    ]);
    linkPlace(tree, 'Zürich', YORK);
    expect(getPlaceLink(tree, 'ZÜRICH')).toBeNull();
  });

  it('has nothing to list for a tree without places', () => {
    const tree = memoryTree();
    addPersonEvent(tree, person(tree), { type: 'birth', date: '1900' });
    expect(listPlaces(tree)).toEqual([]);
    expect(countPlaces(tree)).toBe(0);
  });

  it('finds places by a part of their text', () => {
    const { tree } = treeWithPlaces();
    expect(listPlaces(tree, { query: 'england' }).map((place) => place.text)).toEqual([
      'York, England',
    ]);
    expect(countPlaces(tree, { query: 'ILLINOIS' })).toBe(1);
    // The signs a search pattern uses are taken as they are.
    expect(listPlaces(tree, { query: '%' })).toEqual([]);
    expect(listPlaces(tree, { query: '_' })).toEqual([]);
  });

  it('lists the linked places, or the others', () => {
    const { tree } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    expect(listPlaces(tree, { linked: true })).toEqual([
      { text: 'York, England', events: 1, link: YORK },
    ]);
    expect(listPlaces(tree, { linked: false }).map((place) => place.text)).toEqual([
      'Springfield, Illinois',
      'Zürich',
    ]);
    expect(countPlaces(tree, { linked: true })).toBe(1);
    expect(countPlaces(tree, { linked: false })).toBe(2);
  });

  it('gives the list a page at a time', () => {
    const { tree } = treeWithPlaces();
    expect(listPlaces(tree, { limit: 2 }).map((place) => place.text)).toEqual([
      'Springfield, Illinois',
      'York, England',
    ]);
    expect(listPlaces(tree, { limit: 2, offset: 2 }).map((place) => place.text)).toEqual([
      'Zürich',
    ]);
  });
});

describe('linkPlace', () => {
  it('links every event with that place, in whatever case it is written', () => {
    const { tree } = treeWithPlaces();
    linkPlace(tree, 'SPRINGFIELD, ILLINOIS', SPRINGFIELD);
    expect(listPlaces(tree)[0]).toEqual({
      text: 'Springfield, Illinois',
      events: 2,
      link: SPRINGFIELD,
    });
    expect(getPlaceLink(tree, 'springfield, illinois')).toEqual(SPRINGFIELD);
    expect(getPlaceLink(tree, '  Springfield, Illinois ')).toEqual(SPRINGFIELD);
    expect(getPlaceLink(tree, 'Springfield')).toBeNull();
  });

  it('leaves the text of every event as it was typed', () => {
    const { tree, ann } = treeWithPlaces();
    const before = listPersonEvents(tree, ann).map((event) => event.placeText);
    linkPlace(tree, 'Springfield, Illinois', SPRINGFIELD);
    expect(listPersonEvents(tree, ann).map((event) => event.placeText)).toEqual(before);
  });

  it('is one step that undo takes back and redo makes again', () => {
    const { tree } = treeWithPlaces();
    const depth = undoDepth(tree);
    const before = snapshot(tree);
    linkPlace(tree, 'York, England', YORK);
    expect(undoDepth(tree)).toBe(depth + 1);
    expect(tree.undoStatus().undo?.label).toBe('Link place');
    const linked = snapshot(tree);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(getPlaceLink(tree, 'York, England')).toBeNull();
    tree.redo();
    expect(snapshot(tree)).toBe(linked);
  });

  it('replaces the link a place has, and undo brings the old one back', () => {
    const { tree } = treeWithPlaces();
    linkPlace(tree, 'York, England', SPRINGFIELD);
    linkPlace(tree, 'York, England', YORK);
    expect(getPlaceLink(tree, 'York, England')).toEqual(YORK);
    expect(tree.db.prepare('SELECT count(*) FROM place').pluck().get()).toBe(1);
    tree.undo();
    expect(getPlaceLink(tree, 'York, England')).toEqual(SPRINGFIELD);
  });

  it('makes no step when the link is the one the place has', () => {
    const { tree } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    const depth = undoDepth(tree);
    linkPlace(tree, 'York, England', YORK);
    expect(undoDepth(tree)).toBe(depth);
  });

  it('refuses a place without a name and coordinates that are none', () => {
    const { tree } = treeWithPlaces();
    expect(() => linkPlace(tree, '   ', YORK)).toThrow(TreeRuleError);
    expect(() => linkPlace(tree, 'York', { ...YORK, lat: 91 })).toThrow(TreeRuleError);
    expect(() => linkPlace(tree, 'York', { ...YORK, lon: Number.NaN })).toThrow(TreeRuleError);
    expect(() => linkPlace(tree, 'York', { ...YORK, geonamesId: 1.5 })).toThrow(TreeRuleError);
    expect(() => linkPlace(tree, 'x'.repeat(501), YORK)).toThrow(TreeRuleError);
    expect(tree.db.prepare('SELECT count(*) FROM place').pluck().get()).toBe(0);
  });

  it('takes coordinates that come from no gazetteer', () => {
    const { tree } = treeWithPlaces();
    const farm: PlaceLink = { geonamesId: null, name: '', lat: -45.5, lon: 170.25 };
    linkPlace(tree, 'Zürich', farm);
    expect(getPlaceLink(tree, 'Zürich')).toEqual(farm);
  });
});

describe('unlinkPlace', () => {
  it('takes the link away and leaves the events alone', () => {
    const { tree, ann } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    unlinkPlace(tree, 'york, england');
    expect(getPlaceLink(tree, 'York, England')).toBeNull();
    expect(listPersonEvents(tree, ann)).toHaveLength(5);
    expect(tree.undoStatus().undo?.label).toBe('Unlink place');
    tree.undo();
    expect(getPlaceLink(tree, 'York, England')).toEqual(YORK);
  });

  it('makes no step for a place that has no link', () => {
    const { tree } = treeWithPlaces();
    const depth = undoDepth(tree);
    unlinkPlace(tree, 'York, England');
    expect(undoDepth(tree)).toBe(depth);
  });
});

describe('a link picked while an event is saved', () => {
  it('is made in the same step as the event', () => {
    const tree = memoryTree();
    const ann = person(tree);
    const depth = undoDepth(tree);
    addPersonEvent(tree, ann, {
      type: 'birth',
      place: 'Springfield, Sangamon County, Illinois, USA',
      placeLink: SPRINGFIELD,
    });
    expect(undoDepth(tree)).toBe(depth + 1);
    expect(getPlaceLink(tree, 'Springfield, Sangamon County, Illinois, USA')).toEqual(SPRINGFIELD);
    tree.undo();
    expect(listPersonEvents(tree, ann)).toEqual([]);
    expect(getPlaceLink(tree, 'Springfield, Sangamon County, Illinois, USA')).toBeNull();
  });

  it('is made when an event is edited, also when nothing else changes', () => {
    const { tree, ann } = treeWithPlaces();
    const [birth] = listPersonEvents(tree, ann);
    if (!birth) throw new Error('no birth');
    updateEvent(tree, birth.id, { place: 'York, England', placeLink: YORK });
    expect(getPlaceLink(tree, 'York, England')).toEqual(YORK);
    expect(tree.undoStatus().undo?.label).toBe('Edit event');
    tree.undo();
    expect(getPlaceLink(tree, 'York, England')).toBeNull();

    const depth = undoDepth(tree);
    updateEvent(tree, birth.id, { placeLink: SPRINGFIELD });
    expect(undoDepth(tree)).toBe(depth + 1);
    expect(getPlaceLink(tree, 'Springfield, Illinois')).toEqual(SPRINGFIELD);
  });

  it('is not made for an event without a place', () => {
    const tree = memoryTree();
    const ann = person(tree);
    addPersonEvent(tree, ann, { type: 'birth', date: '1900', place: '  ', placeLink: YORK });
    expect(tree.db.prepare('SELECT count(*) FROM place').pluck().get()).toBe(0);
  });

  it('is made for the birth and the death of a new person', () => {
    const tree = memoryTree();
    addPersonFromDraft(tree, {
      given: 'Ann',
      birthPlace: 'Springfield, Illinois',
      birthPlaceLink: SPRINGFIELD,
      deathPlace: 'York, England',
      deathPlaceLink: YORK,
    });
    expect(listPlaces(tree)).toEqual([
      { text: 'Springfield, Illinois', events: 1, link: SPRINGFIELD },
      { text: 'York, England', events: 1, link: YORK },
    ]);
    expect(tree.undoStatus().undo?.label).toBe('Add person');
    tree.undo();
    expect(tree.db.prepare('SELECT count(*) FROM place').pluck().get()).toBe(0);
  });
});

describe('a link follows the text of the place', () => {
  it('no longer counts for an event whose place is retyped, and counts for one retyped to it', () => {
    const { tree, ann } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    const events = listPersonEvents(tree, ann);
    const york = events.find((event) => event.placeText === 'York, England');
    const zurich = events.find((event) => event.placeText === 'Zürich');
    if (!york || !zurich) throw new Error('events are missing');

    updateEvent(tree, york.id, { place: 'Yorke' });
    expect(listPlaces(tree).map((place) => [place.text, place.link !== null])).toEqual([
      ['Springfield, Illinois', false],
      ['Yorke', false],
      ['Zürich', false],
    ]);
    // The link waits for the text to be used again.
    updateEvent(tree, zurich.id, { place: 'york, england' });
    expect(listPlaces(tree, { linked: true })).toEqual([
      { text: 'york, england', events: 1, link: YORK },
    ]);
  });

  it('stays when the last event at the place is deleted, and serves again', () => {
    const { tree, ann } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    const york = listPersonEvents(tree, ann).find((event) => event.placeText === 'York, England');
    if (!york) throw new Error('no event at York');
    deleteEvent(tree, york.id);
    expect(listPlaces(tree, { linked: true })).toEqual([]);
    addPersonEvent(tree, ann, { type: 'residence', place: 'York, England' });
    expect(listPlaces(tree, { linked: true })).toHaveLength(1);
  });

  it('survives deleting a person and merging two', () => {
    const { tree, ann } = treeWithPlaces();
    linkPlace(tree, 'York, England', YORK);
    const bob = person(tree, 'Bob');
    addPersonEvent(tree, bob, { type: 'birth', date: '1901', place: 'York, England' });
    expect(listPlaces(tree, { linked: true })[0]?.events).toBe(2);
    mergePersons(tree, ann, bob);
    expect(listPlaces(tree, { linked: true })[0]).toEqual({
      text: 'York, England',
      events: 2,
      link: YORK,
    });
    deletePerson(tree, ann);
    expect(listPlaces(tree)).toEqual([]);
    expect(getPlaceLink(tree, 'York, England')).toEqual(YORK);
    tree.undo();
    expect(listPlaces(tree, { linked: true })[0]?.events).toBe(2);
  });
});

describe('suggestTreePlaces', () => {
  it('offers the places that start with what is typed, the most used first', () => {
    const { tree, ann } = treeWithPlaces();
    addPersonEvent(tree, ann, { type: 'residence', place: 'Springdale, Iowa' });
    expect(suggestTreePlaces(tree, 'spring').map((place) => [place.text, place.events])).toEqual([
      ['Springfield, Illinois', 2],
      ['Springdale, Iowa', 1],
    ]);
  });

  it('offers a place in which a later word starts with what is typed, after the others', () => {
    const { tree, ann } = treeWithPlaces();
    addPersonEvent(tree, ann, { type: 'residence', place: 'England' });
    expect(suggestTreePlaces(tree, 'engl').map((place) => place.text)).toEqual([
      'England',
      'York, England',
    ]);
    expect(suggestTreePlaces(tree, 'Spring, Ill').map((place) => place.text)).toEqual([
      'Springfield, Illinois',
    ]);
  });

  it('does not mind accents, and says which places are linked', () => {
    const { tree } = treeWithPlaces();
    linkPlace(tree, 'Zürich', YORK);
    expect(suggestTreePlaces(tree, 'zuri')).toEqual([{ text: 'Zürich', events: 1, link: YORK }]);
  });

  it('offers nothing for nothing, and no more than asked for', () => {
    const { tree } = treeWithPlaces();
    expect(suggestTreePlaces(tree, '')).toEqual([]);
    expect(suggestTreePlaces(tree, ' , ')).toEqual([]);
    expect(suggestTreePlaces(tree, 'xyz')).toEqual([]);
    expect(suggestTreePlaces(tree, 's', 1)).toHaveLength(1);
  });

  it('answers quickly in a tree with ten thousand places', () => {
    const tree = memoryTree();
    const ann = person(tree);
    tree.transact('Many events', () => {
      for (let index = 0; index < 10_000; index += 1) {
        addPersonEvent(tree, ann, { type: 'residence', place: `Village ${index}, County, Iowa` });
      }
    });
    const start = performance.now();
    const offered = suggestTreePlaces(tree, 'village 99');
    expect(offered).toHaveLength(8);
    expect(listPlaces(tree, { limit: 50 })).toHaveLength(50);
    expect(countPlaces(tree)).toBe(10_000);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('the upgrade to schema version 8', () => {
  const FILE = file(
    '5.5.1',
    '0 @I1@ INDI',
    '1 NAME Ann /Lee/',
    '1 BIRT',
    '2 DATE 1 JAN 1900',
    '2 PLAC Springfield, Sangamon, Illinois, USA',
    '3 MAP',
    '4 LATI N39.8017',
    '4 LONG W89.6437',
    '1 DEAT',
    '2 PLAC York, England',
  );

  /** A tree as the build before this one made it, at schema version 7. */
  function olderTree(): Tree {
    const db = openDatabase(':memory:');
    db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    migrate(db, treeMigrations.slice(0, 7));
    db.prepare(
      "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
    ).run();
    return track(new Tree(db, null));
  }

  it('adds the place table to an older tree and changes nothing else', () => {
    const older = olderTree();
    importGedcom(older, inputOf(FILE));
    expect(schemaVersion(older.db)).toBe(7);
    const before = snapshot(older);
    migrate(older.db, treeMigrations.slice(0, 8));
    expect(schemaVersion(older.db)).toBe(8);

    const fresh = memoryTree();
    importText(fresh, FILE);
    // Ids differ between two imports; the places and what they hold do not.
    expect(listPlaces(older)).toEqual(listPlaces(fresh));
    expect(listPlaces(older).map((place) => place.text)).toEqual([
      'Springfield, Sangamon, Illinois, USA',
      'York, England',
    ]);
    expect(JSON.parse(snapshot(older)).tables.place).toEqual([]);
    const { place: _place, ...rest } = JSON.parse(snapshot(older)).tables;
    expect(rest).toEqual(JSON.parse(before).tables);
    // The upgraded tree takes links like any other.
    linkPlace(older, 'York, England', YORK);
    older.undo();
    expect(getPlaceLink(older, 'York, England')).toBeNull();
  });

  it('leaves the lines of an imported file as they were when a place is linked', () => {
    const tree = memoryTree();
    importText(tree, FILE);
    const before = exportLines(tree);
    linkPlace(tree, 'Springfield, Sangamon, Illinois, USA', SPRINGFIELD);
    linkPlace(tree, 'York, England', YORK);
    expect(exportLines(tree)).toEqual(before);
    // The coordinates the file gave stay in the file.
    expect(before).toContain('4 LATI N39.8017');
  });
});
