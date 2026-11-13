import { trackChanges, untrackChanges } from '../changelog';
import { extractNotes } from '../gedcom/notes';
import type { Migration } from '../migrate';

/**
 * Notes as fields.
 *
 * A person, an event and a source each gain a `note`: the user's own remark,
 * of any number of lines. A citation and a picture already had one.
 *
 * In a GEDCOM file a note is a NOTE line. The first NOTE line that holds its
 * own text, under a person record, an event or a source record, is this note.
 * A second note, and a pointer to a note record that several things share,
 * stay as lines kept as written.
 *
 * In `gedcom_record.parts` the NOTE line of a person carries the mark `note`,
 * as the SEX line carries `sex`. The note of an event or a source needs no
 * mark: the export reads it from the event's or the source's own lines.
 *
 * Trees imported before this version held their notes as lines kept as
 * written; their notes are filled in here (see `extractNotes`).
 */
const TABLES = ['person', 'event', 'source'] as const;

export const notes: Migration = {
  version: 7,
  name: 'notes',
  up(db) {
    // The notes are written while the tables are not tracked: a migration is
    // not an edit, and leaves nothing to undo.
    for (const table of TABLES) untrackChanges(db, table);
    for (const table of TABLES) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN note TEXT NOT NULL DEFAULT ''`);
    }
    extractNotes(db);
    // Again, because the triggers list the columns and each table has a new one.
    for (const table of TABLES) trackChanges(db, table);
  },
};
