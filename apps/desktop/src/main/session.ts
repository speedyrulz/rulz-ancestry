import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  BACKUP_DIR_NAME,
  MEDIA_DIR_NAME,
  TREE_FILE_NAME,
  backupTree,
  createTree,
  exportGedcomFile,
  forgetTree,
  getSetting,
  hasTree,
  importGedcom,
  listBackups,
  listRecentTrees,
  openExistingTree,
  readGedcomFile,
  rememberTree,
  restoreBackup,
  setSetting,
  treeFolderName,
  type BackupInfo,
  type Db,
  type GedcomExportOptions,
  type GedcomExportResult,
  type GedcomImportReport,
  type GedcomInput,
  type Tree,
} from '@rulz/db';
import type { RecentTreeInfo, StartInfo, TreeState } from '../shared/ipc';

/**
 * The tree the app has open, and the bookkeeping around it: the recent list,
 * reopening the last tree at start-up, the backup made on closing, and a
 * revision counter that tells the screens when to reload.
 *
 * Nothing here uses Electron, so it runs under the unit tests as it is.
 */

/** The app setting that holds the folder of the tree to reopen at the next start. */
const OPEN_TREE_SETTING = 'open_tree_dir';

/** A request needs an open tree and none is open. */
export class NoOpenTreeError extends Error {
  constructor() {
    super('no family tree is open');
    this.name = 'NoOpenTreeError';
  }
}

/** A request the session does not allow; the message says why. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface SessionOptions {
  /** The application database, which holds the recent list and settings. */
  appDb: Db;
  /** Where a new tree's folder is made unless the user chooses somewhere else. */
  defaultParentDir: string;
  /** The clock, replaceable in tests. */
  now?: () => number;
}

