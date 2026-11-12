import {
  CITATION_LIMITS,
  NAME_TYPES,
  PEDIGREES,
  SEXES,
  SOURCE_LIMITS,
  kinshipTerm,
  relationshipTerm,
} from '@rulz/core';
import {
  BackupError,
  GedcomFileError,
  NoTreeError,
  NotATreeError,
  NotFoundError,
  SchemaTooNewError,
  TreeLocationError,
  TreeRuleError,
  addChildOf,
  addCitation,
  addFamilyEvent,
  addName,
  addParent,
  addPartner,
  addPersonEvent,
  addPersonFromDraft,
  countPersons,
  countSearchPersons,
  countSourceCitations,
  countSources,
  createSource,
  deleteCitation,
  deleteEvent,
  deleteName,
  deletePerson,
  deleteSource,
  findDuplicates,
  findRelationship,
  getChartData,
  getPersonPage,
  getPersonSummary,
  getSource,
  keptLinesOf,
  keptLinesOfSource,
  linkCitation,
  listPersons,
  listSourceCitations,
  listSources,
  markNotDuplicate,
  mergePersons,
  presumedLivingIds,
  searchPersons,
  setChildPedigree,
  setPrimaryName,
  unlinkChild,
  unlinkCitation,
  unlinkPartner,
  updateCitation,
  updateEvent,
  updateName,
  updatePerson,
  updateSource,
  type Tree,
} from '@rulz/db';
import { z } from 'zod';
import type {
  ApiMethod,
  AppInfo,
  IpcError,
  PersonChange,
  PersonSummary,
  RulzApi,
  TreeState,
} from '../shared/ipc';
import { NoOpenTreeError, SessionError, type TreeSession } from './session';

/**
 * What each function of the IPC contract does. Every argument arrives from the
 * page, so each function first checks its arguments against a schema; nothing
 * unchecked reaches the database layer.
 *
 * Nothing here uses Electron. The few things that need it (the folder picker,
 * File Explorer, the app's version details) come in through {@link Platform}.
 */

export interface FolderPickerOptions {
  title: string;
  buttonLabel: string;
  defaultPath: string;
}

export interface FilePickerOptions {
  title: string;
  buttonLabel: string;
  /** The folder the dialog starts in, or the file it suggests. */
  defaultPath: string;
  /** The kinds of file offered, e.g. `{ name: 'GEDCOM files', extensions: ['ged'] }`. */
  filters: { name: string; extensions: string[] }[];
}

export interface Platform {
  appInfo(): AppInfo;
  /** Shows the system folder picker. Resolves to null when the user cancels. */
  chooseFolder(options: FolderPickerOptions): Promise<string | null>;
  /** Shows the system dialog for opening one file. Resolves to null when the user cancels. */
  chooseFileToOpen(options: FilePickerOptions): Promise<string | null>;
  /** Shows the system dialog for saving a file. Resolves to null when the user cancels. */
  chooseFileToSave(options: FilePickerOptions): Promise<string | null>;
  /** Shows a folder in File Explorer. */
  openFolder(dir: string): Promise<void>;
}

type Args<K extends ApiMethod> = Parameters<RulzApi[K]>;
type Result<K extends ApiMethod> = Awaited<ReturnType<RulzApi[K]>>;
type Handler<K extends ApiMethod> = (...raw: unknown[]) => Result<K> | Promise<Result<K>>;

export type ApiHandlers = { [K in ApiMethod]: Handler<K> };

/**
 * Removes object keys whose value is `undefined`. A form that leaves a field
 * out may still send the key, and the schemas treat a key that is present as
 * one that must hold a value.
 */
function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, dropUndefined(entry)]),
  );
}

function define<K extends ApiMethod>(
  schema: z.ZodType<Args<K>>,
  run: (...args: Args<K>) => Result<K> | Promise<Result<K>>,
): Handler<K> {
  return (...raw) => run(...schema.parse(dropUndefined(raw)));
}

const text = (max: number) => z.string().max(max);
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sex = z.enum(SEXES);
const pedigree = z.enum(PEDIGREES);
const living = z.boolean().nullable();
const none = z.tuple([]);

