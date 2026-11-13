/**
 * The contract between the main process and the renderer. The renderer can
 * only reach the main process through the functions listed in {@link RulzApi}.
 *
 * The data shapes are declared here, not imported from the database package,
 * so the renderer never depends on code that needs Node.js. The main process
 * returns database records that fit these shapes; the compiler checks that.
 */
import type {
  AncestorSlot,
  DateCalendar,
  DateQualifier,
  DescendantNode,
  ExternalRecord,
  GedcomVersion,
  NameType,
  Pedigree,
  PersonQuery,
  Sex,
  TextQuery,
} from '@rulz/core';

export interface AppInfo {
  appVersion: string;
  packaged: boolean;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  database: {
    path: string;
    sqliteVersion: string;
    fts5: boolean;
    journalMode: string;
  };
  /**
   * Result of the start-up check that builds a small family tree in memory and
   * adds, finds, undoes and redoes a person in it.
   */
  treeEngine: { ok: true; schemaVersion: number } | { ok: false; error: string };
  /** Number of known data sources per access tier. */
  connectors: {
    api: number;
    bulk: number;
    deeplink: number;
  };
}

/** The tree that is open, and what undo and redo would do to it. */
export interface TreeState {
  /** The tree's folder. */
  dir: string;
  id: string;
  name: string;
  persons: number;
  families: number;
  events: number;
  sources: number;
  /** Pictures and documents. */
  media: number;
  /** Name of the change that undo would reverse, or null when there is none. */
  undo: string | null;
  /** Name of the change that redo would repeat, or null when there is none. */
  redo: string | null;
  /** Goes up every time the tree's contents change, so screens know to reload. */
  revision: number;
  /** When the newest backup was made (Unix milliseconds), or null when there is none. */
  lastBackupAt: number | null;
}

export interface RecentTreeInfo {
  dir: string;
  name: string;
  lastOpenedAt: number;
  /** False when the folder no longer holds a tree, e.g. it was moved or its drive is unplugged. */
  available: boolean;
}

export interface StartInfo {
  /** The open tree, or null when the start screen should be shown. */
  tree: TreeState | null;
  /** Why the tree that was open last time could not be reopened, if it could not. */
  reopenError: string | null;
  recent: RecentTreeInfo[];
  /** Where a new tree's folder is made unless the user chooses somewhere else. */
  defaultParentDir: string;
}

export interface VitalInfo {
  /** The date as typed. */
  dateText: string;
  placeText: string;
  /** The year in short form, e.g. "1881" or "c. 1850"; empty when it cannot be read. */
  year: string;
}

/** What a list shows for one person. */
export interface PersonSummary {
  id: string;
  sex: Sex;
  /** True living, false deceased, null not stated. */
  living: boolean | null;
  /** The primary name, or null for a person with no name recorded. */
  name: {
    prefix: string;
    given: string;
    nickname: string;
    surname: string;
    suffix: string;
  } | null;
  birth: VitalInfo | null;
  death: VitalInfo | null;
}

export interface PersonNameInfo {
  id: string;
  type: string;
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  suffix: string;
  isPrimary: boolean;
}

export interface EventInfo {
  id: string;
  type: string;
  /** The date as typed; empty when no date is known. */
  dateText: string;
  /** How the app read the date; all four are null when there is no date. */
  dateQualifier: DateQualifier | null;
  dateCalendar: DateCalendar | null;
  dateMinJdn: number | null;
  dateMaxJdn: number | null;
  placeText: string;
  description: string;
  /** The user's own remark on the event. May have several lines. */
  note: string;
}

/** A family in which the person is a child. */
export interface ParentFamilyInfo {
  familyId: string;
  /** How the person is linked to these parents, e.g. "birth" or "adopted". */
  pedigree: string;
  /** The known parents: none, one or two. */
  parents: PersonSummary[];
  siblings: PersonSummary[];
}

/** A family in which the person is a partner. */
export interface PartnerFamilyInfo {
  familyId: string;
  /** The other partner, or null when not known. */
  partner: PersonSummary | null;
  /** The couple's own events, such as their marriage. */
  events: EventInfo[];
  children: { person: PersonSummary; pedigree: string }[];
}

/** Everything the person page shows. */
export interface PersonPage {
  person: {
    id: string;
    sex: Sex;
    living: boolean | null;
    /** The user's own remark on the person. May have several lines. */
    note: string;
  };
  summary: PersonSummary;
  names: PersonNameInfo[];
  events: EventInfo[];
  parentFamilies: ParentFamilyInfo[];
  partnerFamilies: PartnerFamilyInfo[];
  /**
   * The citations that support anything on the page: the person as a whole,
   * their names and events, and the families they are a partner in with those
   * families' events. Each comes once, with the facts of the page it supports.
   */
  citations: PersonCitationInfo[];
  /**
   * The pictures and documents attached to anything on the page: the person
   * as a whole, their events, the families they are a partner in with those
   * families' events, and the citations above. Each comes once, with the
   * things of the page it is attached to.
   */
  media: PersonMediaInfo[];
  /**
   * For a person who came from a GEDCOM file: the lines of their record that
   * the app has no fields for (a second note, other programs' own tags). They
   * are kept as written and go back into an export. Empty for anyone else.
   */
  keptLines: string[];
}

