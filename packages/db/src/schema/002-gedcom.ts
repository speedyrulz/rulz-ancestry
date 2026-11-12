import type { Migration } from '../migrate';

/**
 * What is kept of a GEDCOM file a tree was imported from, so that exporting
 * the tree gives the file back with nothing lost.
 *
 * One row per record of the file, in file order:
 *
 * - `head`: the file's header, as written.
 * - `kept`: a record the app has no tables for yet (a source, a note, a media
 *   item, another program's own record), as written.
 * - `person` and `family`: the row's id is the id of the person or family the
 *   record became. `text` is the record's first line and `parts` lists the
 *   lines under it, in order, as JSON. A part that became a name, an event or
 *   a family link says which one; any other part is kept as written.
 *
 * These rows are written once, by the import, and never changed afterwards.
 * They are not part of the change log: an edit changes the person, and the
 * export works out what to write from the person and the original lines
 * together. A row whose person or family has since been deleted is ignored,
 * and is there again if the deletion is undone.
 *
 * `xref` is the record's cross-reference id (`I1` for `@I1@`). Ids the app
 * hands out for people added later must not clash with these.
 */
const SCHEMA = `
  CREATE TABLE gedcom_record (
    id       TEXT PRIMARY KEY NOT NULL,
    position INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    xref     TEXT,
    kind     TEXT NOT NULL CHECK (kind IN ('head', 'person', 'family', 'kept')),
    text     TEXT NOT NULL,
    parts    TEXT
  );
  CREATE UNIQUE INDEX gedcom_record_xref ON gedcom_record(xref) WHERE xref IS NOT NULL;
  CREATE INDEX gedcom_record_position ON gedcom_record(position);
`;

export const gedcomRecords: Migration = {
  version: 2,
  name: 'records of an imported GEDCOM file',
  up(db) {
    db.exec(SCHEMA);
  },
};
