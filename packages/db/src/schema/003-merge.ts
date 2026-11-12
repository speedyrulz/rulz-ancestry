import { trackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * What finding and merging duplicates has to remember.
 *
 * `not_duplicate` holds pairs of people the user has said are two different
 * people, so the pair is not offered as a possible duplicate again. The pair
 * is stored with the smaller id first.
 *
 * `merged_record` says which person or family another one was merged into.
 * `id` is the id the merged person or family had. The lines kept from an
 * imported GEDCOM file are stored under that old id (see 002-gedcom.ts), and
 * this row is how the export and the person page find them again under the
 * person who is left. There is no foreign key on `into_id`: when that person
 * is deleted the row stays, unused, and is right again if the deletion is
 * undone.
 *
 * Both tables are part of the change log, so marking a pair and merging two
 * people can be undone like any other edit.
 */
const SCHEMA = `
  CREATE TABLE not_duplicate (
    id         TEXT PRIMARY KEY NOT NULL,
    person_a   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    person_b   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    CHECK (person_a < person_b)
  );
  CREATE UNIQUE INDEX not_duplicate_pair ON not_duplicate(person_a, person_b);
  CREATE INDEX not_duplicate_b ON not_duplicate(person_b);

  CREATE TABLE merged_record (
    id        TEXT PRIMARY KEY NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('person', 'family')),
    into_id   TEXT NOT NULL,
    merged_at INTEGER NOT NULL
  );
  CREATE INDEX merged_record_into ON merged_record(into_id);
`;

export const mergeRecords: Migration = {
  version: 3,
  name: 'duplicates and merges',
  up(db) {
    db.exec(SCHEMA);
    trackChanges(db, 'not_duplicate');
    trackChanges(db, 'merged_record');
  },
};