/** What a citation supports: a person or a family as a whole, one event, or one name. */
export type CitationTargetType = 'person' | 'family' | 'event' | 'name';

export interface CitationTarget {
  type: CitationTargetType;
  id: string;
}

/** Where information comes from: a census, a register, a book, a web page. */
export interface SourceInfo {
  id: string;
  title: string;
  author: string;
  /** Who published it, where and when. May have several lines. */
  publication: string;
  /** A short title, which some programs file the source under. */
  abbreviation: string;
  /** Words copied from the source itself. May have several lines. */
  text: string;
  /** The user's own remark on the source. May have several lines. */
  note: string;
}

/** What the source forms collect. A field that is left out is not changed. */
export interface SourceInput {
  title?: string;
  author?: string;
  publication?: string;
  abbreviation?: string;
  text?: string;
  note?: string;
}

/** What a list shows for one source. */
export interface SourceSummary {
  id: string;
  /** The title, or the short title when there is no other. Empty when it has neither. */
  title: string;
  author: string;
  /** How many citations of this source the tree has. */
  citations: number;
}

export interface SourceListRequest {
  /** What was typed in the search box; empty lists every source by title. */
  query: string;
  offset: number;
  limit: number;
}

export interface SourceListPage {
  /** How many sources match in total, not just on this page. */
  total: number;
  sources: SourceSummary[];
}

/** What the citation forms collect. A field that is left out is not changed. */
export interface CitationInput {
  /** Where in the source: a page, a sheet, an entry number. */
  page?: string;
  /** What the source says there, copied out. */
  text?: string;
  /** 0 unreliable, 1 questionable, 2 secondary evidence, 3 direct and primary; null not stated. */
  quality?: number | null;
  /** The user's own remark. */
  note?: string;
  /** The web address of the page or record; http or https, or empty. */
  url?: string;
  /** The day the page was consulted, as `YYYY-MM-DD`, or empty. */
  accessedAt?: string;
}

/** One place in a source, with what it says there. */
export interface CitationInfo {
  id: string;
  sourceId: string;
  /** The source's title, or its short title when it has no other. May be empty. */
  sourceTitle: string;
  page: string;
  text: string;
  quality: number | null;
  note: string;
  /** The web address of the page or record; empty when there is none. An imported one may be no address. */
  url: string;
  /** The day the page was consulted, as `YYYY-MM-DD`; empty when not stated. */
  accessedAt: string;
}

/** A citation on a person's page, with the facts of that page it supports. */
export interface PersonCitationInfo extends CitationInfo {
  uses: CitationTarget[];
}

/** One fact a citation supports, as a source's page names it. */
export interface CitationUseInfo extends CitationTarget {
  /** "person", "family", "name", or the type of the event, e.g. "birth". */
  what: string;
  /** Who it concerns: the person, or the partners of the family. */
  persons: PersonSummary[];
}

/** A citation on a source's page, with every fact it supports. */
export interface SourceCitationInfo extends CitationInfo {
  uses: CitationUseInfo[];
}

/** Everything a source's page shows. */
export interface SourceDetails {
  source: SourceInfo;
  /** How many citations the source has in all; `citations` holds one page of them. */
  citationCount: number;
  citations: SourceCitationInfo[];
  /**
   * For a source that came from a GEDCOM file: the lines of its record that
   * the app has no fields for (its repository, notes, other programs' own
   * tags). They are kept as written and go back into an export.
   */
  keptLines: string[];
}

/** The result of an edit that added a source. */
export interface SourceChange {
  tree: TreeState;
  sourceId: string;
}

/**
 * The source a new citation is of: one that exists, one to make in the same
 * step, or the tree's one source for a site the app knows, by the site's id.
 */
export type SourceRef = { sourceId: string } | { create: SourceInput } | { siteId: string };

/** What a picture or document is attached to. */
export type MediaTargetType = 'person' | 'family' | 'event' | 'citation' | 'source';

export interface MediaTarget {
  type: MediaTargetType;
  id: string;
}

/** A picture or a document of the tree. */
export interface MediaInfo {
  id: string;
  /** `image`: the app shows it itself, with zoom. `document`: it is opened in another program. */
  kind: 'image' | 'document';
  /** The media type, e.g. `image/jpeg`. */
  mime: string;
  /** The extension the file is stored under, without a dot. May be empty. */
  ext: string;
  /** Size of the file in bytes. */
  size: number;
  /** The name the file had where it was added from. */
  fileName: string;
  title: string;
  /** What the file shows. May have several lines. */
  description: string;
  /**
   * False for a file that an imported GEDCOM file names and the tree does not
   * hold. The tree then knows its title and what it belongs to, and nothing
   * of the file itself.
   */
  held: boolean;
  /**
   * Where the imported file says the file is: a path or a web address. Empty
   * for a file that was added in the app.
   */
  origin: string;
  /** False when the file is not in the tree's media folder: it has gone from it, or was never there. */
  present: boolean;
  /** True when the file may be handed to the program Windows opens its kind with. */
  canOpen: boolean;
}

