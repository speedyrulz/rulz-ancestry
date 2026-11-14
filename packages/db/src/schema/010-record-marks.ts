import { trackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * What the user decided about results of a search for records.
 *
 * `record_mark` holds one row for a result and the person it was found for:
 * `kept` to look at later, or `declined` because it is not this person. A
 * result is named by the id of its source (as in the source's manifest in
 * `@rulz/connectors`) and by what the source calls the record.
 *
 * A kept row holds the record as the app read it, in `record_json`, and when
 * it was read, in `read_at`: the source may say something else by now. For a
 * source whose terms bar keeping what it returns the JSON is NULL and the
 * title is empty; the row then holds the record's identifier and its address,
 * which the app makes itself. A declined row holds no record, only the title
 * and the address, so that the user can see what they turned down.
 *
 * A mark is for one person: a record that is not of this person may be of
 * their brother. It goes when the person is deleted.
 *
 * The table is part of the change log. Keeping and turning down can be undone
 * like any other edit, a deleted person's marks come back when the deletion is
 * undone, and a backup is made of a tree in which only marks have changed.
 *
 * Nothing of this is written to a GEDCOM file.
 */
const SCHEMA = `
  CREATE TABLE record_mark (
    id          TEXT PRIMARY KEY NOT NULL,
    person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    source_id   TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 100),
    record_key  TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 200),
    state       TEXT NOT NULL CHECK (state IN ('kept', 'declined')),
    title       TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    record_json TEXT CHECK (record_json IS NULL OR length(record_json) <= 16384),
    read_at     INTEGER NOT NULL,
    marked_at   INTEGER NOT NULL,
    CHECK (state = 'kept' OR record_json IS NULL)
  );
  CREATE UNIQUE INDEX record_mark_one ON record_mark(person_id, source_id, record_key);
  CREATE INDEX record_mark_list ON record_mark(state, marked_at);
`;

export const recordMarks: Migration = {
  version: 10,
  name: 'results of a search kept or turned down',
  up(db) {
    db.exec(SCHEMA);
    trackChanges(db, 'record_mark');
  },
};
