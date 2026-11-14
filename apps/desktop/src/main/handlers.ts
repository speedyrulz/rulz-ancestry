import {
  CITATION_LIMITS,
  MEDIA_LIMITS,
  NAME_TYPES,
  PEDIGREES,
  SEXES,
  NOTE_MAX,
  PLACE_TEXT_MAX,
  SOURCE_LIMITS,
  TEXT_QUERY_MAX,
  US_STATES,
  canOpenOutside,
  cleanDay,
  formatGazetteerPlace,
  kinshipTerm,
  mediaKind,
  relationshipTerm,
  webAddressProblem,
  type GazetteerPlace,
} from '@rulz/core';
import {
  BackupError,
  GazetteerError,
  GedcomFileError,
  MediaFileError,
  NoTreeError,
  NotATreeError,
  NotFoundError,
  SchemaTooNewError,
  TreeLocationError,
  TreeRuleError,
  ZipError,
  addChildOf,
  addCitation,
  attachRecord,
  addFamilyEvent,
  addMediaFiles,
  addName,
  addParent,
  addPartner,
  addPersonEvent,
  addPersonFromDraft,
  countMedia,
  countPersons,
  countPlaces,
  countSearchPersons,
  countSourceCitations,
  countSources,
  createSource,
  deleteCitation,
  deleteEvent,
  deleteMedia,
  deleteName,
  deletePerson,
  deleteSource,
  findDuplicates,
  findRelationship,
  getChartData,
  getMedia,
  getPersonLife,
  getPersonPage,
  getPersonSummary,
  getSource,
  isMediaPresent,
  keptLinesOf,
  keptLinesOfSource,
  linkCitation,
  linkPlace,
  listAllMedia,
  listMedia,
  listMediaUses,
  listPersons,
  listPlaces,
  listSourceCitations,
  listSources,
  locateMediaFiles,
  markNotDuplicate,
  mediaFilePath,
  mergePersons,
  presumedLivingIds,
  requireCitation,
  requireMedia,
  searchPersons,
  setChildPedigree,
  setMediaFile,
  setPrimaryName,
  suggestTreePlaces,
  unlinkChild,
  unlinkCitation,
  unlinkMedia,
  unlinkPartner,
  unlinkPlace,
  updateCitation,
  updateEvent,
  updateMedia,
  updateName,
  updatePerson,
  updateSource,
  type EventInput as TreeEventInput,
  type Media,
  type PersonDraft as TreePersonDraft,
  type PersonRef as TreePersonRef,
  type PlaceLink,
  type SourceRef as TreeSourceRef,
  type Tree,
  type TreePlace,
} from '@rulz/db';
import { z } from 'zod';
import type {
  ApiMethod,
  AppInfo,
  EventInput,
  GazetteerEntry,
  IpcError,
  MediaInfo,
  PersonChange,
  PersonDraft,
  PersonRef,
  PersonSummary,
  RulzApi,
  SourceRef,
  TreePlaceInfo,
  TreeState,
} from '../shared/ipc';
import type { GazetteerService } from './gazetteer';
import type { RecordSearchService } from './records';
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
  /** Opens an HTTPS address in the user's browser. The app itself asks it nothing. */
  openInBrowser(url: string): Promise<void>;
  /** Shows the system folder picker. Resolves to null when the user cancels. */
  chooseFolder(options: FolderPickerOptions): Promise<string | null>;
  /** Shows the system dialog for opening one file. Resolves to null when the user cancels. */
  chooseFileToOpen(options: FilePickerOptions): Promise<string | null>;
  /**
   * Shows the system dialog for opening files, where several may be chosen.
   * Windows starts it in the folder it was last used in. Resolves to an empty
   * list when the user cancels.
   */
  chooseFilesToOpen(options: Omit<FilePickerOptions, 'defaultPath'>): Promise<string[]>;
  /** Shows the system dialog for saving a file. Resolves to null when the user cancels. */
  chooseFileToSave(options: FilePickerOptions): Promise<string | null>;
  /** Shows a folder in File Explorer. */
  openFolder(dir: string): Promise<void>;
  /** Opens a file in the program Windows uses for its kind. */
  openFile(file: string): Promise<void>;
  /** Shows a file in File Explorer, selected in its folder. */
  showFileInFolder(file: string): void;
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

/**
 * Refuses a web address typed for a citation that is none. One that has not
 * changed passes as it is: a file can have brought an address the app would
 * not take from a form, and editing the rest of that citation must still work.
 */