/** A file on a person's page, with the things of that page it is attached to. */
export interface PersonMediaInfo extends MediaInfo {
  uses: MediaTarget[];
}

/** One thing a file is attached to, as the file's own page names it. */
export interface MediaUseInfo extends MediaTarget {
  /** "person", "family", "citation", "source", or the type of the event, e.g. "birth". */
  what: string;
  /** For a citation: the title of its source and the place in it. For a source: its title. Otherwise empty. */
  detail: string;
  /** Who it concerns: the person, the partners of the family, or those a citation is about. */
  persons: PersonSummary[];
}

/** Everything a file's own page shows. */
export interface MediaDetails {
  media: MediaInfo;
  uses: MediaUseInfo[];
}

/** What the form for a file collects. A field that is left out is not changed. */
export interface MediaInput {
  title?: string;
  description?: string;
}

export interface MediaListRequest {
  /** What was typed in the search box; empty lists every file, the one added last first. */
  query: string;
  /** True lists only the files that are attached to nothing. */
  unattached: boolean;
  /** True lists only the files the tree knows of and does not hold. */
  notHeld: boolean;
  offset: number;
  limit: number;
}

export interface MediaListPage {
  /** How many files match in total, not just on this page. */
  total: number;
  /** How many files of the whole tree it knows of and does not hold. */
  notHeld: number;
  media: MediaInfo[];
}

/** What looking in a folder for the files of an imported tree did. */
export interface MediaFindResult {
  tree: TreeState;
  /** Files the tree knew of and did not hold, before the search. */
  wanted: number;
  /** How many of them were found and taken into the tree. */
  found: number;
  /** How many were left because two or more files in the folder fit equally well. */
  ambiguous: number;
  /** Files the search looked at. */
  scanned: number;
  /** True when the folder holds more files than the search looks at. */
  truncated: boolean;
}

/** What adding files did. */
export interface MediaAddResult {
  tree: TreeState;
  /** How many files were chosen. */
  chosen: number;
  /** How many of them the tree did not hold yet. */
  added: number;
  /** How many were attached; a file that was attached there already is not counted. */
  attached: number;
  /** The files, each once, in the order they were chosen. */
  mediaIds: string[];
}

/**
 * The scheme of the addresses the page loads pictures from. The main process
 * answers them from the open tree's media folder; nothing else is served.
 */
export const MEDIA_SCHEME = 'rulz-media';

/**
 * The address of a picture for an `<img>`: the file itself, or a small
 * version of it for a list. A file the window cannot draw has no `file`
 * address; its `thumb` address works when Windows can make a preview of it.
 */
export function mediaUrl(mediaId: string, variant: 'file' | 'thumb'): string {
  return `${MEDIA_SCHEME}://${variant}/${mediaId}`;
}

export interface PersonListRequest {
  /** What was typed in the search box; empty lists everyone by surname. */
  query: string;
  offset: number;
  limit: number;
}

export interface PersonListPage {
  /** How many people match in total, not just on this page. */
  total: number;
  persons: PersonSummary[];
}

/** What the "add person" form collects. */
export interface PersonDraft {
  given?: string;
  surname?: string;
  sex?: Sex;
  living?: boolean | null;
  birthDate?: string;
  birthPlace?: string;
  /** The gazetteer entry the birth place was picked from; see {@link EventInput}. */
  birthPlaceGeonameId?: number;
  deathDate?: string;
  deathPlace?: string;
  deathPlaceGeonameId?: number;
}

/** Someone already in the tree, or the details of someone to add. */
export type PersonRef = { existingId: string } | { create: PersonDraft };

export interface NameInput {
  type?: NameType;
  prefix?: string;
  given?: string;
  nickname?: string;
  surname?: string;
  suffix?: string;
}

export interface EventInput {
  type: string;
  date?: string;
  place?: string;
  description?: string;
  note?: string;
  /**
   * The gazetteer entry the place was picked from, by its GeoNames number.
   * The place is linked to it in the same step. Left out when the place was
   * typed, or changed after it was picked.
   */
  placeGeonameId?: number;
}

/** Where a place lies: the gazetteer entry its text is linked to. */
export interface PlaceLinkInfo {
  /** The number GeoNames gives the place; null when the coordinates come from elsewhere. */
  geonamesId: number | null;
  /** The gazetteer's own name for the place, written out in full. */
  name: string;
  lat: number;
  lon: number;
}

/** One line of a person's life: something that happened to them, or close to them. */
export interface LifeEntryInfo {
  /**
   * `own`: an event of the person. `family`: an event of a couple the person
   * is one of, such as their marriage. `relative`: the birth or the death of
   * someone close, within the person's lifetime.
   */
  kind: 'own' | 'family' | 'relative';
  event: EventInfo;
  /** `partner` for a couple's event, the relative's relation for theirs, null for the person's own. */
  relation: 'parent' | 'partner' | 'child' | 'sibling' | null;
  /** The other partner of a couple's event when known, or the relative. Null for the person's own. */
  person: PersonSummary | null;
  /** Where the event's place lies, when its text is linked. */
  place: PlaceLinkInfo | null;
  /** How old the person was, in whole years, as far as the dates tell. Null when they do not. */
  age: { min: number; max: number } | null;
}

