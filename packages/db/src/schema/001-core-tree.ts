import { trackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * People, names, families, events, the change log and the search index.
 *
 * Conventions used by every tree table:
 * - `id` is a UUIDv7 in text form, so two trees can be merged without clashes.
 * - Times are Unix milliseconds. Dates of events are Julian Day Numbers.
 * - Number columns are declared INTEGER so values keep that type when undo
 *   writes them back from JSON.
 * - Closed value sets (sex, yes/no flags) have a CHECK. Open ones (name type,
 *   event type, pedigree) are plain text, so an imported file can keep a value
 *   the app has no label for.
 */
const SCHEMA = `
  -- Facts about the tree itself: its id, its name, when it was created.
  CREATE TABLE tree_meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );

  CREATE TABLE person (
    id         TEXT PRIMARY KEY NOT NULL,
    sex        TEXT NOT NULL DEFAULT 'U' CHECK (sex IN ('M', 'F', 'X', 'U')),
    -- 1 living, 0 deceased, NULL not stated (the app then works it out from events).
    living     INTEGER CHECK (living IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE person_name (
    id         TEXT PRIMARY KEY NOT NULL,
    person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'birth',
    prefix     TEXT NOT NULL DEFAULT '',
    given      TEXT NOT NULL DEFAULT '',
    nickname   TEXT NOT NULL DEFAULT '',
    surname    TEXT NOT NULL DEFAULT '',
    suffix     TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX person_name_person ON person_name(person_id, sort_order);
  -- At most one primary name per person.
  CREATE UNIQUE INDEX person_name_primary ON person_name(person_id) WHERE is_primary = 1;
  CREATE INDEX person_name_sort ON person_name(surname COLLATE NOCASE, given COLLATE NOCASE);

  -- A couple and their children. Either partner may be unknown.
  CREATE TABLE family (
    id          TEXT PRIMARY KEY NOT NULL,
    partner1_id TEXT REFERENCES person(id) ON DELETE SET NULL,
    partner2_id TEXT REFERENCES person(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CHECK (partner1_id IS NULL OR partner2_id IS NULL OR partner1_id <> partner2_id)
  );
  CREATE INDEX family_partner1 ON family(partner1_id);
  CREATE INDEX family_partner2 ON family(partner2_id);

  CREATE TABLE family_child (
    id         TEXT PRIMARY KEY NOT NULL,
    family_id  TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    child_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    pedigree   TEXT NOT NULL DEFAULT 'birth',
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (family_id, child_id)
  );
  CREATE INDEX family_child_child ON family_child(child_id);

  CREATE TABLE event (
    id             TEXT PRIMARY KEY NOT NULL,
    type           TEXT NOT NULL,
    -- The date as typed, then how the app read it (see parseDate in @rulz/core).
    date_text      TEXT NOT NULL DEFAULT '',
    date_qualifier TEXT,
    date_calendar  TEXT,
    date_min_jdn   INTEGER,
    date_max_jdn   INTEGER,
    place_text     TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX event_type_date ON event(type, date_min_jdn);

  -- Who an event belongs to: a person (birth) or a family (marriage).
  CREATE TABLE event_participant (
    id         TEXT PRIMARY KEY NOT NULL,
    event_id   TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    person_id  TEXT REFERENCES person(id) ON DELETE CASCADE,
    family_id  TEXT REFERENCES family(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'principal',
    -- Position of the event in that person's or family's list; the first of a type is preferred.
    sort_order INTEGER NOT NULL DEFAULT 0,
    CHECK ((person_id IS NULL) <> (family_id IS NULL))
  );
  CREATE INDEX event_participant_event ON event_participant(event_id);
  CREATE INDEX event_participant_person ON event_participant(person_id, sort_order);
  CREATE INDEX event_participant_family ON event_participant(family_id, sort_order);

  -- Change log. See changelog.ts.
  CREATE TABLE change_tx (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    label  TEXT NOT NULL,
    at     INTEGER NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1))
  );
  CREATE TABLE change_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id       INTEGER NOT NULL REFERENCES change_tx(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    op          TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
    before_json TEXT,
    after_json  TEXT
  );
  CREATE INDEX change_log_tx ON change_log(tx_id);
  CREATE INDEX change_log_entity ON change_log(entity_type, entity_id);
  CREATE TABLE change_state (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    mode       TEXT NOT NULL DEFAULT 'idle' CHECK (mode IN ('idle', 'record', 'replay')),
    current_tx INTEGER
  );
  INSERT INTO change_state (id) VALUES (1);

  -- Own-tree search. search_doc maps a full-text row to the record it came
  -- from and the person a hit should lead to. The tokenizer ignores case and
  -- accents, so "muller" finds "Müller".
  CREATE TABLE search_doc (
    id          INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    person_id   TEXT,
    UNIQUE (entity_type, entity_id)
  );
  CREATE INDEX search_doc_person ON search_doc(person_id);
  CREATE VIRTUAL TABLE search_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');

  -- The index follows person_name through triggers, so it also stays right
  -- when undo or redo writes rows back.
  CREATE TRIGGER person_name_search_insert AFTER INSERT ON person_name
  BEGIN
    INSERT INTO search_doc (entity_type, entity_id, person_id)
    VALUES ('person_name', NEW.id, NEW.person_id);
    INSERT INTO search_fts (rowid, text)
    VALUES (
      (SELECT id FROM search_doc WHERE entity_type = 'person_name' AND entity_id = NEW.id),
      trim(NEW.prefix || ' ' || NEW.given || ' ' || NEW.nickname || ' ' || NEW.surname || ' ' || NEW.suffix)
    );
  END;
  CREATE TRIGGER person_name_search_update AFTER UPDATE ON person_name
  BEGIN
    UPDATE search_doc SET person_id = NEW.person_id
    WHERE entity_type = 'person_name' AND entity_id = NEW.id;
    UPDATE search_fts
    SET text = trim(NEW.prefix || ' ' || NEW.given || ' ' || NEW.nickname || ' ' || NEW.surname || ' ' || NEW.suffix)
    WHERE rowid = (SELECT id FROM search_doc WHERE entity_type = 'person_name' AND entity_id = NEW.id);
  END;
  CREATE TRIGGER person_name_search_delete AFTER DELETE ON person_name
  BEGIN
    DELETE FROM search_fts
    WHERE rowid = (SELECT id FROM search_doc WHERE entity_type = 'person_name' AND entity_id = OLD.id);
    DELETE FROM search_doc WHERE entity_type = 'person_name' AND entity_id = OLD.id;
  END;
`;

/** Every table whose changes are logged and can be undone. */
const TRACKED_TABLES = [
  'person',
  'person_name',
  'family',
  'family_child',
  'event',
  'event_participant',
] as const;

export const coreTree: Migration = {
  version: 1,
  name: 'core tree',
  up(db) {
    db.exec(SCHEMA);
    for (const table of TRACKED_TABLES) trackChanges(db, table);
  },
};
