import { createReadStream, existsSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { manifestsByTier } from '@rulz/connectors';
import {
  checkTreeEngine,
  getSetting,
  getSqliteInfo,
  openOrResetAppDatabase,
  type Db,
} from '@rulz/db';
import { API_METHODS, MEDIA_SCHEME, channelFor, type AppInfo, type IpcResult } from '../shared/ipc';
import { AiBridgeServer } from './aibridge';
import { makeApiClient, runApi } from './aiapi';
import { AiSessionService, type AiConnector } from './aisession';
import { USUAL_PROFILES } from '../bridge/profile';
import { packsPath, profilePath, treesPath } from './rename';
import { connectorCommandOf } from './connectorcommand';
import { createHandlers, toIpcError, type Platform } from './handlers';
import { printReportPages, renderReportPdf } from './reportwindow';
import { GazetteerService } from './gazetteer';
import { CensusOffers } from './censusoffers';
import { CensusService } from './censuspages';
import { workerBuildRunner } from './packbuild';
import buildWorkerPath from './packbuild.worker?modulePath';
import { PackOffers } from './packoffers';
import { PACKS_ROOT_SETTING, PackManager } from './packs';
import { PackSearch, workerSearchChannel } from './packsearch';
import searchWorkerPath from './packsearch.worker?modulePath';
import { RecordRun } from './recordrun';
import { RecordSearchService } from './records';
import { findMediaFile } from './mediafiles';
import { TreeSession } from './session';

/** Must match `appId` in electron-builder.yml so Windows groups taskbar entries correctly. */
const APP_ID = 'com.rulz.kinspora';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(import.meta.dirname, '../renderer/index.html');
/** The one page this app is allowed to show. */
const appUrl = devServerUrl ?? pathToFileURL(rendererFile).href;

let mainWindow: BrowserWindow | undefined;
let appDb: Db | undefined;
let appDbPath = '';
let aiSession: AiSessionService | undefined;
let treeSession: TreeSession | undefined;
let gazetteer: GazetteerService | undefined;
let packs: PackManager | undefined;
let censusService: CensusService | undefined;
let treeEngine: AppInfo['treeEngine'] = { ok: false, error: 'not checked yet' };
/** True once a job of the packs was told to stop for the quit. */
let packsStopped = false;

/** A failed check is shown in the window; it must not stop the app from opening. */
function runTreeEngineCheck(): AppInfo['treeEngine'] {
  try {
    return { ok: true, ...checkTreeEngine() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isAppUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    const expected = new URL(appUrl);
    return (
      url.protocol === expected.protocol &&
      url.host === expected.host &&
      url.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function isSafeExternalUrl(candidate: string): boolean {
  try {
    return new URL(candidate).protocol === 'https:';
  } catch {
    return false;
  }
}

/** IPC handlers answer only the app's own page, never an embedded or navigated-to frame. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isAppUrl(senderUrl)) {
    throw new Error(`blocked IPC call from untrusted frame: ${senderUrl ?? 'unknown'}`);
  }
}

/**
 * Where a new tree's folder is made by default. A run with its own profile
 * folder (the end-to-end tests, or a portable copy) keeps its trees inside
 * that folder, so it never writes to the user's Documents.
 */
function defaultTreesDir(): string {
  if (app.commandLine.hasSwitch('user-data-dir')) return join(app.getPath('userData'), 'Trees');
  return treesPath(app.getPath('documents'), app.isPackaged, existsSync);
}

/**
 * Where the data packs are kept. A copy that is not installed (run from the
 * source code, or with a profile folder of its own, as the end-to-end tests do)
 * keeps them inside its profile folder, so that it never touches the packs of
 * an installed copy. The installed app keeps them under the user's local data,
 * out of the roaming profile, since a pack is large and can be built again.
 */
function defaultPacksRoot(): string {
  if (!app.isPackaged || app.commandLine.hasSwitch('user-data-dir')) {
    return join(app.getPath('userData'), 'packs');
  }
  const base = process.env['LOCALAPPDATA'] ?? app.getPath('appData');
  const kept = appDb ? getSetting(appDb, PACKS_ROOT_SETTING) : null;
  if (kept && isAbsolute(kept)) return join(base, 'RulZKinspora', 'packs');
  return packsPath(base, { exists: existsSync, rename: renameSync }, readdirSync);
}

/**
 * The switch the end-to-end tests start the app with, so that a test run does
 * not get in the way of whoever is working at the PC: the window opens beyond
 * the edge of the screen, takes no focus and has no button on the taskbar.
 * It is drawn and behaves as any window, which a hidden one would not.
 */
const BACKGROUND_SWITCH = 'background-window';

/** Far enough to the left and above to be on no screen. */
const OFF_SCREEN = -20_000;

/**
 * What this copy of the app hands out so that an AI app can be connected:
 * the connector file for Claude Desktop, and the command that adds the same
 * bridge to Claude Code. Both are made by the build (`scripts/connector.mjs`)
 * and lie beside the app's code; in the packaged app they are kept outside
 * its archive, since another program has to read them. Null when they are
 * not there, as in a copy that was started without being built whole.
 *
 * Told nothing, the bridge looks for the app's data where an installed copy
 * keeps it, and then where a copy started from the source code does
 * (`bridge/profile.ts`). Where this copy keeps its data in neither (one
 * started with a folder of its own), the window says so; and the command
 * names every folder but that of an installed copy.
 */
function findConnector(): AiConnector | null {
  const dir = join(app.getAppPath(), 'out', 'connector').replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2',
  );
  const file = join(dir, 'rulz-kinspora.mcpb');
  const bridge = join(dir, 'bridge.cjs');
  if (!existsSync(file) || !existsSync(bridge)) return null;
  const profile = app.getPath('userData');
  const usual = USUAL_PROFILES.map((name) => join(app.getPath('appData'), name));
  return { file, profile, ...connectorCommandOf({ bridge, profile, usual }) };
}

function createMainWindow(): BrowserWindow {
  const background = app.commandLine.hasSwitch(BACKGROUND_SWITCH);
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    ...(background ? { x: OFF_SCREEN, y: OFF_SCREEN, skipTaskbar: true } : {}),
    show: false,
    title: 'RulZ Kinspora',
    autoHideMenuBar: true,
    // The page's own background (styles.css), shown before the page has drawn.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#050505' : '#ffffff',
    // Packaged: copied beside app.asar by extraResources in electron-builder.yml.
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(import.meta.dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // A window nobody looks at would be slowed down; a test must not be.
      ...(background ? { backgroundThrottling: false } : {}),
    },
  });

  window.once('ready-to-show', () => {
    if (background) window.showInactive();
    else window.show();
  });

  // Links to outside sites open in the user's browser; the app never opens
  // a second window or navigates its own window away from the app page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererFile);
  }
  return window;
}

const platform: Platform = {
  async openInBrowser(url) {
    if (!isSafeExternalUrl(url)) throw new Error('only an https address is opened in the browser');
    await shell.openExternal(url);
  },

  appInfo() {
    if (!appDb) throw new Error('application database is not open');
    return {
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      database: { path: appDbPath, ...getSqliteInfo(appDb) },
      treeEngine,
      connectors: {
        api: manifestsByTier('api').length,
        bulk: manifestsByTier('bulk').length,
        deeplink: manifestsByTier('deeplink').length,
      },
    };
  },

  async chooseFolder(options) {
    const settings = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, settings)
      : await dialog.showOpenDialog(settings);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },

  async chooseFileToOpen(options) {
    const settings = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties: ['openFile'],
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, settings)
      : await dialog.showOpenDialog(settings);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },

  async chooseFilesToOpen(options) {
    const settings = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      filters: options.filters,
      properties: ['openFile', 'multiSelections'],
    } satisfies Electron.OpenDialogOptions;
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, settings)
      : await dialog.showOpenDialog(settings);
    return result.canceled ? [] : result.filePaths;
  },

  async chooseFileToSave(options) {
    // Windows itself asks before an existing file is replaced.
    const settings = {
      title: options.title,
      buttonLabel: options.buttonLabel,
      defaultPath: options.defaultPath,
      filters: options.filters,
    } satisfies Electron.SaveDialogOptions;
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, settings)
      : await dialog.showSaveDialog(settings);
    return result.canceled || result.filePath === '' ? null : result.filePath;
  },

  async openFolder(dir) {
    const problem = await shell.openPath(dir);
    if (problem !== '') throw new Error(problem);
  },

  async openFile(file) {
    const problem = await shell.openPath(file);
    if (problem !== '') throw new Error(problem);
  },

  showFileInFolder(file) {
    shell.showItemInFolder(file);
  },

  copyText(text) {
    clipboard.writeText(text);
  },

  reportToPdf: renderReportPdf,

  printReport: printReportPages,
};