/** A person's life in order, for the timeline and the map. */
export interface PersonLifeInfo {
  entries: LifeEntryInfo[];
}

/** A source that can be searched for records. */
export interface RecordSourceInfo {
  /** The source's id, as in its manifest. */
  id: string;
  name: string;
  /** What the source is asked for: a person, or words that a text has. */
  searches: 'person' | 'text';
  /** What of the search form is sent to the source, in words for the user. */
  asks: string;
  /** The credit shown with every result of the source. */
  attribution: string;
  /** The page with the source's terms. */
  termsUrl: string;
  /** Until when the source must be left alone, in Unix milliseconds; null when it may be asked. */
  pausedUntil: number | null;
}

/** A site the app never asks itself: it opens a search there in the user's browser. */
export interface RecordLinkInfo {
  /** The site's id, as in its manifest. */
  id: string;
  name: string;
  /** The page with the site's terms. */
  termsUrl: string;
}

/** What the search form for a person starts with. */
export interface RecordSearchSetup {
  /** False when the person may be living: nothing is sent about them. */
  allowed: boolean;
  /** Whether the user has agreed to the notice that says what a search sends. */
  agreed: boolean;
  /** The person's name and years. Empty when `allowed` is false. */
  query: PersonQuery;
  /** What the search of newspapers and books starts with. Empty when `allowed` is false. */
  text: TextQuery;
  sources: RecordSourceInfo[];
  /** The sites a search can be opened at in the browser. */
  links: RecordLinkInfo[];
}

export interface RecordSearchRequest {
  /** The person the search is for. Nothing is sent when they may be living. */
  personId: string;
  sourceId: string;
  /** What is sent to the source: this, and nothing else of the tree. */
  query: PersonQuery;
  /** How many results come before the first that is asked for. */
  offset: number;
}

/** A search of a source of newspapers or books. */
export interface TextSearchRequest {
  /** The person the search is for. Nothing is sent when they may be living. */
  personId: string;
  sourceId: string;
  /** What is sent to the source: this, or the part of it the source is asked for, and nothing else. */
  query: TextQuery;
  /** How many results come before the first that is asked for. */
  offset: number;
}

export interface RecordSearchProblem {
  kind:
    | 'notice' /* the user has not agreed to the notice */
    | 'living' /* the person may be living */
    | 'gone' /* the person is no longer in the tree */
    | 'empty' /* the query names nobody, or cannot be sent as it is */
    | 'source' /* the source is not known */
    | 'record' /* the record is not one the search showed for this person */
    | 'paused' /* the source must be left alone until `retryAt` */
    | 'offline' /* the source could not be reached */
    | 'timeout'
    | 'cancelled' /* a newer search took this one's place */
    | 'failed';
  /** In words, for the user. */
  message: string;
  /** When the source may be asked again, in Unix milliseconds, where that is known. */
  retryAt: number | null;
}

export type RecordSearchResult =
  | {
      ok: true;
      sourceId: string;
      items: ExternalRecord[];
      /** How many results the source has in all; null when it does not say. */
      total: number | null;
      /** The offset to ask for to get more; null when there are no more. */
      nextOffset: number | null;
      /** How many results were left out: private profiles and living people. */
      hidden: number;
      /** The keys of the results that the person's page already cites. */
      attached: string[];
      /** When the source gave this answer, in Unix milliseconds. */
      fetchedAt: number;
      /** True when the answer was kept from an earlier search and nothing was sent. */
      cached: boolean;
    }
  | { ok: false; sourceId: string; problem: RecordSearchProblem };

/** Which result of a search to attach to the person it was found for. */
export interface AttachRecordRequest {
  personId: string;
  sourceId: string;
  /** The key of a result the search showed for this person. Nothing else of it is passed. */
  key: string;
}

export type AttachRecordResult =
  | {
      ok: true;
      tree: TreeState;
      citationId: string;
      /** False when the person's page cited the record already, and nothing was added. */
      added: boolean;
    }
  | { ok: false; problem: RecordSearchProblem };

/** A search to open in the browser, at a site the app does not ask itself. */
export interface RecordLinkRequest {
  /** The person the search is for. Nothing is opened when they may be living. */
  personId: string;
  linkId: string;
  /** What the address of the search holds: this, and nothing else of the tree. */
  query: PersonQuery;
}

export type RecordLinkResult = { ok: true } | { ok: false; problem: RecordSearchProblem };

/** One place of the open tree: a text that events give as their place. */
export interface TreePlaceInfo {
  /** The place as typed. */
  text: string;
  /** How many events give this place. */
  events: number;
  link: PlaceLinkInfo | null;
}

/** One entry of the gazetteer, as it is offered. */
export interface GazetteerEntry {
  geonameId: number;
  /** The entry written out as a place: "Springfield, Sangamon County, Illinois, USA". */
  text: string;
  /** A town or village, or a region such as a county, a state or a country. */
  kind: 'place' | 'region';
  lat: number;
  lon: number;
}