function checkAddress(typed: string | undefined, current: string): void {
  if (typed === undefined || typed.trim() === current) return;
  const problem = webAddressProblem(typed);
  if (problem !== null) throw new SessionError(problem);
}
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sex = z.enum(SEXES);
const pedigree = z.enum(PEDIGREES);
const living = z.boolean().nullable();
const none = z.tuple([]);

/** The number GeoNames gives a place. */
const geonameId = z.number().int().positive().max(4_000_000_000);

const draft = z.strictObject({
  given: text(200).exactOptional(),
  surname: text(200).exactOptional(),
  sex: sex.exactOptional(),
  living: living.exactOptional(),
  birthDate: text(200).exactOptional(),
  birthPlace: text(500).exactOptional(),
  birthPlaceGeonameId: geonameId.exactOptional(),
  deathDate: text(200).exactOptional(),
  deathPlace: text(500).exactOptional(),
  deathPlaceGeonameId: geonameId.exactOptional(),
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
  note: text(NOTE_MAX).exactOptional(),
  placeGeonameId: geonameId.exactOptional(),
});

const placeListRequest = z.strictObject({
  query: text(PLACE_TEXT_MAX),
  filter: z.enum(['all', 'linked', 'unlinked']),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(50),
});

const sourceInput = z.strictObject({
  title: text(SOURCE_LIMITS.title).exactOptional(),
  author: text(SOURCE_LIMITS.author).exactOptional(),
  publication: text(SOURCE_LIMITS.publication).exactOptional(),
  abbreviation: text(SOURCE_LIMITS.abbreviation).exactOptional(),
  text: text(SOURCE_LIMITS.text).exactOptional(),
  note: text(SOURCE_LIMITS.note).exactOptional(),
});

const citationInput = z.strictObject({
  page: text(CITATION_LIMITS.page).exactOptional(),
  text: text(CITATION_LIMITS.text).exactOptional(),
  quality: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .exactOptional(),
  note: text(CITATION_LIMITS.note).exactOptional(),
  // Whether it is a web address is looked at where it is saved: an address
  // that came with a file may be none, and must still pass when it is unchanged.
  url: text(CITATION_LIMITS.url).exactOptional(),
  accessedAt: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/)
    // A day that does not exist would be stored as no day at all.
    .refine((day) => cleanDay(day) === day)
    .exactOptional(),
});

const personQuery = z.strictObject({
  given: text(100),
  surname: text(100),
  birthYear: z.number().int().min(1).max(9999).nullable(),
  deathYear: z.number().int().min(1).max(9999).nullable(),
});

/** What a source of newspapers or books is asked for. Whether the years fit each other is looked at where it is sent. */
const textQuery = z.strictObject({
  words: text(TEXT_QUERY_MAX),
  phrase: z.boolean(),
  fromYear: z.number().int().min(1).max(9999).nullable(),
  toYear: z.number().int().min(1).max(9999).nullable(),
  state: z.string().refine((state) => state === '' || US_STATES.includes(state)),
});

const siteId = z.string().regex(/^[a-z0-9-]{1,40}$/);

const citationTarget = z.strictObject({
  type: z.enum(['person', 'family', 'event', 'name']),
  id,
});

const sourceRef = z.union([
  z.strictObject({ sourceId: id }),
  z.strictObject({ create: sourceInput }),
  z.strictObject({ siteId }),
]);

const mediaInput = z.strictObject({
  title: text(MEDIA_LIMITS.title).exactOptional(),
  description: text(MEDIA_LIMITS.description).exactOptional(),
});

const mediaTarget = z.strictObject({
  type: z.enum(['person', 'family', 'event', 'citation', 'source']),
  id,
});

/** What the file dialog for an import offers. A GEDZip file is a GEDCOM file with its pictures, zipped. */
const IMPORT_FILTERS = [
  { name: 'GEDCOM and GEDZip files', extensions: ['ged', 'gdz'] },
  { name: 'All files', extensions: ['*'] },
];

/** What the file dialog for an export offers, for a GEDCOM file on its own. */
const GEDCOM_FILTERS = [
  { name: 'GEDCOM files', extensions: ['ged'] },
  { name: 'All files', extensions: ['*'] },
];

/** The same for a GEDZip file. Other programs know it as a zip file. */
const GEDZIP_FILTERS = [
  { name: 'GEDZip files', extensions: ['gdz'] },
  { name: 'Zip files', extensions: ['zip'] },
];

