import {
  citationKey,
  citedSource,
  newId,
  parseFragment,
  readCitation,
  readSource,
  type GedcomNode,
  type GedcomVersion,
} from '@rulz/core';
import { sql, type Db } from '../connection';
import { GEDCOM_META, type StoredPart } from './store';

/**
 * Turns the source citations of a GEDCOM file into rows: used by the import,
 * and by the migration that gave sources their own tables, which does the
 * same for trees imported before it.
 *
 * Nothing here goes through a `Tree`: an import and a migration both write
 * without the change log.
 */

/** What a citation supports: a person or family as a whole, one event, or one name. */
export type CitationOwner =
  { person: string } | { family: string } | { event: string } | { name: string };

type LinkColumn = 'person_id' | 'family_id' | 'event_id' | 'name_id';

function ownerColumn(owner: CitationOwner): [LinkColumn, string] {
  if ('person' in owner) return ['person_id', owner.person];
  if ('family' in owner) return ['family_id', owner.family];
  if ('event' in owner) return ['event_id', owner.event];
  return ['name_id', owner.name];
}

/**
 * Makes citations from SOUR lines as they are met.
 *
 * Ancestry and other programs write a citation out again under every fact it
 * supports. Lines that cite the same source in exactly the same words become
 * one citation with several links, so it is shown once and edited once.
 */
export class CitationLoader {
  readonly #db: Db;
  readonly #sources: ReadonlyMap<string, string>;
  readonly #now: number;
  /** The citation for each source and wording met so far. */
  readonly #byKey = new Map<string, string>();
  /** "owner id|citation id" for every link made. */
  readonly #linked = new Set<string>();
  /** How many citations each owner has so far. */
  readonly #count = new Map<string, number>();
  /** How many citations were made. */
  citations = 0;
  /** How many links to people, families, events and names were made. */
  links = 0;

  /** `sources` gives the id of each source by its cross-reference id in the file. */
  constructor(db: Db, sources: ReadonlyMap<string, string>, now: number) {
    this.#db = db;
    this.#sources = sources;
    this.#now = now;
  }

  /**
   * Makes the citation a SOUR line stands for and links it to `owner`.
   * Returns the citation's id, or null for a line that is kept as written: a
   * line that names no source record of the file, or the second of two equal
   * citations of one fact.
   */
  cite(node: GedcomNode, owner: CitationOwner): string | null {
    const xref = citedSource(node);
    const sourceId = xref === null ? undefined : this.#sources.get(xref);
    if (sourceId === undefined) return null;

    const [column, ownerId] = ownerColumn(owner);
    const key = `${sourceId}\n${citationKey(node)}`;
    let id = this.#byKey.get(key);
    if (id !== undefined && this.#linked.has(`${ownerId}|${id}`)) return null;

    if (id === undefined) {
      id = newId();
      const fields = readCitation(node);
      sql(
        this.#db,
        `INSERT INTO citation (id, source_id, page, text, quality, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sourceId,
        fields.page,
        fields.text,
        fields.quality,
        fields.note,
        this.#now,
        this.#now,
      );
      this.#byKey.set(key, id);
      this.citations += 1;
    }

    const order = this.#count.get(ownerId) ?? 0;
    this.#count.set(ownerId, order + 1);
    // One statement per kind of owner; the column name is one of four fixed words.
    sql(
      this.#db,
      `INSERT INTO citation_link (id, citation_id, ${column}, sort_order) VALUES (?, ?, ?, ?)`,
    ).run(newId(), id, ownerId, order);
    this.#linked.add(`${ownerId}|${id}`);
    this.links += 1;
    return id;
  }

  /**
   * Does the same for every SOUR line directly under a name or an event.
   * Returns one entry per such line, or undefined when none became a citation.
   */
  citeChildren(node: GedcomNode, owner: CitationOwner): (string | null)[] | undefined {
    let found = false;
    const ids: (string | null)[] = [];
    for (const child of node.children) {
      if (child.tag !== 'SOUR') continue;
      const id = this.cite(child, owner);
      if (id !== null) found = true;
      ids.push(id);
    }
    return found ? ids : undefined;
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

const SOUR_LINE = /^\s*\d+\s+SOUR(?:\s|$)/i;
const SOUR_BELOW = /\n\s*\d+\s+SOUR(?:\s|$)/i;

/**
 * Gives the sources and citations of a tree that was imported before sources
 * had tables of their own the same rows a fresh import of the file would make.
 * Until then the source records were kept as written, and so were the lines
 * citing them. The stored lines themselves are not changed; each is only
 * marked with the source or citation it became.
 *
 * A tree that was not imported has nothing to do. A person or family that has
 * been deleted since the import is left alone, and its lines stay as they
 * were if the deletion is undone later.
 */
export function extractSources(db: Db): void {
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

  // 1. Source records.
  const sources = new Map<string, string>();
  const insertSource = db.prepare(
    `INSERT INTO source (id, title, author, publication, abbreviation, text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markSource = db.prepare("UPDATE gedcom_record SET kind = 'source' WHERE id = ?");
  for (const row of rows) {
    if (row.kind !== 'kept' || row.tag !== 'SOUR' || row.xref === null) continue;
    const node = parseFragment(row.text, version)[0];
    if (!node) continue;
    const fields = readSource(node);
    insertSource.run(
      row.id,
      fields.title,
      fields.author,
      fields.publication,
      fields.abbreviation,
      fields.text,
      now,
      now,
    );
    markSource.run(row.id);
    sources.set(row.xref, row.id);
  }
  if (sources.size === 0) return;

  // 2. The lines that cite them.
  const exists = {
    person: db.prepare('SELECT 1 FROM person WHERE id = ?'),
    family: db.prepare('SELECT 1 FROM family WHERE id = ?'),
    name: db.prepare('SELECT 1 FROM person_name WHERE id = ?'),
    event: db.prepare('SELECT 1 FROM event WHERE id = ?'),
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

  const loader = new CitationLoader(db, sources, now);
  const saveParts = db.prepare('UPDATE gedcom_record SET parts = ? WHERE id = ?');
  for (const row of rows) {
    if ((row.kind !== 'person' && row.kind !== 'family') || row.parts === null) continue;
    const ownerId = ownerOf(row.kind, row.id);
    const parts = JSON.parse(row.parts) as StoredPart[];
    let changed = false;

    for (const part of parts) {
      if (part.k === undefined) {
        if (ownerId === null || !SOUR_LINE.test(part.t)) continue;
        const node = parseFragment(part.t, version)[0];
        if (!node) continue;
        const owner = row.kind === 'person' ? { person: ownerId } : { family: ownerId };
        const id = loader.cite(node, owner);
        if (id !== null) {
          part.k = 'citation';
          part.r = id;
          changed = true;
        }
      } else if ((part.k === 'name' || part.k === 'event') && part.r !== undefined) {
        if (!SOUR_BELOW.test(part.t) || exists[part.k].get(part.r) === undefined) continue;
        const node = parseFragment(part.t, version)[0];
        if (!node) continue;
        const cites = loader.citeChildren(
          node,
          part.k === 'name' ? { name: part.r } : { event: part.r },
        );
        if (cites !== undefined) {
          part.c = cites;
          changed = true;
        }
      }
    }
    if (changed) saveParts.run(JSON.stringify(parts), row.id);
  }
}
