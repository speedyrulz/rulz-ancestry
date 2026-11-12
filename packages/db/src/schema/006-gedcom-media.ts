import { trackChanges, untrackChanges } from '../changelog';
import { extractMedia } from '../gedcom/medialoader';
import type { Migration } from '../migrate';

/**
 * Pictures and documents of an imported GEDCOM file.
 *
 * A GEDCOM file names files; it does not hold them. From this version on, a
 * file that an imported file names is a `media` row like any other, attached
 * to what the file attaches it to. Until the user gives the app the file
 * itself, the row has no `sha256`: the tree knows of the file and does not
 * hold it.
 *
 * `media.origin` is where the imported file says the file is: a path on the
 * computer it was written on, a path beside the GEDCOM file, or a web
 * address. It is empty for a file that was added in the app.
 *
 * The index on `media.sha256` is no longer unique. Two records of an imported
 * file may name the same picture, and both are kept, as the file has them. A
 * file that is added in the app is still one row however often it is added.
 *
 * `gedcom_record` gains the kind `media`: the record a file was imported
 * from, under the id of the `media` row. SQLite cannot change a CHECK, so the
 * table is rebuilt, as in version 4.
 *
 * `gedcom_media` is for media items that a file writes in place, under a
 * person or an event, with no record of their own. It gives the `media` row
 * that each wording became, so that the export can tell which file a line
 * stands for. Like `gedcom_record` it is written by an import and never by an
 * edit, and it is not part of the change log.
 *
 * Trees imported before this version held all of this as lines kept as
 * written; their rows are made here (see `extractMedia`).
 */
const CHANGES = `
  ALTER TABLE media ADD COLUMN origin TEXT NOT NULL DEFAULT '';
  DROP INDEX media_sha256;
  CREATE INDEX media_sha256 ON media(sha256) WHERE sha256 IS NOT NULL;

  CREATE TABLE gedcom_media (
    media_id TEXT PRIMARY KEY NOT NULL,
    key      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX gedcom_media_key ON gedcom_media(key);
`;

const REBUILD_GEDCOM_RECORD = `
  CREATE TABLE gedcom_record_new (
    id       TEXT PRIMARY KEY NOT NULL,
    position INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    xref     TEXT,
    kind     TEXT NOT NULL
      CHECK (kind IN ('head', 'person', 'family', 'source', 'media', 'kept')),
    text     TEXT NOT NULL,
    parts    TEXT
  );
  INSERT INTO gedcom_record_new (id, position, tag, xref, kind, text, parts)
    SELECT id, position, tag, xref, kind, text, parts FROM gedcom_record;
  DROP TABLE gedcom_record;
  ALTER TABLE gedcom_record_new RENAME TO gedcom_record;
  CREATE UNIQUE INDEX gedcom_record_xref ON gedcom_record(xref) WHERE xref IS NOT NULL;
  CREATE INDEX gedcom_record_position ON gedcom_record(position);
`;

export const gedcomMedia: Migration = {
  version: 6,
  name: 'pictures and documents of imported files',
  up(db) {
    // The rows are written while the tables are not tracked: a migration is
    // not an edit, and leaves nothing to undo.
    untrackChanges(db, 'media');
    untrackChanges(db, 'media_link');
    db.exec(CHANGES);
    db.exec(REBUILD_GEDCOM_RECORD);
    extractMedia(db);
    // Again, because the triggers list the columns and `media` has a new one.
    trackChanges(db, 'media');
    trackChanges(db, 'media_link');
  },
};