const draft = z.strictObject({
  given: text(200).exactOptional(),
  surname: text(200).exactOptional(),
  sex: sex.exactOptional(),
  living: living.exactOptional(),
  birthDate: text(200).exactOptional(),
  birthPlace: text(500).exactOptional(),
  deathDate: text(200).exactOptional(),
  deathPlace: text(500).exactOptional(),
});

const personRef = z.union([z.strictObject({ existingId: id }), z.strictObject({ create: draft })]);

const nameFields = {
  type: z.enum(NAME_TYPES).exactOptional(),
  prefix: text(100).exactOptional(),
  given: text(200).exactOptional(),
  nickname: text(100).exactOptional(),
  surname: text(200).exactOptional(),
  suffix: text(100).exactOptional(),
};

const eventInput = z.strictObject({
  type: text(60).min(1),
  date: text(200).exactOptional(),
  place: text(500).exactOptional(),
  description: text(5000).exactOptional(),
});

const sourceInput = z.strictObject({
  title: text(SOURCE_LIMITS.title).exactOptional(),
  author: text(SOURCE_LIMITS.author).exactOptional(),
  publication: text(SOURCE_LIMITS.publication).exactOptional(),
  abbreviation: text(SOURCE_LIMITS.abbreviation).exactOptional(),
  text: text(SOURCE_LIMITS.text).exactOptional(),
});

const citationInput = z.strictObject({
  page: text(CITATION_LIMITS.page).exactOptional(),
  text: text(CITATION_LIMITS.text).exactOptional(),
  quality: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .exactOptional(),
  note: text(CITATION_LIMITS.note).exactOptional(),
});

const citationTarget = z.strictObject({
  type: z.enum(['person', 'family', 'event', 'name']),
  id,
});

const sourceRef = z.union([
  z.strictObject({ sourceId: id }),
  z.strictObject({ create: sourceInput }),
]);

/** What the file dialogs for import and export offer. */
const GEDCOM_FILTERS = [
  { name: 'GEDCOM files', extensions: ['ged'] },
  { name: 'All files', extensions: ['*'] },
];

const familyOption = z.strictObject({ familyId: id.exactOptional() });
const childOptions = z.strictObject({
  familyId: id.exactOptional(),
  pedigree: pedigree.exactOptional(),
});

