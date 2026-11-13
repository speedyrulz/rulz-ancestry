import { cleanNote, isOwnNote, parseFragment, readOwnNote, type GedcomVersion } from '@rulz/core';
import type { Db } from '../connection';
import { GEDCOM_META, type StoredPart } from './store';

/**
 * Gives trees imported before notes were fields the notes their file had, as
 * a fresh import of the same file would: the note of each person, each event
 * and each source. Until then those notes were lines kept as written.
 *
 * Only a person who is still in the tree is given their note. The record of a
 * person who was merged into another keeps its NOTE line as written, so that
 * it still goes along with the person who is left.
 */
export function extractNotes(db: Db): void {
  const versionText = db
    .prepare('SELECT value FROM tree_meta WHERE key = ?')
    .pluck()
    .get(GEDCOM_META.version) as string | undefined;
  if (versionText !== '5.5.1' && versionText !== '7.0') return;
  const version: GedcomVersion = versionText;

  const rows = db
    .prepare(
      "SELECT id, kind, text, parts FROM gedcom_record WHERE kind IN ('person', 'family', 'source')",
    )
    .all() as { id: string; kind: string; text: string; parts: string | null }[];
  const personExists = db.prepare('SELECT 1 FROM person WHERE id = ?');
  const setPersonNote = db.prepare('UPDATE person SET note = ? WHERE id = ?');
  const setEventNote = db.prepare('UPDATE event SET note = ? WHERE id = ?');
  const setSourceNote = db.prepare('UPDATE source SET note = ? WHERE id = ?');
  const setParts = db.prepare('UPDATE gedcom_record SET parts = ? WHERE id = ?');
  // An event or a source that was deleted or changed before this version is
  // in the change log without its note. Undo would bring it back without one,
  // and the export would then take the NOTE line away. So the note is written
  // into those entries too.
  const logBefore = db.prepare(
    `UPDATE change_log SET before_json = json_set(before_json, '$.note', ?)
     WHERE entity_type = ? AND entity_id = ? AND before_json IS NOT NULL`,
  );
  const logAfter = db.prepare(
    `UPDATE change_log SET after_json = json_set(after_json, '$.note', ?)
     WHERE entity_type = ? AND entity_id = ? AND after_json IS NOT NULL`,
  );
  const inLog = (table: 'event' | 'source', id: string, note: string): void => {
    logBefore.run(note, table, id);
    logAfter.run(note, table, id);
  };

  for (const row of rows) {
    if (row.kind === 'source') {
      // Only records with a NOTE line are worth reading.
      if (!row.text.includes('NOTE')) continue;
      const node = parseFragment(row.text, version)[0];
      const note = node ? readOwnNote(node) : '';
      if (note !== '') {
        setSourceNote.run(note, row.id);
        inLog('source', row.id, note);
      }
      continue;
    }
    if (row.parts === null || !row.parts.includes('NOTE')) continue;
    const parts = JSON.parse(row.parts) as StoredPart[];
    let marked = false;
    let seen = false;
    for (const part of parts) {
      if (!part.t.includes('NOTE')) continue;
      if (part.k === 'event' && part.r !== undefined) {
        const node = parseFragment(part.t, version)[0];
        const note = node ? readOwnNote(node) : '';
        if (note !== '') {
          setEventNote.run(note, part.r);
          inLog('event', part.r, note);
        }
      } else if (part.k === undefined && row.kind === 'person' && !seen) {
        const node = parseFragment(part.t, version)[0];
        if (!node || !isOwnNote(node)) continue;
        seen = true;
        // The record of someone who is not in the tree keeps its line as written.
        if (personExists.get(row.id) === undefined) continue;
        setPersonNote.run(cleanNote(node.value), row.id);
        part.k = 'note';
        marked = true;
      }
    }
    if (marked) setParts.run(JSON.stringify(parts), row.id);
  }
}