/** What the file dialog for adding pictures and documents offers. Any file may be added. */
const MEDIA_FILTERS = [
  {
    name: 'Pictures and documents',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'pdf'],
  },
  { name: 'All files', extensions: ['*'] },
];

/** A file of the tree as the page sees it. */
function mediaInfo(tree: Tree, media: Media): MediaInfo {
  return {
    id: media.id,
    kind: mediaKind(media.mime),
    mime: media.mime,
    ext: media.ext,
    size: media.size,
    fileName: media.fileName,
    title: media.title,
    description: media.description,
    held: media.sha256 !== null,
    origin: media.origin,
    present: isMediaPresent(tree, media),
    canOpen: canOpenOutside(media.ext),
  };
}

const familyOption = z.strictObject({ familyId: id.exactOptional() });
const childOptions = z.strictObject({
  familyId: id.exactOptional(),
  pedigree: pedigree.exactOptional(),
});

function entryOf(place: GazetteerPlace): GazetteerEntry {
  return {
    geonameId: place.geonameId,
    text: formatGazetteerPlace(place),
    kind: place.featureClass === 'A' ? 'region' : 'place',
    lat: place.lat,
    lon: place.lon,
  };
}

function placeInfo(place: TreePlace): TreePlaceInfo {
  return { text: place.text, events: place.events, link: place.link };
}