export function createHandlers(session: TreeSession, platform: Platform): ApiHandlers {
  /** Runs an edit and returns the tree's new state. */
  const edit = (run: (tree: Tree) => unknown): TreeState => {
    session.change(run);
    return session.state();
  };
  /** Runs an edit that adds or links a person, and says who. */
  const link = (run: (tree: Tree) => { personId: string }): PersonChange => {
    const { personId } = session.change(run);
    return { tree: session.state(), personId };
  };
  /** A person as a list shows them. They were just read, so a miss means they have gone since. */
  const summaryOf = (personId: string): PersonSummary => {
    const summary = getPersonSummary(session.tree, personId);
    if (!summary) throw new NotFoundError('person', personId);
    return summary;
  };

  return {
    getAppInfo: define<'getAppInfo'>(none, () => platform.appInfo()),

    getStartInfo: define<'getStartInfo'>(none, () => session.startInfo()),

    chooseParentFolder: define<'chooseParentFolder'>(none, async () => {
      const dir = await platform.chooseFolder({
        title: 'Choose where to keep the new family tree',
        buttonLabel: 'Choose folder',
        defaultPath: session.defaultParentDir,
      });
      return dir === null ? null : session.allowParentDir(dir);
    }),

    createTree: define<'createTree'>(
      z.tuple([z.strictObject({ name: text(100), parentDir: text(1000).min(1) })]),
      (input) => session.create(input.name, input.parentDir),
    ),

    openTreeFromDialog: define<'openTreeFromDialog'>(none, async () => {
      const dir = await platform.chooseFolder({
        title: 'Open a family tree folder',
        buttonLabel: 'Open tree',
        defaultPath: session.defaultParentDir,
      });
      return dir === null ? null : session.open(dir);
    }),

    openRecentTree: define<'openRecentTree'>(z.tuple([text(1000).min(1)]), (dir) =>
      session.openRecent(dir),
    ),

    forgetRecentTree: define<'forgetRecentTree'>(z.tuple([text(1000).min(1)]), (dir) =>
      session.forgetRecent(dir),
    ),

    closeTree: define<'closeTree'>(none, () => session.close()),

    importGedcom: define<'importGedcom'>(
      z.tuple([z.strictObject({ name: text(100), parentDir: text(1000).min(1) })]),
      async (input) => {
        // The page never names the file; the user picks it in the system dialog.
        const file = await platform.chooseFileToOpen({
          title: 'Choose a GEDCOM file to import',
          buttonLabel: 'Import',
          defaultPath: session.defaultParentDir,
          filters: GEDCOM_FILTERS,
        });
        if (file === null) return null;
        const { state, report } = session.importGedcom(file, input.name, input.parentDir);
        return {
          tree: state,
          report: {
            fileName: report.fileName,
            version: report.version,
            encoding: report.encoding,
            persons: report.persons,
            families: report.families,
            events: report.events,
            sources: report.sources,
            citations: report.citations,
            keptRecords: Object.values(report.keptRecords).reduce((sum, count) => sum + count, 0),
            keptLines: report.keptLines,
            issues: report.issues,
            issueCount: report.issueCount,
          },
        };
      },
    ),

    exportGedcom: define<'exportGedcom'>(
      z.tuple([z.strictObject({ version: z.enum(['5.5.1', '7.0']), includeLiving: z.boolean() })]),
      async (request) => {
        const chosen = await platform.chooseFileToSave({
          title: 'Export this tree as a GEDCOM file',
          buttonLabel: 'Export',
          defaultPath: session.suggestedExportPath(),
          filters: GEDCOM_FILTERS,
        });
        if (chosen === null) return null;
        const result = session.exportGedcom(chosen, {
          ...request,
          appVersion: platform.appInfo().appVersion,
        });
        return {
          file: result.file,
          version: result.version,
          persons: result.persons,
          families: result.families,
          livingOmitted: result.livingOmitted,
          unconverted: Object.entries(result.unconverted).map(([what, count]) => ({ what, count })),
        };
      },
    ),

    countPresumedLiving: define<'countPresumedLiving'>(
      none,
      () => presumedLivingIds(session.tree).size,
    ),

    listPersons: define<'listPersons'>(
      z.tuple([
        z.strictObject({
          query: text(200),
          offset: z.number().int().min(0),
          limit: z.number().int().min(1).max(500),
        }),
      ]),
      ({ query, offset, limit }) => {
        const tree = session.tree;
        const page = { offset, limit };
        return query.trim() === ''
          ? { total: countPersons(tree), persons: listPersons(tree, page) }
          : {
              total: countSearchPersons(tree, query),
              persons: searchPersons(tree, query, page),
            };
      },
    ),

    getPersonPage: define<'getPersonPage'>(z.tuple([id]), (personId) => {
      const page = getPersonPage(session.tree, personId);
      return page === null ? null : { ...page, keptLines: keptLinesOf(session.tree, personId) };
    }),

    getChart: define<'getChart'>(
      z.tuple([
        z.strictObject({
          personId: id,
          ancestors: z.number().int().min(0).max(10),
          descendants: z.number().int().min(0).max(10),
        }),
      ]),
      ({ personId, ancestors, descendants }) =>
        getChartData(session.tree, personId, { ancestors, descendants }),
    ),

    getRelationship: define<'getRelationship'>(z.tuple([id, id]), (personId, otherId) => {
      const found = findRelationship(session.tree, personId, otherId);
      const other = summaryOf(otherId);
      return {
        person: summaryOf(personId),
        other,
        kind: found.relationship.kind,
        term: relationshipTerm(found.relationship, other.sex),
        path: found.path.map(summaryOf),
        commonAncestors: found.commonAncestorIds.map(summaryOf),
        via: found.viaId === null ? null : summaryOf(found.viaId),
        others: found.others.map((relation) => kinshipTerm(relation, other.sex)),
      };
    }),

    findDuplicates: define<'findDuplicates'>(none, () => {
      const scan = findDuplicates(session.tree);
      return {
        pairs: scan.pairs.map((pair) => ({
          a: summaryOf(pair.aId),
          b: summaryOf(pair.bId),
          score: pair.score,
          reasons: pair.reasons,
        })),
        total: scan.total,
        persons: scan.persons,
        truncated: scan.truncated,
      };
    }),

    listSources: define<'listSources'>(
      z.tuple([
        z.strictObject({
          query: text(200),
          offset: z.number().int().min(0),
          limit: z.number().int().min(1).max(500),
        }),
      ]),
      ({ query, offset, limit }) => ({
        total: countSources(session.tree, query),
        sources: listSources(session.tree, { query, offset, limit }).map((source) => ({
          id: source.id,
          title: source.title !== '' ? source.title : source.abbreviation,
          author: source.author,
          citations: source.citations,
        })),
      }),
    ),

    getSource: define<'getSource'>(
      z.tuple([
        id,
        z.strictObject({
          offset: z.number().int().min(0),
          limit: z.number().int().min(1).max(200),
        }),
      ]),
      (sourceId, page) => {
        const tree = session.tree;
        const source = getSource(tree, sourceId);
        if (source === null) return null;
        const sourceTitle = source.title !== '' ? source.title : source.abbreviation;
        return {
          source: {
            id: source.id,
            title: source.title,
            author: source.author,
            publication: source.publication,
            abbreviation: source.abbreviation,
            text: source.text,
          },
          citationCount: countSourceCitations(tree, sourceId),
          citations: listSourceCitations(tree, sourceId, page).map((citation) => ({
            id: citation.id,
            sourceId: citation.sourceId,
            sourceTitle,
            page: citation.page,
            text: citation.text,
            quality: citation.quality,
            note: citation.note,
            uses: citation.uses.map((use) => ({
              type: use.type,
              id: use.id,
              what: use.what,
              persons: use.personIds
                .map((personId) => getPersonSummary(tree, personId))
                .filter((person) => person !== null),
            })),
          })),
          keptLines: keptLinesOfSource(tree, sourceId),
        };
      },
    ),

    addPerson: define<'addPerson'>(z.tuple([draft]), (input) =>
      link((tree) => ({ personId: addPersonFromDraft(tree, input).id })),
    ),

    updatePerson: define<'updatePerson'>(
      z.tuple([id, z.strictObject({ sex: sex.exactOptional(), living: living.exactOptional() })]),
      (personId, patch) => edit((tree) => updatePerson(tree, personId, patch)),
    ),

    deletePerson: define<'deletePerson'>(z.tuple([id]), (personId) =>
      edit((tree) => deletePerson(tree, personId)),
    ),

    addName: define<'addName'>(
      z.tuple([id, z.strictObject({ ...nameFields, primary: z.boolean().exactOptional() })]),
      (personId, name) => edit((tree) => addName(tree, personId, name)),
    ),

    updateName: define<'updateName'>(z.tuple([id, z.strictObject(nameFields)]), (nameId, name) =>
      edit((tree) => updateName(tree, nameId, name)),
    ),

    setPrimaryName: define<'setPrimaryName'>(z.tuple([id]), (nameId) =>
      edit((tree) => setPrimaryName(tree, nameId)),
    ),

    deleteName: define<'deleteName'>(z.tuple([id]), (nameId) =>
      edit((tree) => deleteName(tree, nameId)),
    ),

    addPersonEvent: define<'addPersonEvent'>(z.tuple([id, eventInput]), (personId, event) =>
      edit((tree) => addPersonEvent(tree, personId, event)),
    ),

    addFamilyEvent: define<'addFamilyEvent'>(z.tuple([id, eventInput]), (familyId, event) =>
      edit((tree) => addFamilyEvent(tree, familyId, event)),
    ),

    updateEvent: define<'updateEvent'>(z.tuple([id, eventInput]), (eventId, event) =>
      edit((tree) => updateEvent(tree, eventId, event)),
    ),

    deleteEvent: define<'deleteEvent'>(z.tuple([id]), (eventId) =>
      edit((tree) => deleteEvent(tree, eventId)),
    ),

    addParent: define<'addParent'>(
      z.tuple([id, personRef, childOptions]),
      (childId, parent, options) => link((tree) => addParent(tree, childId, parent, options)),
    ),

    addPartner: define<'addPartner'>(
      z.tuple([id, personRef, familyOption]),
      (personId, partner, options) => link((tree) => addPartner(tree, personId, partner, options)),
    ),

    addChild: define<'addChild'>(
      z.tuple([id, personRef, childOptions]),
      (parentId, child, options) => link((tree) => addChildOf(tree, parentId, child, options)),
    ),

    removeChild: define<'removeChild'>(z.tuple([id, id]), (familyId, childId) =>
      edit((tree) => unlinkChild(tree, familyId, childId)),
    ),

    removePartner: define<'removePartner'>(z.tuple([id, id]), (familyId, personId) =>
      edit((tree) => unlinkPartner(tree, familyId, personId)),
    ),

    setPedigree: define<'setPedigree'>(z.tuple([id, id, pedigree]), (familyId, childId, value) =>
      edit((tree) => setChildPedigree(tree, familyId, childId, value)),
    ),

    mergePersons: define<'mergePersons'>(z.tuple([id, id]), (keepId, mergeId) => {
      const result = session.change((tree) => mergePersons(tree, keepId, mergeId));
      return { tree: session.state(), ...result };
    }),

    markNotDuplicate: define<'markNotDuplicate'>(z.tuple([id, id]), (personId, otherId) =>
      edit((tree) => markNotDuplicate(tree, personId, otherId)),
    ),

    createSource: define<'createSource'>(z.tuple([sourceInput]), (input) => {
      const source = session.change((tree) => createSource(tree, input));
      return { tree: session.state(), sourceId: source.id };
    }),

    updateSource: define<'updateSource'>(z.tuple([id, sourceInput]), (sourceId, input) =>
      edit((tree) => updateSource(tree, sourceId, input)),
    ),

    deleteSource: define<'deleteSource'>(z.tuple([id]), (sourceId) =>
      edit((tree) => deleteSource(tree, sourceId)),
    ),

    addCitation: define<'addCitation'>(
      z.tuple([citationTarget, sourceRef, citationInput]),
      (target, source, input) => edit((tree) => addCitation(tree, target, source, input)),
    ),

    updateCitation: define<'updateCitation'>(z.tuple([id, citationInput]), (citationId, input) =>
      edit((tree) => updateCitation(tree, citationId, input)),
    ),

    linkCitation: define<'linkCitation'>(z.tuple([id, citationTarget]), (citationId, target) =>
      edit((tree) => linkCitation(tree, citationId, target)),
    ),

    unlinkCitation: define<'unlinkCitation'>(z.tuple([id, citationTarget]), (citationId, target) =>
      edit((tree) => unlinkCitation(tree, citationId, target)),
    ),

    deleteCitation: define<'deleteCitation'>(z.tuple([id]), (citationId) =>
      edit((tree) => deleteCitation(tree, citationId)),
    ),

    undo: define<'undo'>(none, () => session.undo()),

    redo: define<'redo'>(none, () => session.redo()),

    listBackups: define<'listBackups'>(none, () => session.listBackups()),

    backupNow: define<'backupNow'>(none, () => {
      const created = session.backupNow();
      return { tree: session.state(), created };
    }),

    restoreBackup: define<'restoreBackup'>(z.tuple([text(100).min(1)]), (name) =>
      session.restore(name),
    ),

    showBackupsFolder: define<'showBackupsFolder'>(none, () =>
      platform.openFolder(session.backupsDir()),
    ),
  };
}

/** Errors whose message is written for the user and says what is not allowed. */
const RULE_ERRORS = [
  TreeRuleError,
  TreeLocationError,
  NoTreeError,
  NotATreeError,
  SchemaTooNewError,
  BackupError,
  GedcomFileError,
  SessionError,
] as const;

/** Turns anything a handler threw into the error the page receives. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    return {
      code: 'invalid',
      message: `the request was not valid${where}: ${issue?.message ?? 'unknown problem'}`,
    };
  }
  if (error instanceof NoOpenTreeError) return { code: 'no-tree', message: error.message };
  if (error instanceof NotFoundError) return { code: 'not-found', message: error.message };
  if (RULE_ERRORS.some((kind) => error instanceof kind)) {
    return { code: 'rule', message: (error as Error).message };
  }
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) };
}
