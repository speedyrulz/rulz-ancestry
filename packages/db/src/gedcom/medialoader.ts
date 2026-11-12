import {
  embeddedMediaKey,
  isEmbeddedMedia,
  mediaPointer,
  mediaTypeFromFormat,
  newId,
  parseFragment,
  readMediaRecord,
  referenceFileName,
  type GedcomNode,
  type GedcomVersion,
  type MediaRecordFields,
} from '@rulz/core';
import { sql, type Db } from '../connection';
import { GEDCOM_META, type StoredPart } from './store';

/**
 * Turns the pictures and documents a GEDCOM file names into rows: used by the
 * import, and by the migration that gave them rows, which does the same for
 * trees imported before it.
 *
 * Nothing here goes through a `Tree`: an import and a migration both write
 * without the change log.
 */

/** What a file is attached to. */
export type MediaOwner =
  | { person: string }
  | { family: string }
  | { event: string }
  | { citation: string }
  | { source: string };

type LinkColumn = 'person_id' | 'family_id' | 'event_id' | 'citation_id' | 'source_id';

function ownerColumn(owner: MediaOwner): [LinkColumn, string] {
  if ('person' in owner) return ['person_id', owner.person];
  if ('family' in owner) return ['family_id', owner.family];
  if ('event' in owner) return ['event_id', owner.event];
  if ('citation' in owner) return ['citation_id', owner.citation];
  return ['source_id', owner.source];
}

/**
 * Makes the row for a file that a GEDCOM file names. The tree does not hold
 * the file yet, so the row has no hash; what kind of file it is, is taken
 * from what the GEDCOM file says.
 */
