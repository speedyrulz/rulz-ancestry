import { trackChanges } from '../changelog';
import { extractSources } from '../gedcom/citations';
import type { Migration } from '../migrate';

/**
 * Sources and citations.
 *
 * A `source` is where information comes from: a census, a parish register, a
 * book, a web page. A `citation` is one place in a source (a page, an entry)
 * with what it says there. A `citation_link` says which fact a citation
 * supports: a person or a family as a whole, one event, or one name. One
 * citation can support several facts, as one census entry gives a name, a
 * year of birth and a residence.
 *
 * A citation exists only while it supports something. When its last link
 * goes, the citation goes with it (the trigger below), whether the link was
 * removed by the user or went with a deleted event, name, person or family.
 * The trigger acts only while a change is being recorded: undo and redo write
 * every row back themselves.
 *
 * All three tables are part of the change log.
 *
 * `gedcom_record` gains the kind `source`: the record a source was imported
 * from, under the source's own id, as a person's record is under the person's
 * id. SQLite cannot change a CHECK, so the table is rebuilt. Trees imported
 * before this version held their sources as lines kept as written; their rows
 * are made here (see `extractSources`).
 */
const TABLES = `
  CREATE TABLE source (
    id           TEXT PRIMARY KEY NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    author       TEXT NOT NULL DEFAULT '',
    publication  TEXT NOT NULL DEFAULT '',
    abbreviation TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX source_title ON source(title COLLATE NOCASE);

  CREATE TABLE citation (
    id         TEXT PRIMARY KEY NOT NULL,
    source_id  TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
    page       TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL DEFAULT '',
    -- 0 unreliable, 1 questionable, 2 secondary, 3 direct and primary; NULL not stated.
    quality    INTEGER CHECK (quality IN (0, 1, 2, 3)),
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX citation_source ON citation(source_id);

  -- Exactly one of the four owner columns is set.
  CREATE TABLE citation_link (
    id          TEXT PRIMARY KEY NOT NULL,
    citation_id TEXT NOT NULL REFERENCES citation(id) ON DELETE CASCADE,
    person_id   TEXT REFERENCES person(id) ON DELETE CASCADE,
    family_id   TEXT REFERENCES family(id) ON DELETE CASCADE,
    event_id    TEXT REFERENCES event(id) ON DELETE CASCADE,
    name_id     TEXT REFERENCES person_name(id) ON DELETE CASCADE,
    -- Position of the citation in that owner's list.
    sort_order  INTEGER NOT NULL DEFAULT 0,
    CHECK (
      (person_id IS NOT NULL) + (family_id IS NOT NULL)
        + (event_id IS NOT NULL) + (name_id IS NOT NULL) = 1
    )
  );
  CREATE INDEX citation_link_citation ON citation_link(citation_id);
  -- A fact cites a citation once.
  CREATE UNIQUE INDEX citation_link_person ON citation_link(person_id, citation_id)
    WHERE person_id IS NOT NULL;
  CREATE UNIQUE INDEX citation_link_family ON citation_link(family_id, citation_id)
    WHERE family_id IS NOT NULL;
  CREATE UNIQUE INDEX citation_link_event ON citation_link(event_id, citation_id)
    WHERE event_id IS NOT NULL;
  CREATE UNIQUE INDEX citation_link_name ON citation_link(name_id, citation_id)
    WHERE name_id IS NOT NULL;
`;

const REBUILD_GEDCOM_RECORD = `
  CREATE TABLE gedcom_record_new (
    id       TEXT PRIMARY KEY NOT NULL,
    position INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    xref     TEXT,
    kind     TEXT NOT NULL CHECK (kind IN ('head', 'person', 'family', 'source', 'kept')),
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

const LAST_LINK_TRIGGER = `
  CREATE TRIGGER citation_link_last AFTER DELETE ON citation_link
  WHEN (SELECT mode FROM change_state) = 'record'
    AND NOT EXISTS (SELECT 1 FROM citation_link WHERE citation_id = OLD.citation_id)
  BEGIN
    DELETE FROM citation WHERE id = OLD.citation_id;
  END;
`;

export const sources: Migration = {
  version: 4,
  name: 'sources and citations',
  up(db) {
    db.exec(TABLES);
    db.exec(REBUILD_GEDCOM_RECORD);
    // The rows are written before the tables are tracked: a migration is not
    // an edit, and leaves nothing to undo.
    extractSources(db);
    trackChanges(db, 'source');
    trackChanges(db, 'citation');
    trackChanges(db, 'citation_link');
    db.exec(LAST_LINK_TRIGGER);
  },
};