/** The longest side of the small pictures shown in lists, in pixels. */
const THUMBNAIL_SIZE = 320;

/**
 * A file of a tree never changes once it is stored, and its address holds the
 * id of its row, so the window may keep what it was sent.
 */
const MEDIA_HEADERS = {
  'cache-control': 'private, max-age=31536000, immutable',
  'x-content-type-options': 'nosniff',
};

/**
 * Answers an address of the media scheme with a picture from the open tree,
 * or with "not found". Which file an address stands for is decided in
 * `findMediaFile`; this only reads it.
 */
async function serveMedia(request: Request): Promise<Response> {
  const notFound = () => new Response(null, { status: 404 });
  if (request.method !== 'GET' || !treeSession) return notFound();
  let file;
  try {
    file = findMediaFile(treeSession, request.url);
  } catch {
    file = null;
  }
  if (file === null) return notFound();

  if (file.variant === 'thumb') {
    // Windows makes the preview and keeps it in its own cache. It can do so
    // for more kinds of file than the window can draw, a PDF for one.
    try {
      const image = await nativeImage.createThumbnailFromPath(file.path, {
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
      });
      if (!image.isEmpty()) {
        return new Response(new Uint8Array(image.toPNG()), {
          headers: { ...MEDIA_HEADERS, 'content-type': 'image/png' },
        });
      }
    } catch {
      // No preview to be had; a picture is then shown from the file itself.
    }
    if (file.kind !== 'image') return notFound();
  }

  const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      ...MEDIA_HEADERS,
      'content-type': file.mime,
      'content-length': String(file.size),
    },
  });
}