function pathKey(path: string): string {
  const full = resolve(path);
  // Windows treats C:\Trees and c:\trees as one folder.
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A folder inside `parent` for a new tree, named `folder` or, when a folder of
 * that name is already in use, `folder (2)`, `folder (3)` and so on. An import
 * names the tree after the file, and the same file may be imported twice.
 */
function freeTreeDir(parent: string, folder: string): string {
  for (let copy = 1; copy < 1000; copy += 1) {
    const dir = join(parent, copy === 1 ? folder : `${folder} (${copy})`);
    if (!existsSync(dir)) return dir;
    try {
      if (readdirSync(dir).length === 0) return dir;
    } catch {
      // Not a folder, or not readable: try the next name.
    }
  }
  throw new SessionError(`there are too many folders named ${folder} in ${parent}`);
}

export class TreeSession {
  readonly defaultParentDir: string;
  readonly #appDb: Db;
  readonly #now: () => number;
  /** Folders the user picked in the system dialog during this run. */
  readonly #chosenParentDirs = new Set<string>();
  #tree: Tree | null = null;
  #revision = 0;
  #lastBackupAt: number | null = null;
  #reopenError: string | null = null;
  readonly #closeListeners: (() => void)[] = [];

  constructor(options: SessionOptions) {
    this.#appDb = options.appDb;
    this.defaultParentDir = resolve(options.defaultParentDir);
    this.#now = options.now ?? Date.now;
  }

  /** Reopens the tree that was open when the app last quit, if there was one. */
  start(): void {
    const dir = getSetting(this.#appDb, OPEN_TREE_SETTING);
    if (dir === null) return;
    try {
      this.#adopt(openExistingTree(dir));
    } catch (error) {
      // Say so once, then stop trying at every start.
      this.#reopenError = messageOf(error);
      setSetting(this.#appDb, OPEN_TREE_SETTING, null);
    }
  }

  get isOpen(): boolean {
    return this.#tree !== null;
  }

  /** The open tree. Throws {@link NoOpenTreeError} when none is open. */
  get tree(): Tree {
    if (!this.#tree) throw new NoOpenTreeError();
    return this.#tree;
  }

  state(): TreeState {
    const tree = this.tree;
    const info = tree.info();
    const status = tree.undoStatus();
    return {
      dir: tree.dir ?? '',
      id: info.id,
      name: info.name,
      persons: info.persons,
      families: info.families,
      events: info.events,
      sources: info.sources,
      media: info.media,
      undo: status.undo?.label ?? null,
      redo: status.redo?.label ?? null,
      revision: this.#revision,
      lastBackupAt: this.#lastBackupAt,
    };
  }

  recentTrees(): RecentTreeInfo[] {
    return listRecentTrees(this.#appDb).map((recent) => ({
      dir: recent.dir,
      name: recent.name,
      lastOpenedAt: recent.lastOpenedAt,
      available: hasTree(recent.dir),
    }));
  }

  startInfo(): StartInfo {
    return {
      tree: this.#tree ? this.state() : null,
      reopenError: this.#reopenError,
      recent: this.recentTrees(),
      defaultParentDir: this.defaultParentDir,
    };
  }

  /**
   * Records a folder the user picked in the system dialog, so that
   * {@link create} accepts it. Returns the folder's full path.
   */
  allowParentDir(dir: string): string {
    const full = resolve(dir);
    this.#chosenParentDirs.add(pathKey(full));
    return full;
  }

  /**
   * Makes a new tree in a folder named after it, inside `parentDir`. Only the
   * default folder and folders picked in the system dialog are accepted, so
   * the page cannot make the app write to a path of its own choosing.
   */
  create(name: string, parentDir: string): TreeState {
    const parent = this.#allowedParent(parentDir);
    const tree = createTree(join(parent, treeFolderName(name)), { name });
    this.#closeCurrent();
    this.#adopt(tree);
    return this.state();
  }

  /**
   * Makes a new tree from a GEDCOM file and opens it. The tree is named
   * `name`, or after the file when `name` is empty, and its folder is made
   * inside `parentDir` under the same rule as {@link create}. The file is read
   * and checked before any folder is made, and a tree that could not be
   * filled is removed again.
   */
  importGedcom(
    file: string,
    name: string,
    parentDir: string,
  ): { state: TreeState; report: GedcomImportReport } {
    const parent = this.#allowedParent(parentDir);
    const input = readGedcomFile(file);
    try {
      return this.#importInto(parent, name, input);
    } finally {
      // A GEDZip file is an archive, which stays open while its pictures are taken out.
      input.close?.();
    }
  }

  #importInto(
    parent: string,
    name: string,
    input: GedcomInput,
  ): { state: TreeState; report: GedcomImportReport } {
    const stated = name.trim().replace(/\s+/g, ' ');
    const fromFile = basename(input.fileName, extname(input.fileName)).trim();
    const treeName = (stated !== '' ? stated : fromFile).slice(0, 100).trim() || 'Imported tree';

    const dir = freeTreeDir(parent, treeFolderName(treeName));
    const existed = existsSync(dir);
    const tree = createTree(dir, { name: treeName });
    let report: GedcomImportReport;
    try {
      report = importGedcom(tree, input);
    } catch (error) {
      tree.close();
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(join(dir, TREE_FILE_NAME + suffix), { force: true });
      }
      // Pictures that came out of a GEDZip file before the import failed.
      rmSync(join(dir, MEDIA_DIR_NAME), { recursive: true, force: true });
      if (!existed) {
        try {
          rmdirSync(dir);
        } catch {
          // Something else is in the folder already; leave it.
        }
      }
      throw error;
    }
    this.#closeCurrent();
    this.#adopt(tree);
    return { state: this.state(), report };
  }

  /**
   * Where the save dialog for an export starts: beside the tree's folder,
   * named after the tree. A GEDZip file, which carries the pictures and
   * documents, ends in `.gdz`.
   */
  suggestedExportPath(withFiles = false): string {
    const tree = this.tree;
    const folder = tree.dir === null ? this.defaultParentDir : dirname(tree.dir);
    return join(folder, `${treeFolderName(tree.info().name)}.${withFiles ? 'gdz' : 'ged'}`);
  }

  /**
   * Writes the open tree to a GEDCOM file or, with `files`, to a GEDZip file.
   * A name with no extension gets `.ged` or `.gdz`.
   */
  exportGedcom(
    file: string,
    options: Pick<GedcomExportOptions, 'version' | 'includeLiving' | 'appVersion' | 'files'>,
  ): GedcomExportResult & { file: string } {
    const extension = options.files === true ? 'gdz' : 'ged';
    const target = extname(file) === '' ? `${file}.${extension}` : file;
    const result = exportGedcomFile(this.tree, target, { ...options, now: this.#now() });
    return { ...result, file: target };
  }

  /** Opens the tree in `dir`, closing the one that is open. */
  open(dir: string): TreeState {
    const target = resolve(dir);
    if (this.#tree?.dir && pathKey(this.#tree.dir) === pathKey(target)) return this.state();
    // Open the new tree first: if that fails, the present one stays open.
    const tree = openExistingTree(target);
    this.#closeCurrent();
    this.#adopt(tree);
    return this.state();
  }

  /** Opens a tree from the recent list, and nothing else. */
  openRecent(dir: string): TreeState {
    const known = listRecentTrees(this.#appDb).find(
      (recent) => pathKey(recent.dir) === pathKey(dir),
    );
    if (!known) throw new SessionError('that tree is not in the recent list');
    return this.open(known.dir);
  }

  forgetRecent(dir: string): RecentTreeInfo[] {
    forgetTree(this.#appDb, dir);
    return this.recentTrees();
  }

  /**
   * Backs up and closes the open tree because the user asked to. The start
   * screen is shown at the next start. A failed backup does not stop the tree
   * from closing; the reason is returned so it can be shown.
   */
  close(): { backupError: string | null } {
    const result = this.#closeCurrent();
    setSetting(this.#appDb, OPEN_TREE_SETTING, null);
    return result;
  }

  /** Backs up and closes the open tree because the app is quitting. It is reopened next time. */
  shutdown(): { backupError: string | null } {
    return this.#closeCurrent();
  }

  /** Runs a change to the open tree and marks the screens as out of date. */
  change<T>(fn: (tree: Tree) => T): T {
    const result = fn(this.tree);
    this.#revision += 1;
    return result;
  }

  undo(): TreeState {
    if (this.tree.undo()) this.#revision += 1;
    return this.state();
  }

  redo(): TreeState {
    if (this.tree.redo()) this.#revision += 1;
    return this.state();
  }

  /** The folder of the open tree's backups, created if it is not there yet. */
  backupsDir(): string {
    const dir = join(this.#treeDir(), BACKUP_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  listBackups(): BackupInfo[] {
    return listBackups(this.#treeDir());
  }

  /** Backs up the open tree now. Null when the newest backup already holds the same data. */
  backupNow(): BackupInfo | null {
    const { created } = backupTree(this.tree, { now: this.#now() });
    this.#refreshLastBackup();
    return created;
  }

  /**
   * Replaces the open tree with one of its backups. The present state is
   * backed up first, so the restore can itself be reversed.
   */
  restore(name: string): TreeState {
    const tree = this.tree;
    const dir = this.#treeDir();
    // If this fails nothing has been touched yet, and the restore is abandoned.
    backupTree(tree, { now: this.#now() });
    tree.close();
    this.#tree = null;
    try {
      restoreBackup(dir, name);
    } finally {
      // Whatever happened, show the tree that is in the folder now.
      this.#adopt(openExistingTree(dir));
    }
    return this.state();
  }

  /**
   * The full path of a folder that new trees may be made in: the default
   * folder, or one the user picked in the system dialog during this run.
   */
  #allowedParent(parentDir: string): string {
    const parent = resolve(parentDir);
    const allowed =
      pathKey(parent) === pathKey(this.defaultParentDir) ||
      this.#chosenParentDirs.has(pathKey(parent));
    if (!allowed) throw new SessionError('choose the folder for the new tree again');
    return parent;
  }

  #treeDir(): string {
    const dir = this.tree.dir;
    if (dir === null) throw new SessionError('this tree is not stored in a folder');
    return dir;
  }

  #refreshLastBackup(): void {
    const dir = this.#tree?.dir;
    this.#lastBackupAt = dir ? (listBackups(dir)[0]?.at ?? null) : null;
  }

  #adopt(tree: Tree): void {
    this.#tree = tree;
    // The counter never restarts, so a screen cannot mistake one tree's state for another's.
    this.#revision += 1;
    this.#reopenError = null;
    this.#refreshLastBackup();
    if (tree.dir !== null) {
      const info = tree.info();
      rememberTree(this.#appDb, {
        dir: tree.dir,
        treeId: info.id,
        name: info.name,
        lastOpenedAt: this.#now(),
      });
      setSetting(this.#appDb, OPEN_TREE_SETTING, tree.dir);
    }
  }

  /**
   * Has `listener` called whenever the open tree is closed: by the user, by
   * opening another tree, or when the app quits. It is called before the
   * tree's file is closed.
   */
  whenTreeCloses(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  #closeCurrent(): { backupError: string | null } {
    const tree = this.#tree;
    if (!tree) return { backupError: null };
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {
        // A listener that fails must not keep the tree from closing.
      }
    }
    let backupError: string | null = null;
    try {
      if (tree.dir !== null) backupTree(tree, { now: this.#now() });
    } catch (error) {
      backupError = messageOf(error);
    }
    tree.close();
    this.#tree = null;
    this.#lastBackupAt = null;
    return { backupError };
  }
}