/** What is offered while a place is being typed. */
export interface PlaceSuggestions {
  /** Places the tree already has that fit, best first. */
  own: TreePlaceInfo[];
  /** Entries of the gazetteer that fit, best first. Empty when it is not downloaded. */
  gazetteer: GazetteerEntry[];
  /** Whether the gazetteer has been downloaded. */
  installed: boolean;
}

export interface PlaceListRequest {
  /** Only places whose text holds this; empty for all. */
  query: string;
  filter: 'all' | 'linked' | 'unlinked';
  offset: number;
  /** At most 50. */
  limit: number;
}

export interface PlaceListPage {
  /** How many places fit the request. */
  total: number;
  /** How many places the tree has, and how many of them are linked. */
  all: number;
  linked: number;
  places: TreePlaceInfo[];
}

/** The gazetteer on this computer, and the download that fetches it. */
export interface GazetteerStatus {
  /** The gazetteer that is in use, or null when none has been downloaded. */
  installed: {
    places: number;
    /** When it was downloaded, in Unix milliseconds. */
    builtAt: number;
    /** The countries that are in it down to their villages, by their two letters. */
    countries: string[];
  } | null;
  /** The download under way, or null. */
  job: {
    phase: 'downloading' | 'building';
    /** Which of the files is being worked on, counted from 1, and how many there are. */
    step: number;
    steps: number;
    file: string;
    /** Bytes downloaded so far. */
    bytes: number;
    /** Places taken into the gazetteer so far. */
    places: number;
  } | null;
  /** Why the last download did not finish. Null when it did, or when none was tried. */
  error: string | null;
  /** About how much a download fetches, in bytes. */
  downloadBytes: number;
}

/** The result of an edit that added or linked a person. */
export interface PersonChange {
  tree: TreeState;
  personId: string;
}

export interface BackupInfo {
  /** File name inside the tree's backups folder. */
  name: string;
  /** When the backup was made, in Unix milliseconds. */
  at: number;
  /** Size of the file in bytes. */
  size: number;
}

/** What an import of a GEDCOM file did. */
export interface GedcomImportInfo {
  fileName: string;
  version: GedcomVersion;
  /** The character set the file was in, e.g. "UTF-8" or "ANSEL". */
  encoding: string;
  persons: number;
  families: number;
  events: number;
  sources: number;
  /** Citations of those sources. One that the file repeats under several facts is counted once. */
  citations: number;
  /** Pictures and documents the file names. */
  media: number;
  /** How many of those came with the file, in a GEDZip archive, and are now in the tree. */
  mediaHeld: number;
  /** Records the app keeps as written because it has no screens for them yet, such as notes. */
  keptRecords: number;
  /** Lines under people and families that are kept as written for the same reason. */
  keptLines: number;
  /** The first things found in the file that were not as the standard says. Line 0 is the whole file. */
  issues: { line: number; message: string }[];
  /** How many such things were found in all. */
  issueCount: number;
}

export interface GedcomImportResult {
  tree: TreeState;
  report: GedcomImportInfo;
}

export interface GedcomExportRequest {
  version: GedcomVersion;
  /** False leaves out everyone who may be living. */
  includeLiving: boolean;
  /**
   * True writes a GEDZip file: a zip archive with the GEDCOM file and the
   * pictures and documents the tree holds. False writes the GEDCOM file
   * alone, which names the files and does not carry them.
   */
  withFiles: boolean;
}

/** What an export to a GEDCOM file wrote. */
export interface GedcomExportInfo {
  /** The full path of the file that was written. */
  file: string;
  version: GedcomVersion;
  persons: number;
  families: number;
  /** People left out because they may be living. */
  livingOmitted: number;
  /**
   * Kinds of item that could not be rewritten for the chosen version and were
   * written as they are. Empty when the file is in the version it was imported in.
   */
  unconverted: { what: string; count: number }[];
  /** True when a GEDZip file was written, with the files in it. */
  withFiles: boolean;
  /** Pictures and documents the file names. */
  media: number;
  /** How many files went into the archive. Zero for a GEDCOM file on its own. */
  mediaFiles: number;
  /** Of the pictures and documents named, those the tree does not hold, so that no archive can carry them. */
  mediaNotHeld: number;
  /** Pictures and documents left out because everything they are attached to was left out. */
  mediaWithheld: number;
}

/** What a chart of one person is drawn from. */
export interface ChartRequest {
  personId: string;
  /** Generations of ancestors: 0 for none, 1 for parents, 2 for grandparents, up to 10. */
  ancestors: number;
  /** Generations of descendants: 0 for none, 1 for children, up to 10. */
  descendants: number;
}

export interface ChartInfo {
  rootId: string;
  /** The person and their ancestors by Ahnentafel slot. Empty when none were asked for. */
  ancestors: AncestorSlot[];
  descendants: DescendantNode;
  /** Everyone the chart names, each once. */
  persons: PersonSummary[];
  /** True when the family is too large to show whole and the descendants were cut off. */
  truncated: boolean;
}