export function insertNamedMedia(db: Db, id: string, fields: MediaRecordFields, now: number): void {
  const fileName = referenceFileName(fields.file);
  const type = mediaTypeFromFormat(fields.format, fileName);
  sql(
    db,
    `INSERT INTO media (id, sha256, ext, mime, size, file_name, title, description, origin,
       created_at, updated_at)
     VALUES (?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, type.ext, type.mime, fileName, fields.title, fields.description, fields.file, now, now);
}

/**
 * Attaches files from OBJE lines as they are met.
 *
 * A line either points at a media record or describes a file in place. Many
 * programs write the same description out again under every person on a
 * photograph; descriptions that say the same in the same words become one
 * file with several links.
 */
export class MediaLoader {
  readonly #db: Db;
  readonly #records: ReadonlyMap<string, string>;
  readonly #now: number;
  readonly #after: boolean;
  /** The file for each wording of a media item written in place. */
  readonly #byKey = new Map<string, string>();
  /** "owner id|media id" for every link made. */
  readonly #linked = new Set<string>();
  /** How many files each owner has so far. */
  readonly #count = new Map<string, number>();
  /** The files made from media items written in place, with where each is said to be. */
  readonly embedded: { id: string; file: string }[] = [];
  /** How many links to people, families, events, citations and sources were made. */
  links = 0;

  /**
   * `records` gives the id of each media record's file by the record's
   * cross-reference id. With `afterExisting`, a link goes after the files its
   * owner already has; a migration asks for that, because a tree may have had
   * files attached in the app since it was imported.
   */
  constructor(db: Db, records: ReadonlyMap<string, string>, now: number, afterExisting = false) {
    this.#db = db;
    this.#records = records;
    this.#now = now;
    this.#after = afterExisting;
  }

  /** The file an OBJE line stands for, or null for a line that is kept as written. */
  #mediaOf(node: GedcomNode): string | null {
    const xref = mediaPointer(node);
    if (xref !== null) return this.#records.get(xref) ?? null;
    if (!isEmbeddedMedia(node)) return null;
    const key = embeddedMediaKey(node);
    let id = this.#byKey.get(key);
    if (id === undefined) {
      id = newId();
      const fields = readMediaRecord(node);
      insertNamedMedia(this.#db, id, fields, this.#now);
      sql(this.#db, 'INSERT INTO gedcom_media (media_id, key) VALUES (?, ?)').run(id, key);
      this.#byKey.set(key, id);
      this.embedded.push({ id, file: fields.file });
    }
    return id;
  }

  #nextOrder(column: LinkColumn, ownerId: string): number {
    let order = this.#count.get(ownerId);
    if (order === undefined) {
      order = 0;
      if (this.#after) {
        const last = sql(this.#db, `SELECT max(sort_order) FROM media_link WHERE ${column} = ?`)
          .pluck()
          .get(ownerId) as number | null;
        order = (last ?? -1) + 1;
      }
    }
    this.#count.set(ownerId, order + 1);
    return order;
  }

  /**
   * Attaches the file an OBJE line stands for to `owner`. Returns the file's
   * id, or null for a line that is kept as written: one that points at no
   * media record of the file, or that names no file. A second line for a file
   * the owner has already is the same file, and makes no second link.
   */
  attach(node: GedcomNode, owner: MediaOwner): string | null {
    const id = this.#mediaOf(node);
    if (id === null) return null;
    const [column, ownerId] = ownerColumn(owner);
    const key = `${ownerId}|${id}`;
    if (!this.#linked.has(key)) {
      // One statement per kind of owner; the column name is one of five fixed words.
      sql(
        this.#db,
        `INSERT INTO media_link (id, media_id, ${column}, sort_order) VALUES (?, ?, ?, ?)`,
      ).run(newId(), id, ownerId, this.#nextOrder(column, ownerId));
      this.#linked.add(key);
      this.links += 1;
    }
    return id;
  }

  /** Does the same for every OBJE line directly under an event, a citation or a source record. */
  attachChildren(node: GedcomNode, owner: MediaOwner): void {
    for (const child of node.children) {
      if (child.tag === 'OBJE') this.attach(child, owner);
    }
  }

  /**
   * Attaches the files under the citations of a name or an event. `cites`
   * gives the citation each SOUR line under it became (see `StoredPart.c`).
   */
  attachUnderCitations(node: GedcomNode, cites: readonly (string | null)[]): void {
    let place = -1;
    for (const child of node.children) {
      if (child.tag !== 'SOUR') continue;
      place += 1;
      const citationId = cites[place] ?? null;
      if (citationId !== null) this.attachChildren(child, { citation: citationId });
    }
  }
}

interface RecordRow {
  id: string;
  tag: string;
  xref: string | null;
  kind: string;
  text: string;
  parts: string | null;
}

const OBJE_LINE = /^\s*\d+\s+OBJE(?:\s|$)/i;
const OBJE_ANYWHERE = /(?:^|\n)\s*\d+\s+OBJE(?:\s|$)/i;

/**
 * Gives the pictures and documents of a tree that was imported before they
 * had rows the same rows a fresh import of the file would make. Until then
 * the media records were kept as written, and so were the lines that point at
 * them and the media items written in place. The stored lines themselves are
 * not changed; a record and a line directly under a person or a family are
 * only marked with the file they became.
 *
 * A tree that was not imported has nothing to do. A person, family, event,
 * citation or source that has been deleted since the import is left alone.
 */
export function extractMedia(db: Db): void {
  const versionText = db
    .prepare('SELECT value FROM tree_meta WHERE key = ?')
    .pluck()
    .get(GEDCOM_META.version) as string | undefined;
  if (versionText !== '5.5.1' && versionText !== '7.0') return;
  const version: GedcomVersion = versionText;
  const now = Date.now();

  const rows = db
    .prepare('SELECT id, tag, xref, kind, text, parts FROM gedcom_record ORDER BY position, id')
    .all() as RecordRow[];

  // 1. Media records.
  const records = new Map<string, string>();
  const markMedia = db.prepare("UPDATE gedcom_record SET kind = 'media' WHERE id = ?");
  for (const row of rows) {
    if (row.kind !== 'kept' || row.tag !== 'OBJE' || row.xref === null) continue;
    const node = parseFragment(row.text, version)[0];
    if (!node) continue;
    insertNamedMedia(db, row.id, readMediaRecord(node), now);
    markMedia.run(row.id);
    records.set(row.xref, row.id);
  }

  const exists = {
    person: db.prepare('SELECT 1 FROM person WHERE id = ?'),
    family: db.prepare('SELECT 1 FROM family WHERE id = ?'),
    event: db.prepare('SELECT 1 FROM event WHERE id = ?'),
    citation: db.prepare('SELECT 1 FROM citation WHERE id = ?'),
    source: db.prepare('SELECT 1 FROM source WHERE id = ?'),
  };
  const mergedInto = new Map(
    (
      db.prepare('SELECT id, into_id FROM merged_record').all() as { id: string; into_id: string }[]
    ).map((row) => [row.id, row.into_id]),
  );
  /** The person or family a record stands for today: itself, or the one it was merged into. */
  const ownerOf = (kind: 'person' | 'family', recordId: string): string | null => {
    let id = recordId;
    for (let hops = 0; hops < 100; hops += 1) {
      if (exists[kind].get(id) !== undefined) return id;
      const next = mergedInto.get(id);
      if (next === undefined) return null;
      id = next;
    }
    return null;
  };

  const loader = new MediaLoader(db, records, now, true);

  // 2. The files of sources.
  for (const row of rows) {
    if (row.kind !== 'source' || !OBJE_ANYWHERE.test(row.text)) continue;
    if (exists.source.get(row.id) === undefined) continue;
    const node = parseFragment(row.text, version)[0];
    if (node) loader.attachChildren(node, { source: row.id });
  }

  // 3. The files of people and families, of their events, and of the citations of all of those.
  const saveParts = db.prepare('UPDATE gedcom_record SET parts = ? WHERE id = ?');
  for (const row of rows) {
    if ((row.kind !== 'person' && row.kind !== 'family') || row.parts === null) continue;
    if (!/\bOBJE\b/i.test(row.parts)) continue;
    const ownerId = ownerOf(row.kind, row.id);
    const parts = JSON.parse(row.parts) as StoredPart[];
    let changed = false;

    for (const part of parts) {
      if (!OBJE_ANYWHERE.test(part.t)) continue;
      if (part.k === undefined) {
        if (ownerId === null || !OBJE_LINE.test(part.t)) continue;
        const node = parseFragment(part.t, version)[0];
        if (!node) continue;
        const owner = row.kind === 'person' ? { person: ownerId } : { family: ownerId };
        const id = loader.attach(node, owner);
        if (id !== null) {
          part.k = 'media';
          part.r = id;
          changed = true;
        }
        continue;
      }
      if (part.r === undefined) continue;
      if (part.k === 'citation') {
        if (exists.citation.get(part.r) === undefined) continue;
        const node = parseFragment(part.t, version)[0];
        if (node) loader.attachChildren(node, { citation: part.r });
      } else if (part.k === 'name' || part.k === 'event') {
        const node = parseFragment(part.t, version)[0];
        if (!node) continue;
        if (part.c !== undefined) {
          // A citation that has gone since the import has no row to attach to.
          const cites = part.c.map((id) =>
            id !== null && exists.citation.get(id) !== undefined ? id : null,
          );
          loader.attachUnderCitations(node, cites);
        }
        if (part.k === 'event' && exists.event.get(part.r) !== undefined) {
          loader.attachChildren(node, { event: part.r });
        }
      }
    }
    if (changed) saveParts.run(JSON.stringify(parts), row.id);
  }
}