/** The network session of the search for records. Without "persist:" it is kept in memory only. */
const RECORDS_PARTITION = 'records';

function registerIpc(
  session: TreeSession,
  places: GazetteerService,
  records: RecordSearchService,
  ai: AiSessionService,
  runs: RecordRun,
  packManager: PackManager,
  packOffers: PackOffers,
  censusOffers: CensusOffers,
  census: CensusService,
): void {
  const handlers = createHandlers(
    session,
    platform,
    places,
    records,
    ai,
    runs,
    packManager,
    packOffers,
    censusOffers,
    census,
  );
  for (const method of API_METHODS) {
    ipcMain.handle(
      channelFor(method),
      async (event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
        try {
          assertTrustedSender(event);
          return { ok: true, value: await handlers[method](...args) };
        } catch (error) {
          return { ok: false, error: toIpcError(error) };
        }
      },
    );
  }
}

// Development runs keep their data apart from an installed copy of the app,
// unless a profile folder was given explicitly (the end-to-end tests do that).
// This must happen before the single-instance lock, which is tied to the folder.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath(
    'userData',
    profilePath(app.getPath('appData'), app.isPackaged, false, app.getPath('userData'), {
      exists: existsSync,
      rename: renameSync,
      removeEmptyDir: rmdirSync,
    }),
  );
}

// Every renderer is sandboxed, including any created by mistake later.
app.enableSandbox();

// The page loads the pictures of a tree from addresses of this scheme. It
// must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
]);