/** How one person is related to another: `other` is `person`'s `term`. */
export interface RelationshipInfo {
  person: PersonSummary;
  other: PersonSummary;
  kind: 'self' | 'blood' | 'partner' | 'partner-of-relative' | 'relative-of-partner' | 'none';
  /** For example "second cousin once removed" or "sister-in-law". Empty when none was found. */
  term: string;
  /** For a blood relationship: the people who link the two, from `person` to `other`. */
  path: PersonSummary[];
  /** The nearest ancestors the two share: one, or a couple. */
  commonAncestors: PersonSummary[];
  /** For a relationship through a partnership: the relative or partner in between. */
  via: PersonSummary | null;
  /** Other ways the two are related by blood, closest first. */
  others: string[];
}

/** Two people who may be one person entered twice. */
export interface DuplicatePairInfo {
  a: PersonSummary;
  b: PersonSummary;
  /** 50 to 100. From 80 the two are very likely one person. */
  score: number;
  /** What the score rests on. */
  reasons: string[];
}

export interface DuplicateList {
  /** The likeliest pairs, best first. */
  pairs: DuplicatePairInfo[];
  /** How many pairs were found in all; only the likeliest are listed. */
  total: number;
  /** How many people were compared. */
  persons: number;
  /** True when the comparison stopped early because the tree is very large. */
  truncated: boolean;
}

/** What a merge of two people did. */
export interface MergeInfo {
  tree: TreeState;
  /** The person who is left. */
  personId: string;
  /** Names and events that came over from the other record. */
  names: number;
  events: number;
  /** Families that became one because both records had the same partner. */
  families: number;
}

export interface RulzApi {
  getAppInfo(): Promise<AppInfo>;

  // Opening and closing trees.
  getStartInfo(): Promise<StartInfo>;
  /** Shows the system folder picker for where to make a new tree. Null when cancelled. */
  chooseParentFolder(): Promise<string | null>;
  /** Makes a tree in a new folder inside `parentDir`, which must come from the two calls above. */
  createTree(input: { name: string; parentDir: string }): Promise<TreeState>;
  /** Shows the system folder picker and opens the tree chosen. Null when cancelled. */
  openTreeFromDialog(): Promise<TreeState | null>;
  /** Opens a tree from the recent list. */
  openRecentTree(dir: string): Promise<TreeState>;
  forgetRecentTree(dir: string): Promise<RecentTreeInfo[]>;
  /** Backs up and closes the open tree. `backupError` says why the backup failed, if it did. */
  closeTree(): Promise<{ backupError: string | null }>;

  // GEDCOM files, the format other family tree programs read and write.
  /**
   * Shows the system file picker, makes a new tree from the GEDCOM or GEDZip
   * file chosen and opens it. The tree's folder is made inside `parentDir`, as for
   * `createTree`; an empty `name` names the tree after the file. Null when cancelled.
   */
  importGedcom(input: { name: string; parentDir: string }): Promise<GedcomImportResult | null>;
  /** Shows the system save dialog and writes the open tree to the file chosen. Null when cancelled. */
  exportGedcom(request: GedcomExportRequest): Promise<GedcomExportInfo | null>;
  /** How many people of the open tree an export would leave out as possibly living. */
  countPresumedLiving(): Promise<number>;

  // Reading the open tree.
  listPersons(request: PersonListRequest): Promise<PersonListPage>;
  getPersonPage(personId: string): Promise<PersonPage | null>;
  /**
   * A person's life in order: their own events, those of the couples they are
   * one of, and the births and deaths close to them, each with where it lies
   * when its place is linked. Null when the person is gone.
   */
  getPersonLife(personId: string): Promise<PersonLifeInfo | null>;
  // Records outside the tree.
  /**
   * What the search form for a person starts with: whether they may be
   * searched for, their name and years, and the sources. Sends nothing. Null
   * when the person is gone.
   */
  getRecordSearch(personId: string): Promise<RecordSearchSetup | null>;
  /** Notes that the user has agreed to what a search sends. */
  agreeToRecordSearch(): Promise<void>;
  /**
   * Asks one source for records of a person. This sends the query to the
   * source, and only after the user has agreed to the notice and when the
   * person is not one who may be living.
   */
  searchRecords(request: RecordSearchRequest): Promise<RecordSearchResult>;
  /**
   * Asks one source of newspapers or books for words. The same rules hold as
   * for `searchRecords`.
   */
  searchRecordTexts(request: TextSearchRequest): Promise<RecordSearchResult>;
  /** Gives up the searches that are under way. For when the search window closes. */
  cancelRecordSearch(): Promise<void>;
  /**
   * Cites a result of the search for the person it was found for: the source
   * for the site is made when the tree has none, and one Undo takes it back.
   * Nothing is sent.
   */
  attachRecord(request: AttachRecordRequest): Promise<AttachRecordResult>;
  /**
   * Opens a search for a person at a site in the user's browser. The app
   * itself asks the site nothing. Refused for a person who may be living, and
   * before the notice is agreed to.
   */
  openRecordLink(request: RecordLinkRequest): Promise<RecordLinkResult>;
  /** The ancestors and descendants a chart of one person shows. Null when the person is gone. */
  getChart(request: ChartRequest): Promise<ChartInfo | null>;
  /** How `otherId` is related to `personId`. */
  getRelationship(personId: string, otherId: string): Promise<RelationshipInfo>;
  /** Looks through the whole tree for people who may have been entered twice. */
  findDuplicates(): Promise<DuplicateList>;
  listSources(request: SourceListRequest): Promise<SourceListPage>;
  /** A source with one page of its citations. Null when the source is gone. */
  getSource(
    sourceId: string,
    citations: { offset: number; limit: number },
  ): Promise<SourceDetails | null>;
  /** The pictures and documents attached to one thing, in the order they were attached. */
  listMedia(target: MediaTarget): Promise<MediaInfo[]>;
  /** The pictures and documents of the whole tree. */
  listAllMedia(request: MediaListRequest): Promise<MediaListPage>;
  /** A file with everything it is attached to. Null when the file is gone. */
  getMedia(mediaId: string): Promise<MediaDetails | null>;
  /** The places of the open tree, in the order of the alphabet. */
  listPlaces(request: PlaceListRequest): Promise<PlaceListPage>;
  /** What to offer for a place that is being typed: places of the tree, and gazetteer entries. */
  suggestPlaces(typed: string): Promise<PlaceSuggestions>;
  /**
   * The gazetteer entry to offer for a place of the tree, for linking it with
   * one press, or null. Asked for one place at a time, so that a long list of
   * places never keeps the app from answering.
   */
  offerPlace(text: string): Promise<GazetteerEntry | null>;

