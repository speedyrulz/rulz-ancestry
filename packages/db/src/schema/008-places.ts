import { trackChanges } from '../changelog';
import type { Migration } from '../migrate';

/**
 * Places.
 *
 * An event keeps its place as the text the user typed (`event.place_text`),
 * and that text is never rewritten. A `place` row says where on the map one
 * such text lies: it links the text to an entry of the GeoNames gazetteer and
 * holds a copy of that entry's name and coordinates, so a tree that is copied
 * to a computer without the gazetteer still knows them.
 *
 * The link is by the text itself, compared without regard to upper and lower
 * case, not by a column on the event. Every event with the same text
 * therefore shares one link, an event whose place is retyped follows its new
 * text, and merging people or undoing an edit needs no care for places.
 * SQLite sets upper and lower case alike for the letters A to Z only: "York"
 * and "YORK" are one place, "Zürich" and "ZÜRICH" are two.
 *
 * A row is made only when the user links a text. A row whose text no event
 * uses any more stays; it does no harm and serves again when the text is
 * typed again.
 *
 * `geonames_id` may be NULL, for coordinates that come from somewhere else.
 * Nothing makes such rows yet.
 *
 * This migration writes no rows, so a tree that is upgraded and a tree that
 * is imported afresh are the same.
 */
const TABLES = `
  CREATE TABLE place (
    id          TEXT PRIMARY KEY NOT NULL,
    -- The place as typed in events.
    text        TEXT NOT NULL COLLATE NOCASE CHECK (text <> ''),
    geonames_id INTEGER,
    -- The gazetteer's own name for the place, written out in full.
    name        TEXT NOT NULL DEFAULT '',
    lat         REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         REAL NOT NULL CHECK (lon BETWEEN -180 AND 180),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX place_text ON place(text);

  -- The list of a tree's places groups its events by their text.
  CREATE INDEX event_place_text ON event(place_text COLLATE NOCASE) WHERE place_text <> '';
`;

export const places: Migration = {
  version: 8,
  name: 'places',
  up(db) {
    db.exec(TABLES);
    trackChanges(db, 'place');
  },
};