// Two instances writing one SQLite file would fight over locks, so allow one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('window-all-closed', () => app.quit());

  // A session ends with the app, while its end can still be written to the
  // log. The pipe an AI app reached it by goes with it.
  app.on('before-quit', (event) => {
    aiSession?.stop('quit');
    censusService?.cancelImage();
    // A pack that is being built is given up, and what it made so far is
    // deleted, before the app goes: the quit waits for that, a few seconds at most.
    if (packs?.running === true && !packsStopped) {
      packsStopped = true;
      event.preventDefault();
      void packs.shutdown().finally(() => app.quit());
    }
  });

  app.on('will-quit', () => {
    // Backs up the open tree if it changed, then closes it.
    const closed = treeSession?.shutdown();
    if (closed?.backupError) console.error(`backup on quit failed: ${closed.backupError}`);
    treeSession = undefined;
    gazetteer?.close();
    gazetteer = undefined;
    // Ends the worker that searches the packs; the file of a pack is let go of.
    void packs?.shutdown(0);
    packs = undefined;
    appDb?.close();
    appDb = undefined;
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);

    // The app needs no camera, microphone, location or notification access.
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );

    appDbPath = join(app.getPath('userData'), 'app.db');
    // A damaged settings file must not stop the app from starting. It holds
    // the recent list and settings only; trees are in their own folders.
    const opening = openOrResetAppDatabase(appDbPath);
    appDb = opening.db;
    if (opening.setAside !== null) {
      console.warn(`app.db could not be used and was set aside as ${opening.setAside}`);
    }
    treeEngine = runTreeEngineCheck();

    treeSession = new TreeSession({ appDb, defaultParentDir: defaultTreesDir() });
    treeSession.start();

    // The list of the world's places, downloaded from GeoNames when the user
    // asks for it. `net.fetch` is looked up at each call, and uses the
    // system's proxy.
    gazetteer = new GazetteerService({
      dir: join(app.getPath('userData'), 'gazetteer'),
      fetch: (url, init) => net.fetch(url, init),
    });

    // The data packs: records of a source, built on this PC from the files the
    // source publishes and searched here, with no request to anyone. A pack is
    // downloaded only when a job is started (`packs.ts`). Searching and
    // building each run in a worker thread of their own.
    const packSearch = new PackSearch({
      spawn: () => workerSearchChannel(searchWorkerPath),
      pathOf: (id) => manager.pathOf(id),
    });
    const manager: PackManager = new PackManager({
      appDb,
      defaultRoot: defaultPacksRoot(),
      fetch: (url, init) => net.fetch(url, init),
      appVersion: app.getVersion(),
      search: packSearch,
      build: workerBuildRunner(buildWorkerPath),
    });
    packs = manager;
    // The archives of Open Archives that can be installed as packs. Asked
    // only when the user presses a button; `net.fetch` is looked up at each call.
    const packOffers = new PackOffers({
      fetch: (url, init) => net.fetch(url, init),
      appVersion: app.getVersion(),
      packs: manager,
    });
    // The states of the 1950 census that can be installed as packs. Asked
    // only when the user presses a button.
    const censusOffers = new CensusOffers({
      fetch: (url, init) => net.fetch(url, init),
      appVersion: app.getVersion(),
      packs: manager,
    });
    try {
      manager.start();
    } catch (error) {
      console.error(`the packs folder could not be swept: ${String(error)}`);
    }

    // The search for records outside the tree: the other request the app
    // makes of the internet, and the only one that sends something of a tree.
    // See `records.ts` for what it sends and when.
    // It asks through a session of its own that lives in memory only, so
    // that no cookie and no answer of a source is ever written to disk, and
    // a source cannot tell by a cookie that two searches came from one PC.
    const secrets = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text: string) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (kept: string) => safeStorage.decryptString(Buffer.from(kept, 'base64')),
    };
    const records = new RecordSearchService({
      appDb,
      fetch: (url, init) => electronSession.fromPartition(RECORDS_PARTITION).fetch(url, init),
      appVersion: app.getVersion(),
      packs: manager,
      // A key of the user's own is encrypted by Windows for their account
      // (DPAPI) before it is written to the settings, and never kept as it is.
      secrets,
    });

    // Browsing the packs of the 1950 census. The one request it makes is for a
    // page image of the census bucket, when the user views a page.
    const census = new CensusService({
      packs: manager,
      fetch: (url, init) => net.fetch(url, init),
      appVersion: app.getVersion(),
      agreed: () => records.agreed,
      openInBrowser: (url) => platform.openInBrowser(url),
    });
    censusService = census;

    const runs = new RecordRun(records);
    // The optional AI assistant. It is off until the user turns it on, and
    // its tools give nothing outside a session the user started.
    // An AI app reaches a session through the bridge, over a pipe of this PC
    // that is there only while a session is under way.
    const bridge = new AiBridgeServer({
      dir: app.getPath('userData'),
      call: (name, input) => ai.call(name, input),
    });
    // A file left by a run that was ended by force names a pipe that is gone.
    bridge.forgetFile();
    const ai: AiSessionService = new AiSessionService(records, {
      appDb,
      bridge,
      secrets,
      runApi,
      makeApiClient: (key) =>
        makeApiClient(key, (url, init) =>
          electronSession
            .fromPartition('ai-api')
            .fetch(url instanceof URL ? url.toString() : url, init),
        ),
      connector: findConnector(),
    });
    aiSession = ai;
    registerIpc(
      treeSession,
      gazetteer,
      records,
      ai,
      runs,
      manager,
      packOffers,
      censusOffers,
      census,
    );
    protocol.handle(MEDIA_SCHEME, serveMedia);
    mainWindow = createMainWindow();
    // A search belongs to the window that started it. When the page is loaded
    // again or its process is gone, that window is no more, and nothing tells
    // the search so from the page: so it is ended here. Nothing is asked for
    // a window that is not there. A session of the AI assistant ends too: the
    // page is where the user sees what an AI asks, and where they stop it.
    // What it proposed stays.
    const pageGone = (): void => {
      runs.stop();
      ai.stop('page');
      records.cancel();
      census.cancelImage();
    };
    mainWindow.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) pageGone();
    });
    mainWindow.webContents.on('render-process-gone', pageGone);
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  });
}