  // The gazetteer: GeoNames' list of the world's places, kept on this computer.
  getGazetteerStatus(): Promise<GazetteerStatus>;
  /** Starts the download; it goes on after this returns. Ask the status to follow it. */
  downloadGazetteer(): Promise<GazetteerStatus>;
  cancelGazetteerDownload(): Promise<GazetteerStatus>;
  /** Removes the gazetteer from this computer. Trees keep the places they linked. */
  removeGazetteer(): Promise<GazetteerStatus>;

  // Changing the open tree. Each call is one undo step.
  addPerson(draft: PersonDraft): Promise<PersonChange>;
  updatePerson(
    personId: string,
    patch: { sex?: Sex; living?: boolean | null; note?: string },
  ): Promise<TreeState>;
  deletePerson(personId: string): Promise<TreeState>;
  addName(personId: string, name: NameInput & { primary?: boolean }): Promise<TreeState>;
  updateName(nameId: string, name: NameInput): Promise<TreeState>;
  setPrimaryName(nameId: string): Promise<TreeState>;
  deleteName(nameId: string): Promise<TreeState>;
  addPersonEvent(personId: string, event: EventInput): Promise<TreeState>;
  addFamilyEvent(familyId: string, event: EventInput): Promise<TreeState>;
  updateEvent(eventId: string, event: EventInput): Promise<TreeState>;
  deleteEvent(eventId: string): Promise<TreeState>;
  /** Links a place text to a gazetteer entry; every event with that place shares the link. */
  linkPlace(text: string, geonameId: number): Promise<TreeState>;
  unlinkPlace(text: string): Promise<TreeState>;
  addParent(
    childId: string,
    parent: PersonRef,
    options: { familyId?: string; pedigree?: Pedigree },
  ): Promise<PersonChange>;
  addPartner(
    personId: string,
    partner: PersonRef,
    options: { familyId?: string },
  ): Promise<PersonChange>;
  addChild(
    parentId: string,
    child: PersonRef,
    options: { familyId?: string; pedigree?: Pedigree },
  ): Promise<PersonChange>;
  removeChild(familyId: string, childId: string): Promise<TreeState>;
  removePartner(familyId: string, personId: string): Promise<TreeState>;
  setPedigree(familyId: string, childId: string, pedigree: Pedigree): Promise<TreeState>;
  /** Merges `mergeId` into `keepId`: one person is left, with everything both records had. */
  mergePersons(keepId: string, mergeId: string): Promise<MergeInfo>;
  /** Records that two people are not the same person, so they are not offered as duplicates again. */
  markNotDuplicate(personId: string, otherId: string): Promise<TreeState>;
  createSource(source: SourceInput): Promise<SourceChange>;
  updateSource(sourceId: string, source: SourceInput): Promise<TreeState>;
  /** Deletes a source together with every citation of it. */
  deleteSource(sourceId: string): Promise<TreeState>;
  /** Cites a source for a fact. With `create`, the source is made in the same undo step. */
  addCitation(
    target: CitationTarget,
    source: SourceRef,
    citation: CitationInput,
  ): Promise<TreeState>;
  /** Changes a citation, for every fact it supports. */
  updateCitation(citationId: string, citation: CitationInput): Promise<TreeState>;
  /** Uses a citation that exists for one more fact. */
  linkCitation(citationId: string, target: CitationTarget): Promise<TreeState>;
  /** Takes a citation away from one fact. It is deleted when that was the last fact it supported. */
  unlinkCitation(citationId: string, target: CitationTarget): Promise<TreeState>;
  /** Deletes a citation, for every fact it supports. */
  deleteCitation(citationId: string): Promise<TreeState>;
  /**
   * Shows the system file picker and takes the files chosen into the tree,
   * attached to `target`, or to nothing for null. A file the tree holds
   * already is attached, not copied again. Null when cancelled.
   */
  addMedia(target: MediaTarget | null): Promise<MediaAddResult | null>;
  updateMedia(mediaId: string, media: MediaInput): Promise<TreeState>;
  /** Takes a file away from one thing. The file stays in the tree. */
  unlinkMedia(mediaId: string, target: MediaTarget): Promise<TreeState>;
  /** Deletes a file from the tree, wherever it is attached. Its copy stays in the tree folder for Undo. */
  deleteMedia(mediaId: string): Promise<TreeState>;
  /**
   * Shows the system file picker and gives the file chosen to a row whose
   * file is not in the tree: one an imported GEDCOM file names, or one whose
   * copy has gone from the media folder. Null when cancelled.
   */
  chooseMediaFile(mediaId: string): Promise<TreeState | null>;
  /**
   * Shows the system folder picker and looks in the folder chosen, and the
   * folders inside it, for the files the tree knows of and does not hold.
   * Those it finds are taken into the tree as one undo step. Null when cancelled.
   */
  findMediaFiles(): Promise<MediaFindResult | null>;
  undo(): Promise<TreeState>;
  redo(): Promise<TreeState>;