export function createHandlers(
  session: TreeSession,
  platform: Platform,
  gazetteer: GazetteerService,
  records: RecordSearchService,
): ApiHandlers {
  /**
   * The link for a gazetteer entry the page names by its number. The page
   * sends the number only; the name and the coordinates are read here. An
   * entry that is not there (the gazetteer was removed meanwhile) gives no
   * link, and the place is saved as typed.
   */
  // What was found for one tree is not kept for the next, however the tree is left.
  session.whenTreeCloses(() => records.reset());

  const placeLinkOf = (id: number | undefined): PlaceLink | undefined => {
    const place = id === undefined ? null : gazetteer.get(id);
    return place === null
      ? undefined
      : {
          geonamesId: place.geonameId,
          name: formatGazetteerPlace(place),
          lat: place.lat,
          lon: place.lon,
        };
  };
  const eventOf = ({ placeGeonameId, ...event }: EventInput): TreeEventInput => {
    const placeLink = placeLinkOf(placeGeonameId);
    return placeLink ? { ...event, placeLink } : event;
  };
  const draftOf = ({
    birthPlaceGeonameId,
    deathPlaceGeonameId,
    ...fields
  }: PersonDraft): TreePersonDraft => {
    const birthPlaceLink = placeLinkOf(birthPlaceGeonameId);
    const deathPlaceLink = placeLinkOf(deathPlaceGeonameId);
    return {
      ...fields,
      ...(birthPlaceLink ? { birthPlaceLink } : {}),
      ...(deathPlaceLink ? { deathPlaceLink } : {}),
    };
  };
  const refOf = (ref: PersonRef): TreePersonRef =>
    'create' in ref ? { create: draftOf(ref.create) } : ref;
  /** The source of a new citation, with a site the app knows turned into the tree's source for it. */
  const sourceOf = (source: SourceRef): TreeSourceRef => {
    if (!('siteId' in source)) return source;
    const connector = records.site(source.siteId);
    if (connector === undefined) throw new SessionError('this site is not known');
    return { connector };
  };
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
  /** The full path of a file of the tree. The page names the file by its id, never by a path. */
  const storedFile = (mediaId: string): { path: string; ext: string } => {
    const tree = session.tree;
    const media = requireMedia(tree, mediaId);
    const path = mediaFilePath(tree, media);
    if (media.sha256 === null) {
      throw new SessionError(
        'the tree does not hold this file; the file it was imported from only names it',
      );
    }
    if (path === null || !isMediaPresent(tree, media)) {
      throw new SessionError(
        `${media.fileName} is not in the tree's media folder any more; add the file again to put it back`,
      );
    }
    return { path, ext: media.ext };
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
          title: 'Choose a GEDCOM or GEDZip file to import',
          buttonLabel: 'Import',
          defaultPath: session.defaultParentDir,
          filters: IMPORT_FILTERS,
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
            media: report.media,
            mediaHeld: report.mediaHeld,
            keptRecords: Object.values(report.keptRecords).reduce((sum, count) => sum + count, 0),
            keptLines: report.keptLines,
            issues: report.issues,
            issueCount: report.issueCount,
          },
        };
      },
    ),

    exportGedcom: define<'exportGedcom'>(
      z.tuple([
        z.strictObject({
          version: z.enum(['5.5.1', '7.0']),
          includeLiving: z.boolean(),
          withFiles: z.boolean(),
        }),
      ]),
      async ({ version, includeLiving, withFiles }) => {
        const chosen = await platform.chooseFileToSave({
          title: withFiles
            ? 'Export this tree with its pictures and documents'
            : 'Export this tree as a GEDCOM file',
          buttonLabel: 'Export',
          defaultPath: session.suggestedExportPath(withFiles),
          filters: withFiles ? GEDZIP_FILTERS : GEDCOM_FILTERS,
        });
        if (chosen === null) return null;
        const result = session.exportGedcom(chosen, {
          version,
          includeLiving,
          files: withFiles,
          appVersion: platform.appInfo().appVersion,
        });
        return {
          file: result.file,
          version: result.version,
          persons: result.persons,
          families: result.families,
          livingOmitted: result.livingOmitted,
          unconverted: Object.entries(result.unconverted).map(([what, count]) => ({ what, count })),
          withFiles,
          media: result.media,
          mediaFiles: result.files.length,
          mediaNotHeld: result.mediaNotHeld,
          mediaWithheld: result.mediaWithheld,
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
      const tree = session.tree;
      const page = getPersonPage(tree, personId);
      if (page === null) return null;
      return {
        ...page,
        media: page.media.map((media) => ({ ...mediaInfo(tree, media), uses: media.uses })),
        keptLines: keptLinesOf(tree, personId),
      };
    }),

    getPersonLife: define<'getPersonLife'>(z.tuple([id]), (personId) =>
      getPersonLife(session.tree, personId),
    ),

    getRecordSearch: define<'getRecordSearch'>(z.tuple([id]), (personId) =>
      records.setup(session.tree, personId),
    ),

    agreeToRecordSearch: define<'agreeToRecordSearch'>(none, () => records.agree()),

    searchRecords: define<'searchRecords'>(
      z.tuple([
        z.strictObject({
          personId: id,
          sourceId: siteId,
          query: personQuery,
          offset: z.number().int().min(0).max(1000),
        }),
      ]),
      (request) => records.search(session.tree, request),
    ),

    searchRecordTexts: define<'searchRecordTexts'>(
      z.tuple([
        z.strictObject({
          personId: id,
          sourceId: siteId,
          query: textQuery,
          offset: z.number().int().min(0).max(1000),
        }),
      ]),
      (request) => records.searchTexts(session.tree, request),
    ),

    cancelRecordSearch: define<'cancelRecordSearch'>(none, () => records.cancel()),

    attachRecord: define<'attachRecord'>(
      z.tuple([
        z.strictObject({ personId: id, sourceId: siteId, key: z.string().min(1).max(200) }),
      ]),
      (request) => {
        const found = records.attachment(session.tree, request);
        if (!found.ok) return found;
        const { citation, added } = session.change((tree) =>
          attachRecord(tree, request.personId, found.connector, found.citation),
        );
        return { ok: true, tree: session.state(), citationId: citation.id, added };
      },
    ),

    setRecordSourceKey: define<'setRecordSourceKey'>(
      z.tuple([
        z.strictObject({
          sourceId: siteId,
          // What a header can hold: printable, without spaces. Its form is the source's own matter.
          key: z.string().regex(/^[\x21-\x7e]{8,300}$/),
        }),
      ]),
      (request) => records.setKey(request.sourceId, request.key),
    ),

    removeRecordSourceKey: define<'removeRecordSourceKey'>(z.tuple([siteId]), (sourceId) =>
      records.removeKey(sourceId),
    ),

    openRecordLink: define<'openRecordLink'>(
      z.tuple([z.strictObject({ personId: id, linkId: siteId, query: personQuery })]),
      async (request) => {
        const link = records.link(session.tree, request);
        if (!link.ok) return link;
        await platform.openInBrowser(link.url);
        return { ok: true };
      },
    ),

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
            note: source.note,
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
            url: citation.url,
            accessedAt: citation.accessedAt,
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

    listMedia: define<'listMedia'>(z.tuple([mediaTarget]), (target) => {
      const tree = session.tree;
      return listMedia(tree, target).map((media) => mediaInfo(tree, media));
    }),

    listAllMedia: define<'listAllMedia'>(
      z.tuple([
        z.strictObject({
          query: text(200),
          unattached: z.boolean(),
          notHeld: z.boolean(),
          offset: z.number().int().min(0),
          limit: z.number().int().min(1).max(500),
        }),
      ]),
      ({ query, unattached, notHeld, offset, limit }) => {
        const tree = session.tree;
        return {
          total: countMedia(tree, { query, unattached, notHeld }),
          notHeld: countMedia(tree, { notHeld: true }),
          media: listAllMedia(tree, { query, unattached, notHeld, offset, limit }).map((media) =>
            mediaInfo(tree, media),
          ),
        };
      },
    ),

    getMedia: define<'getMedia'>(z.tuple([id]), (mediaId) => {
      const tree = session.tree;
      const media = getMedia(tree, mediaId);
      if (media === null) return null;
      return {
        media: mediaInfo(tree, media),
        uses: listMediaUses(tree, mediaId).map((use) => ({
          type: use.type,
          id: use.id,
          what: use.what,
          detail: use.detail,
          persons: use.personIds
            .map((personId) => getPersonSummary(tree, personId))
            .filter((person) => person !== null),
        })),
      };
    }),

    listPlaces: define<'listPlaces'>(z.tuple([placeListRequest]), (request) => {
      const tree = session.tree;
      const filter = {
        query: request.query,
        ...(request.filter === 'all' ? {} : { linked: request.filter === 'linked' }),
      };
      const places = listPlaces(tree, { ...filter, offset: request.offset, limit: request.limit });
      return {
        total: countPlaces(tree, filter),
        all: countPlaces(tree),
        linked: countPlaces(tree, { linked: true }),
        places: places.map(placeInfo),
      };
    }),

    offerPlace: define<'offerPlace'>(z.tuple([text(PLACE_TEXT_MAX)]), (place) => {
      const best = gazetteer.offer(place);
      return best ? entryOf(best) : null;
    }),

    suggestPlaces: define<'suggestPlaces'>(z.tuple([text(PLACE_TEXT_MAX)]), (typed) => ({
      own: suggestTreePlaces(session.tree, typed, 6).map(placeInfo),
      gazetteer: gazetteer.search(typed, 8).map(entryOf),
      installed: gazetteer.installed !== null,
    })),

    getGazetteerStatus: define<'getGazetteerStatus'>(none, () => gazetteer.status()),

    downloadGazetteer: define<'downloadGazetteer'>(none, () => {
      gazetteer.start();
      return gazetteer.status();
    }),

    cancelGazetteerDownload: define<'cancelGazetteerDownload'>(none, async () => {
      gazetteer.cancel();
      await gazetteer.idle();
      return gazetteer.status();
    }),

    removeGazetteer: define<'removeGazetteer'>(none, () => {
      gazetteer.remove();
      return gazetteer.status();
    }),

    addPerson: define<'addPerson'>(z.tuple([draft]), (input) =>
      link((tree) => ({ personId: addPersonFromDraft(tree, draftOf(input)).id })),
    ),

    updatePerson: define<'updatePerson'>(
      z.tuple([
        id,
        z.strictObject({
          sex: sex.exactOptional(),
          living: living.exactOptional(),
          note: text(NOTE_MAX).exactOptional(),
        }),
      ]),
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
      edit((tree) => addPersonEvent(tree, personId, eventOf(event))),
    ),

    addFamilyEvent: define<'addFamilyEvent'>(z.tuple([id, eventInput]), (familyId, event) =>
      edit((tree) => addFamilyEvent(tree, familyId, eventOf(event))),
    ),

    updateEvent: define<'updateEvent'>(z.tuple([id, eventInput]), (eventId, event) =>
      edit((tree) => updateEvent(tree, eventId, eventOf(event))),
    ),

    linkPlace: define<'linkPlace'>(
      z.tuple([text(PLACE_TEXT_MAX).min(1), geonameId]),
      (place, id) => {
        const placeLink = placeLinkOf(id);
        if (!placeLink) throw new SessionError('this place is not in the gazetteer any more');
        return edit((tree) => linkPlace(tree, place, placeLink));
      },
    ),

    unlinkPlace: define<'unlinkPlace'>(z.tuple([text(PLACE_TEXT_MAX).min(1)]), (place) =>
      edit((tree) => unlinkPlace(tree, place)),
    ),

    deleteEvent: define<'deleteEvent'>(z.tuple([id]), (eventId) =>
      edit((tree) => deleteEvent(tree, eventId)),
    ),

    addParent: define<'addParent'>(
      z.tuple([id, personRef, childOptions]),
      (childId, parent, options) =>
        link((tree) => addParent(tree, childId, refOf(parent), options)),
    ),

    addPartner: define<'addPartner'>(
      z.tuple([id, personRef, familyOption]),
      (personId, partner, options) =>
        link((tree) => addPartner(tree, personId, refOf(partner), options)),
    ),

    addChild: define<'addChild'>(
      z.tuple([id, personRef, childOptions]),
      (parentId, child, options) =>
        link((tree) => addChildOf(tree, parentId, refOf(child), options)),
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
      (target, source, input) => {
        checkAddress(input.url, '');
        return edit((tree) => addCitation(tree, target, sourceOf(source), input));
      },
    ),

    updateCitation: define<'updateCitation'>(z.tuple([id, citationInput]), (citationId, input) =>
      edit((tree) => {
        checkAddress(input.url, requireCitation(tree, citationId).url);
        return updateCitation(tree, citationId, input);
      }),
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

    addMedia: define<'addMedia'>(z.tuple([mediaTarget.nullable()]), async (target) => {
      // Without an open tree there is nowhere to put a file; say so before asking for one.
      void session.tree;
      // The page never names a file; the user picks them in the system dialog.
      const files = await platform.chooseFilesToOpen({
        title: 'Choose pictures or documents to add',
        buttonLabel: 'Add',
        filters: MEDIA_FILTERS,
      });
      if (files.length === 0) return null;
      const added = session.change((tree) => addMediaFiles(tree, files, target));
      return {
        tree: session.state(),
        chosen: files.length,
        added: added.filter((entry) => entry.isNew).length,
        attached: added.filter((entry) => entry.linked).length,
        mediaIds: [...new Set(added.map((entry) => entry.media.id))],
      };
    }),

    updateMedia: define<'updateMedia'>(z.tuple([id, mediaInput]), (mediaId, input) =>
      edit((tree) => updateMedia(tree, mediaId, input)),
    ),

    unlinkMedia: define<'unlinkMedia'>(z.tuple([id, mediaTarget]), (mediaId, target) =>
      edit((tree) => unlinkMedia(tree, mediaId, target)),
    ),

    deleteMedia: define<'deleteMedia'>(z.tuple([id]), (mediaId) =>
      edit((tree) => deleteMedia(tree, mediaId)),
    ),

    chooseMediaFile: define<'chooseMediaFile'>(z.tuple([id]), async (mediaId) => {
      // Say that the file has gone, or that it needs none, before asking for one.
      const wanted = requireMedia(session.tree, mediaId);
      if (isMediaPresent(session.tree, wanted)) {
        throw new SessionError('the tree holds this file already');
      }
      const files = await platform.chooseFilesToOpen({
        title:
          wanted.fileName === ''
            ? 'Choose the file for this picture or document'
            : `Choose the file for ${wanted.fileName}`,
        buttonLabel: 'Use this file',
        filters: MEDIA_FILTERS,
      });
      const [file] = files;
      if (file === undefined) return null;
      if (files.length > 1) throw new SessionError('choose one file, not several');
      return edit((tree) => setMediaFile(tree, mediaId, file));
    }),

    findMediaFiles: define<'findMediaFiles'>(none, async () => {
      // Without an open tree there is nothing to look for; say so before asking for a folder.
      void session.tree;
      const dir = await platform.chooseFolder({
        title: 'Choose the folder that holds the pictures and documents',
        buttonLabel: 'Look in this folder',
        defaultPath: session.defaultParentDir,
      });
      if (dir === null) return null;
      const result = session.change((tree) => locateMediaFiles(tree, dir));
      return { tree: session.state(), ...result };
    }),

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

    openMedia: define<'openMedia'>(z.tuple([id]), async (mediaId) => {
      const file = storedFile(mediaId);
      // A tree may hold files that came from someone else. Opening one must never run it.
      if (!canOpenOutside(file.ext)) {
        throw new SessionError(
          'the app does not open files of this kind; use "Show in folder" and open it from there',
        );
      }
      await platform.openFile(file.path);
    }),

    showMediaInFolder: define<'showMediaInFolder'>(z.tuple([id]), (mediaId) => {
      platform.showFileInFolder(storedFile(mediaId).path);
    }),
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
  GazetteerError,
  GedcomFileError,
  MediaFileError,
  ZipError,
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
