import { trackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * Pictures and documents.
 *
 * A `media` row is one file the tree holds: a photograph, a scan of a record,
 * a PDF. The file itself is in the `media` folder beside `tree.db`, named
 * after the SHA-256 of its contents (see `mediaStorePath` in `@rulz/core`), so
 * the row needs no path: the hash and the extension say where the file is.
 * One file is one row, however often it is added.
 *
 * A `media_link` says what a file is attached to: a person or a family as a
 * whole, an event, a citation, or a source. One file can be attached to
 * several of them, as one photograph shows several people. A file attached to
 * nothing stays in the tree; unlike a citation it is worth keeping on its own.
 *
 * `sha256` may be NULL: the tree then knows of a file but does not hold it.
 * Nothing makes such rows yet. They are for files an imported GEDCOM file
 * names without bringing them along.
 *
 * Both tables are part of the change log. The files are not: a file in the
 * media folder is never changed or removed by an edit, so undo and a restored
 * backup always find the file a row names.
 */
const TABLES = `
  CREATE TABLE media (
    id          TEXT PRIMARY KEY NOT NULL,
    sha256      TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
    -- The extension the file is stored under, without a dot; may be empty.
    ext         TEXT NOT NULL DEFAULT '',
    mime        TEXT NOT NULL DEFAULT '',
    size        INTEGER NOT NULL DEFAULT 0,
    -- The name the file had where it was added from.
    file_name   TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX media_sha256 ON media(sha256) WHERE sha256 IS NOT NULL;

  -- Exactly one of the five owner columns is set.
  CREATE TABLE media_link (
    id          TEXT PRIMARY KEY NOT NULL,
    media_id    TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    person_id   TEXT REFERENCES person(id) ON DELETE CASCADE,
    family_id   TEXT REFERENCES family(id) ON DELETE CASCADE,
    event_id    TEXT REFERENCES event(id) ON DELETE CASCADE,
    citation_id TEXT REFERENCES citation(id) ON DELETE CASCADE,
    source_id   TEXT REFERENCES source(id) ON DELETE CASCADE,
    -- Position of the file in that owner's list.
    sort_order  INTEGER NOT NULL DEFAULT 0,
    CHECK (
      (person_id IS NOT NULL) + (family_id IS NOT NULL) + (event_id IS NOT NULL)
        + (citation_id IS NOT NULL) + (source_id IS NOT NULL) = 1
    )
  );
  CREATE INDEX media_link_media ON media_link(media_id);
  -- A file is attached to one thing once.
  CREATE UNIQUE INDEX media_link_person ON media_link(person_id, media_id)
    WHERE person_id IS NOT NULL;
  CREATE UNIQUE INDEX media_link_family ON media_link(family_id, media_id)
    WHERE family_id IS NOT NULL;
  CREATE UNIQUE INDEX media_link_event ON media_link(event_id, media_id)
    WHERE event_id IS NOT NULL;
  CREATE UNIQUE INDEX media_link_citation ON media_link(citation_id, media_id)
    WHERE citation_id IS NOT NULL;
  CREATE UNIQUE INDEX media_link_source ON media_link(source_id, media_id)
    WHERE source_id IS NOT NULL;
`;

export const media: Migration = {
  version: 5,
  name: 'pictures and documents',
  up(db) {
    db.exec(TABLES);
    trackChanges(db, 'media');
    trackChanges(db, 'media_link');
  },
};