  // Backups of the open tree.
  listBackups(): Promise<BackupInfo[]>;
  /** Makes a backup now. `created` is null when the newest backup already holds the same data. */
  backupNow(): Promise<{ tree: TreeState; created: BackupInfo | null }>;
  /** Replaces the open tree with one of its backups, after backing up its present state. */
  restoreBackup(name: string): Promise<TreeState>;
  /** Shows the tree's backups folder in File Explorer. */
  showBackupsFolder(): Promise<void>;

  // The files of the open tree, outside the app.
  /** Opens a file in the program Windows uses for its kind. Refused for kinds that could run. */
  openMedia(mediaId: string): Promise<void>;
  /** Shows a file in File Explorer, inside the tree's media folder. */
  showMediaInFolder(mediaId: string): Promise<void>;
}

export type ApiMethod = keyof RulzApi;

/**
 * Every function of {@link RulzApi}, by name. The preload script exposes
 * exactly these and the main process handles exactly these.
 */
export const API_METHODS = [
  'getAppInfo',
  'getStartInfo',
  'chooseParentFolder',
  'createTree',
  'openTreeFromDialog',
  'openRecentTree',
  'forgetRecentTree',
  'closeTree',
  'importGedcom',
  'exportGedcom',
  'countPresumedLiving',
  'listPersons',
  'getPersonPage',
  'getPersonLife',
  'getRecordSearch',
  'agreeToRecordSearch',
  'searchRecords',
  'searchRecordTexts',
  'cancelRecordSearch',
  'attachRecord',
  'openRecordLink',
  'getChart',
  'getRelationship',
  'findDuplicates',
  'listSources',
  'getSource',
  'listMedia',
  'listAllMedia',
  'getMedia',
  'listPlaces',
  'suggestPlaces',
  'offerPlace',
  'getGazetteerStatus',
  'downloadGazetteer',
  'cancelGazetteerDownload',
  'removeGazetteer',
  'addPerson',
  'updatePerson',
  'deletePerson',
  'addName',
  'updateName',
  'setPrimaryName',
  'deleteName',
  'addPersonEvent',
  'addFamilyEvent',
  'updateEvent',
  'deleteEvent',
  'linkPlace',
  'unlinkPlace',
  'addParent',
  'addPartner',
  'addChild',
  'removeChild',
  'removePartner',
  'setPedigree',
  'mergePersons',
  'markNotDuplicate',
  'createSource',
  'updateSource',
  'deleteSource',
  'addCitation',
  'updateCitation',
  'linkCitation',
  'unlinkCitation',
  'deleteCitation',
  'addMedia',
  'updateMedia',
  'unlinkMedia',
  'deleteMedia',
  'chooseMediaFile',
  'findMediaFiles',
  'undo',
  'redo',
  'listBackups',
  'backupNow',
  'restoreBackup',
  'showBackupsFolder',
  'openMedia',
  'showMediaInFolder',
] as const satisfies readonly ApiMethod[];

// Fails to compile when a function of RulzApi is missing from the list above.
type MissingMethod = Exclude<ApiMethod, (typeof API_METHODS)[number]>;
export const ALL_METHODS_LISTED: MissingMethod extends never ? true : never = true;

/** The IPC channel a function travels on. */
export function channelFor(method: ApiMethod): string {
  return `rulz:${method}`;
}

/**
 * Why a call failed:
 * - `invalid`: the arguments were not what the function accepts.
 * - `no-tree`: the function needs an open tree and none is open.
 * - `not-found`: the record named no longer exists, e.g. it was undone.
 * - `rule`: the request was understood but is not allowed; the message says why.
 * - `failed`: something unexpected went wrong.
 */
export type IpcErrorCode = 'invalid' | 'no-tree' | 'not-found' | 'rule' | 'failed';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

/**
 * How every call answers. Errors travel as data because an exception that
 * crosses from the main process keeps only its message, wrapped in other text.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** What the preload script puts on `window.rulz`: each function, answering with an {@link IpcResult}. */
export type RulzBridge = {
  [K in ApiMethod]: (
    ...args: Parameters<RulzApi[K]>
  ) => Promise<IpcResult<Awaited<ReturnType<RulzApi[K]>>>>;
};
