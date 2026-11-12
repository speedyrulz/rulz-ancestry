/**
 * The contract between the main process and the renderer. The renderer can
 * only reach the main process through the functions listed in {@link RulzApi}.
 *
 * The data shapes are declared here, not imported from the database package,
 * so the renderer never depends on code that needs Node.js. The main process
 * returns database records that fit these shapes; the compiler checks that.
 */
import type {
  DateCalendar,
  DateQualifier,
  GedcomVersion,
  NameType,
  Pedigree,
  Sex,
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
  person: { id: string; sex: Sex; living: boolean | null };
  summary: PersonSummary;
  names: PersonNameInfo[];
  events: EventInfo[];
  parentFamilies: ParentFamilyInfo[];
  partnerFamilies: PartnerFamilyInfo[];
  /**
   * For a person who came from a GEDCOM file: the lines of their record that
   * the app has no fields for (sources, notes, other programs' own tags). They
   * are kept as written and go back into an export. Empty for anyone else.
   */
  keptLines: string[];
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
  deathDate?: string;
  deathPlace?: string;
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
  /** Records the app keeps as written because it has no screens for them yet: sources, notes, media. */
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
   * Shows the system file picker, makes a new tree from the GEDCOM file chosen
   * and opens it. The tree's folder is made inside `parentDir`, as for
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

  // Changing the open tree. Each call is one undo step.
  addPerson(draft: PersonDraft): Promise<PersonChange>;
  updatePerson(personId: string, patch: { sex?: Sex; living?: boolean | null }): Promise<TreeState>;
  deletePerson(personId: string): Promise<TreeState>;
  addName(personId: string, name: NameInput & { primary?: boolean }): Promise<TreeState>;
  updateName(nameId: string, name: NameInput): Promise<TreeState>;
  setPrimaryName(nameId: string): Promise<TreeState>;
  deleteName(nameId: string): Promise<TreeState>;
  addPersonEvent(personId: string, event: EventInput): Promise<TreeState>;
  addFamilyEvent(familyId: string, event: EventInput): Promise<TreeState>;
  updateEvent(eventId: string, event: EventInput): Promise<TreeState>;
  deleteEvent(eventId: string): Promise<TreeState>;
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
  'addParent',
  'addPartner',
  'addChild',
  'removeChild',
  'removePartner',
  'setPedigree',
  'undo',
  'redo',
  'listBackups',
  'backupNow',
  'restoreBackup',
  'showBackupsFolder',
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
