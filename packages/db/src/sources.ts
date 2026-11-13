import {
  cleanCitationFields,
  cleanSourceFields,
  newId,
  parseFragment,
  rawLines,
  writeLines,
  type CitationFields,
  type SourceFields,
} from '@rulz/core';
import { sql } from './connection';
import { getGedcomSource, getStoredRecord } from './gedcom/store';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

/**
 * Sources and citations.
 *
 * A source is where information comes from: a census, a register, a book. A
 * citation is one place in a source, with what it says there, and it supports
 * one or more facts: a person or a family as a whole, an event, or a name.
 * A citation that supports nothing any more is removed by the database
 * itself (see schema/004-sources.ts).
 */

export interface Source extends SourceFields {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export type SourceInput = Partial<SourceFields>;

/** What a list shows for one source. */
export interface SourceSummary {
  id: string;
  title: string;
  author: string;
  abbreviation: string;
  /** How many citations of this source the tree has. */
  citations: number;
}

export interface Citation extends CitationFields {
  id: string;
  sourceId: string;
  createdAt: number;
  updatedAt: number;
}

export type CitationInput = Partial<CitationFields>;

export type CitationTargetType = 'person' | 'family' | 'event' | 'name';

/** The fact a citation supports. */
export interface CitationTarget {
  type: CitationTargetType;
  id: string;
}

/** A citation together with the title of its source, as a list of citations shows it. */
export interface CitedSource extends Citation {
  /** The source's title, or its short title when it has no other. May be empty. */
  sourceTitle: string;
}

/** A citation on a person's page, with the facts of that page it supports. */
export interface PersonCitation extends CitedSource {
  uses: CitationTarget[];
}

/** One fact a citation supports, with enough to say which fact it is. */
export interface CitationUse extends CitationTarget {
  /** "person", "family", "name", or the type of the event, e.g. "birth". */
  what: string;
  /** The people it concerns: the person, or the partners of the family. */
  personIds: string[];
}

/** A citation on a source's page, with every fact it supports. */
export interface SourceCitation extends Citation {
  uses: CitationUse[];
}

interface SourceRow extends SourceFields {
  id: string;
  created_at: number;
  updated_at: number;
}

interface CitationRow extends Omit<CitationFields, 'accessedAt'> {
  id: string;
  source_id: string;
  accessed_at: string;
  created_at: number;
  updated_at: number;
}

const SOURCE_COLUMNS =
  'id, title, author, publication, abbreviation, text, note, created_at, updated_at';
const CITATION_COLUMNS =
  'id, source_id, page, text, quality, note, url, accessed_at, created_at, updated_at';

const LINK_COLUMN = {
  person: 'person_id',
  family: 'family_id',
  event: 'event_id',
  name: 'name_id',
} as const;

const TARGET_TABLE = {
  person: 'person',
  family: 'family',
  event: 'event',
  name: 'person_name',
} as const;

function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    publication: row.publication,
    abbreviation: row.abbreviation,
    text: row.text,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCitation(row: CitationRow): Citation {
  return {
    id: row.id,
    sourceId: row.source_id,
    page: row.page,
    text: row.text,
    quality: row.quality,
    note: row.note,
    url: row.url,
    accessedAt: row.accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getSource(tree: Tree, id: string): Source | null {
  const row = sql(tree.db, `SELECT ${SOURCE_COLUMNS} FROM source WHERE id = ?`).get(id) as
    SourceRow | undefined;
  return row ? toSource(row) : null;
}

export function requireSource(tree: Tree, id: string): Source {
  const source = getSource(tree, id);
  if (!source) throw new NotFoundError('source', id);
  return source;
}

/** A source is known by its title, or by its short title when it has no other. */
function assertNamed(fields: SourceFields): void {
  if (fields.title === '' && fields.abbreviation === '') {
    throw new TreeRuleError('a source needs a title');
  }
}

function insertSource(tree: Tree, input: SourceInput, connectorId: string | null = null): Source {
  const fields = cleanSourceFields({
    title: input.title ?? '',
    author: input.author ?? '',
    publication: input.publication ?? '',
    abbreviation: input.abbreviation ?? '',
    text: input.text ?? '',
    note: input.note ?? '',
  });
  assertNamed(fields);
  const id = newId();
  const now = Date.now();
  sql(
    tree.db,
    `INSERT INTO source (${SOURCE_COLUMNS}, connector_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.title,
    fields.author,
    fields.publication,
    fields.abbreviation,
    fields.text,
    fields.note,
    now,
    now,
    connectorId,
  );
  return requireSource(tree, id);
}

export function createSource(tree: Tree, input: SourceInput): Source {
  return tree.transact('Add source', () => insertSource(tree, input));
}

/** Changes the given fields of a source. */
export function updateSource(tree: Tree, id: string, patch: SourceInput): Source {
  return tree.transact('Edit source', () => {
    const current = requireSource(tree, id);
    const fields = cleanSourceFields({
      title: patch.title ?? current.title,
      author: patch.author ?? current.author,
      publication: patch.publication ?? current.publication,
      abbreviation: patch.abbreviation ?? current.abbreviation,
      text: patch.text ?? current.text,
      note: patch.note ?? current.note,
    });
    assertNamed(fields);
    const unchanged = (Object.keys(fields) as (keyof SourceFields)[]).every(
      (field) => fields[field] === current[field],
    );
    if (unchanged) return current;
    sql(
      tree.db,
      `UPDATE source SET title = ?, author = ?, publication = ?, abbreviation = ?, text = ?,
         note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      fields.title,
      fields.author,
      fields.publication,
      fields.abbreviation,
      fields.text,
      fields.note,
      Date.now(),
      id,
    );
    return requireSource(tree, id);
  });
}

/** Deletes a source together with every citation of it. */
export function deleteSource(tree: Tree, id: string): void {
  tree.transact('Delete source', () => {
    requireSource(tree, id);
    sql(tree.db, 'DELETE FROM source WHERE id = ?').run(id);
  });
}

/** The text of a search box as a LIKE pattern that matches it anywhere, with `!` as the escape. */
function likePattern(query: string): string {
  return `%${query.trim().replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
}

const SOURCE_FILTER = `(@all = 1 OR title LIKE @like ESCAPE '!' OR author LIKE @like ESCAPE '!'
  OR abbreviation LIKE @like ESCAPE '!')`;

/** How many sources match what was typed; an empty `query` counts them all. */
export function countSources(tree: Tree, query = ''): number {
  return sql(tree.db, `SELECT count(*) FROM source WHERE ${SOURCE_FILTER}`)
    .pluck()
    .get({ all: query.trim() === '' ? 1 : 0, like: likePattern(query) }) as number;
}

/** Sources by title, with how often each is cited. `query` narrows them by title, author or short title. */
export function listSources(
  tree: Tree,
  options: { query?: string; offset?: number; limit?: number } = {},
): SourceSummary[] {
  const query = options.query ?? '';
  return sql(
    tree.db,
    `SELECT id, title, author, abbreviation,
            (SELECT count(*) FROM citation WHERE citation.source_id = source.id) AS citations
     FROM source WHERE ${SOURCE_FILTER}
     ORDER BY (CASE WHEN title = '' THEN abbreviation ELSE title END) COLLATE NOCASE, id
     LIMIT @limit OFFSET @offset`,
  ).all({
    all: query.trim() === '' ? 1 : 0,
    like: likePattern(query),
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  }) as SourceSummary[];
}

/**
 * The lines of a source's imported record that the app has no fields for
 * (its repository, notes, other programs' own tags), each with what is under
 * it, as written in the file. Empty for a source that was added in the app.
 */
export function keptLinesOfSource(tree: Tree, id: string): string[] {
  const stored = getStoredRecord(tree, id);
  const version = getGedcomSource(tree)?.version;
  if (!stored || stored.kind !== 'source' || version === undefined) return [];
  const record = parseFragment(stored.text, version)[0];
  if (!record) return [];
  const modelled = new Set(['TITL', 'AUTH', 'PUBL', 'ABBR', 'TEXT']);
  const seen = new Set<string>();
  return record.children
    .filter((child) => {
      // Only the first line of each kind is a field; a second one is kept as written.
      if (!modelled.has(child.tag) || seen.has(child.tag)) return true;
      seen.add(child.tag);
      return false;
    })
    .map((child) => (rawLines(child) ?? writeLines([child], 1, { version })).join('\n'));
}

function getCitation(tree: Tree, id: string): Citation | null {
  const row = sql(tree.db, `SELECT ${CITATION_COLUMNS} FROM citation WHERE id = ?`).get(id) as
    CitationRow | undefined;
  return row ? toCitation(row) : null;
}

export function requireCitation(tree: Tree, id: string): Citation {
  const citation = getCitation(tree, id);
  if (!citation) throw new NotFoundError('citation', id);
  return citation;
}

function requireTarget(tree: Tree, target: CitationTarget): void {
  const found = sql(tree.db, `SELECT 1 FROM ${TARGET_TABLE[target.type]} WHERE id = ?`).get(
    target.id,
  );
  if (found === undefined) throw new NotFoundError(target.type, target.id);
}

function isLinked(tree: Tree, citationId: string, target: CitationTarget): boolean {
  const column = LINK_COLUMN[target.type];
  return (
    sql(tree.db, `SELECT 1 FROM citation_link WHERE ${column} = ? AND citation_id = ?`).get(
      target.id,
      citationId,
    ) !== undefined
  );
}

function insertLink(tree: Tree, citationId: string, target: CitationTarget): void {
  const column = LINK_COLUMN[target.type];
  // One statement per kind of owner, so each uses that owner's index.
  const last = sql(tree.db, `SELECT max(sort_order) FROM citation_link WHERE ${column} = ?`)
    .pluck()
    .get(target.id) as number | null;
  sql(
    tree.db,
    `INSERT INTO citation_link (id, citation_id, ${column}, sort_order) VALUES (?, ?, ?, ?)`,
  ).run(newId(), citationId, target.id, (last ?? -1) + 1);
}

/** A site the app knows, and the source to make for it when the tree has none. */
export interface ConnectorSource {
  /** The site's id, as in its manifest. */
  id: string;
  create: SourceInput;
}

/**
 * The source a new citation is of: one that exists, one to make with it, or
 * the tree's one source for a site the app knows (`connector`).
 */
export type SourceRef =
  { sourceId: string } | { create: SourceInput } | { connector: ConnectorSource };

/**
 * The tree's source for a site the app knows; null when it has none yet. It
 * is the source marked with the site's id, whatever its title has been
 * changed to. A tree that came from a GEDCOM file has no marks, so there it
 * is the source with the site's title, the most cited one when there are
 * several.
 */
export function connectorSourceId(tree: Tree, connector: ConnectorSource): string | null {
  const marked = sql(tree.db, 'SELECT id FROM source WHERE connector_id = ?')
    .pluck()
    .get(connector.id) as string | undefined;
  if (marked !== undefined) return marked;
  // Not marked: the source this app made for the site, after it went through
  // a GEDCOM file, which keeps no mark. Title and publication must both be
  // the site's, so that a source of the user that only shares the title, and
  // may be about something else, is left alone.
  const { title, publication } = cleanSourceFields({
    title: connector.create.title ?? '',
    author: '',
    publication: connector.create.publication ?? '',
    abbreviation: '',
    text: '',
    note: '',
  });
  if (title === '' || publication === '') return null;
  const named = sql(
    tree.db,
    `SELECT id FROM source
     WHERE title = ? COLLATE NOCASE AND publication = ? COLLATE NOCASE AND connector_id IS NULL
     ORDER BY (SELECT count(*) FROM citation WHERE citation.source_id = source.id) DESC, id
     LIMIT 1`,
  )
    .pluck()
    .get(title, publication) as string | undefined;
  return named ?? null;
}

/** The id of the source a new citation is of. Call inside a change transaction. */
function resolveSource(tree: Tree, source: SourceRef): string {
  if ('sourceId' in source) return requireSource(tree, source.sourceId).id;
  if ('create' in source) return insertSource(tree, source.create).id;
  const marked = sql(tree.db, 'SELECT 1 FROM source WHERE connector_id = ?').get(
    source.connector.id,
  );
  const found = connectorSourceId(tree, source.connector);
  if (found === null) return insertSource(tree, source.connector.create, source.connector.id).id;
  // A source found by its title and publication is marked, so that it is still found after it is renamed.
  if (marked === undefined) {
    sql(tree.db, 'UPDATE source SET connector_id = ? WHERE id = ?').run(source.connector.id, found);
  }
  return found;
}

function insertCitation(tree: Tree, sourceId: string, input: CitationInput): string {
  const fields = cleanCitationFields({
    page: input.page ?? '',
    text: input.text ?? '',
    quality: input.quality ?? null,
    note: input.note ?? '',
    url: input.url ?? '',
    accessedAt: input.accessedAt ?? '',
  });
  const id = newId();
  const now = Date.now();
  sql(
    tree.db,
    `INSERT INTO citation (${CITATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    fields.page,
    fields.text,
    fields.quality,
    fields.note,
    fields.url,
    fields.accessedAt,
    now,
    now,
  );
  return id;
}

/**
 * Cites a source for a fact: makes a citation and links it to `target`. With
 * `create`, the source is made in the same step, so one Undo takes both back.
 */
export function addCitation(
  tree: Tree,
  target: CitationTarget,
  source: SourceRef,
  input: CitationInput = {},
): Citation {
  return tree.transact('Add citation', () => {
    requireTarget(tree, target);
    const id = insertCitation(tree, resolveSource(tree, source), input);
    insertLink(tree, id, target);
    return requireCitation(tree, id);
  });
}

/** The address as a citation holds it. */
function storedUrl(url: string): string {
  return cleanCitationFields({
    page: '',
    text: '',
    quality: null,
    note: '',
    url,
    accessedAt: '',
  }).url;
}

/**
 * The web addresses cited on a person's page: of the person as a whole, their
 * names and events, and their families. A record with one of these addresses
 * is attached already.
 */
export function citedUrls(tree: Tree, personId: string): Set<string> {
  return new Set(
    listPersonCitations(tree, personId)
      .map((citation) => citation.url)
      .filter((url) => url !== ''),
  );
}

/**
 * Cites a record of a site the app knows for a person as a whole: one step,
 * and one Undo. The record is known by its web address. When the person's
 * page already has a citation with that address, nothing is added and that
 * citation is returned, so a second click does no harm.
 */
export function attachRecord(
  tree: Tree,
  personId: string,
  connector: ConnectorSource,
  input: CitationInput & { url: string },
): { citation: Citation; added: boolean } {
  return tree.transact('Attach record', () => {
    requireTarget(tree, { type: 'person', id: personId });
    const url = storedUrl(input.url);
    if (url === '') throw new TreeRuleError('a record needs a web address to be attached');
    const existing = listPersonCitations(tree, personId).find((citation) => citation.url === url);
    if (existing) return { citation: existing, added: false };
    const id = insertCitation(tree, resolveSource(tree, { connector }), input);
    insertLink(tree, id, { type: 'person', id: personId });
    return { citation: requireCitation(tree, id), added: true };
  });
}

/** Changes the given fields of a citation, for every fact it supports. */
export function updateCitation(tree: Tree, id: string, patch: CitationInput): Citation {
  return tree.transact('Edit citation', () => {
    const current = requireCitation(tree, id);
    const fields = cleanCitationFields({
      page: patch.page ?? current.page,
      text: patch.text ?? current.text,
      quality: patch.quality === undefined ? current.quality : patch.quality,
      note: patch.note ?? current.note,
      url: patch.url ?? current.url,
      accessedAt: patch.accessedAt ?? current.accessedAt,
    });
    const unchanged =
      fields.page === current.page &&
      fields.text === current.text &&
      fields.quality === current.quality &&
      fields.note === current.note &&
      fields.url === current.url &&
      fields.accessedAt === current.accessedAt;
    if (unchanged) return current;
    sql(
      tree.db,
      `UPDATE citation SET page = ?, text = ?, quality = ?, note = ?, url = ?, accessed_at = ?,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      fields.page,
      fields.text,
      fields.quality,
      fields.note,
      fields.url,
      fields.accessedAt,
      Date.now(),
      id,
    );
    return requireCitation(tree, id);
  });
}

/** Deletes a citation, for every fact it supports. Its source stays. */
export function deleteCitation(tree: Tree, id: string): void {
  tree.transact('Delete citation', () => {
    requireCitation(tree, id);
    sql(tree.db, 'DELETE FROM citation WHERE id = ?').run(id);
  });
}

/** Uses a citation that exists for one more fact. Nothing happens when it already supports it. */
export function linkCitation(tree: Tree, citationId: string, target: CitationTarget): void {
  tree.transact('Add citation', () => {
    requireCitation(tree, citationId);
    requireTarget(tree, target);
    if (!isLinked(tree, citationId, target)) insertLink(tree, citationId, target);
  });
}

/**
 * Takes a citation away from one fact. When that was the last fact it
 * supported, the citation itself goes too.
 */
export function unlinkCitation(tree: Tree, citationId: string, target: CitationTarget): void {
  tree.transact('Remove citation', () => {
    requireCitation(tree, citationId);
    const column = LINK_COLUMN[target.type];
    sql(tree.db, `DELETE FROM citation_link WHERE ${column} = ? AND citation_id = ?`).run(
      target.id,
      citationId,
    );
  });
}

const CITED_COLUMNS = `c.id, c.source_id, c.page, c.text, c.quality, c.note, c.url,
  c.accessed_at, c.created_at, c.updated_at, (CASE WHEN s.title = '' THEN s.abbreviation ELSE s.title END) AS source_title`;

type CitedRow = CitationRow & { source_title: string };

function toCited(row: CitedRow): CitedSource {
  return { ...toCitation(row), sourceTitle: row.source_title };
}

/** The citations that support one fact, in the order they were added to it. */
export function listCitations(tree: Tree, target: CitationTarget): CitedSource[] {
  const column = LINK_COLUMN[target.type];
  const rows = sql(
    tree.db,
    `SELECT ${CITED_COLUMNS}
     FROM citation_link cl JOIN citation c ON c.id = cl.citation_id
       JOIN source s ON s.id = c.source_id
     WHERE cl.${column} = ? ORDER BY cl.sort_order, cl.id`,
  ).all(target.id) as CitedRow[];
  return rows.map(toCited);
}

/**
 * Every citation on a person's page: those of the person as a whole, of their
 * names and events, and of the families they are a partner in with those
 * families' events. Each comes once, with the facts of the page it supports.
 */
export function listPersonCitations(tree: Tree, personId: string): PersonCitation[] {
  const db = tree.db;
  type Use = { citation_id: string; target: string };
  const uses: { citationId: string; type: CitationTargetType; id: string }[] = [];
  const collect = (type: CitationTargetType, text: string) => {
    for (const row of sql(db, text).all(personId) as Use[]) {
      uses.push({ citationId: row.citation_id, type, id: row.target });
    }
  };
  collect(
    'person',
    `SELECT citation_id, person_id AS target FROM citation_link
     WHERE person_id = ? ORDER BY sort_order, id`,
  );
  collect(
    'name',
    `SELECT cl.citation_id, cl.name_id AS target
     FROM person_name n JOIN citation_link cl ON cl.name_id = n.id
     WHERE n.person_id = ? ORDER BY n.is_primary DESC, n.sort_order, cl.sort_order, cl.id`,
  );
  collect(
    'event',
    `SELECT cl.citation_id, cl.event_id AS target
     FROM event_participant ep JOIN citation_link cl ON cl.event_id = ep.event_id
     WHERE ep.person_id = ? ORDER BY ep.sort_order, cl.sort_order, cl.id`,
  );
  // One statement per partner place, so each uses that column's index.
  for (const place of ['partner1_id', 'partner2_id'] as const) {
    collect(
      'family',
      `SELECT cl.citation_id, cl.family_id AS target
       FROM family f JOIN citation_link cl ON cl.family_id = f.id
       WHERE f.${place} = ? ORDER BY f.id, cl.sort_order, cl.id`,
    );
    collect(
      'event',
      `SELECT cl.citation_id, cl.event_id AS target
       FROM family f JOIN event_participant ep ON ep.family_id = f.id
         JOIN citation_link cl ON cl.event_id = ep.event_id
       WHERE f.${place} = ? ORDER BY f.id, ep.sort_order, cl.sort_order, cl.id`,
    );
  }

  const byId = new Map<string, PersonCitation>();
  const read = sql(
    db,
    `SELECT ${CITED_COLUMNS} FROM citation c JOIN source s ON s.id = c.source_id WHERE c.id = ?`,
  );
  for (const use of uses) {
    let citation = byId.get(use.citationId);
    if (!citation) {
      const row = read.get(use.citationId) as CitedRow | undefined;
      if (!row) continue;
      citation = { ...toCited(row), uses: [] };
      byId.set(use.citationId, citation);
    }
    citation.uses.push({ type: use.type, id: use.id });
  }
  return [...byId.values()];
}

/** How many citations a source has. */
export function countSourceCitations(tree: Tree, sourceId: string): number {
  return sql(tree.db, 'SELECT count(*) FROM citation WHERE source_id = ?')
    .pluck()
    .get(sourceId) as number;
}

function partnersOf(tree: Tree, familyId: string): string[] {
  const family = sql(tree.db, 'SELECT partner1_id, partner2_id FROM family WHERE id = ?').get(
    familyId,
  ) as { partner1_id: string | null; partner2_id: string | null } | undefined;
  return [family?.partner1_id ?? null, family?.partner2_id ?? null].filter((id) => id !== null);
}

/** Every fact a citation supports, with who it concerns. */
export function listCitationUses(tree: Tree, citationId: string): CitationUse[] {
  const db = tree.db;
  const links = sql(
    db,
    `SELECT person_id, family_id, event_id, name_id FROM citation_link
     WHERE citation_id = ? ORDER BY id`,
  ).all(citationId) as {
    person_id: string | null;
    family_id: string | null;
    event_id: string | null;
    name_id: string | null;
  }[];
  return links.map((link): CitationUse => {
    if (link.person_id !== null) {
      return { type: 'person', id: link.person_id, what: 'person', personIds: [link.person_id] };
    }
    if (link.family_id !== null) {
      return {
        type: 'family',
        id: link.family_id,
        what: 'family',
        personIds: partnersOf(tree, link.family_id),
      };
    }
    if (link.name_id !== null) {
      const personId = sql(db, 'SELECT person_id FROM person_name WHERE id = ?')
        .pluck()
        .get(link.name_id) as string | undefined;
      return {
        type: 'name',
        id: link.name_id,
        what: 'name',
        personIds: personId === undefined ? [] : [personId],
      };
    }
    const eventId = link.event_id ?? '';
    const type = sql(db, 'SELECT type FROM event WHERE id = ?').pluck().get(eventId) as
      string | undefined;
    const owners = sql(
      db,
      'SELECT person_id, family_id FROM event_participant WHERE event_id = ? ORDER BY sort_order, id',
    ).all(eventId) as { person_id: string | null; family_id: string | null }[];
    const personIds = owners.flatMap((owner) =>
      owner.person_id !== null
        ? [owner.person_id]
        : owner.family_id !== null
          ? partnersOf(tree, owner.family_id)
          : [],
    );
    return {
      type: 'event',
      id: eventId,
      what: type ?? 'event',
      personIds: [...new Set(personIds)],
    };
  });
}

/** A source's citations by what they say of the place in the source, each with the facts it supports. */
export function listSourceCitations(
  tree: Tree,
  sourceId: string,
  options: { offset?: number; limit?: number } = {},
): SourceCitation[] {
  const rows = sql(
    tree.db,
    `SELECT ${CITATION_COLUMNS} FROM citation WHERE source_id = ?
     ORDER BY page COLLATE NOCASE, id LIMIT ? OFFSET ?`,
  ).all(sourceId, options.limit ?? 50, options.offset ?? 0) as CitationRow[];
  return rows.map((row) => ({ ...toCitation(row), uses: listCitationUses(tree, row.id) }));
}
