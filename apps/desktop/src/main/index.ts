import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  session as electronSession,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { manifestsByTier } from '@rulz/connectors';
import { checkTreeEngine, getSqliteInfo, openOrResetAppDatabase, type Db } from '@rulz/db';
import { API_METHODS, MEDIA_SCHEME, channelFor, type AppInfo, type IpcResult } from '../shared/ipc';
import { createHandlers, toIpcError, type Platform } from './handlers';
import { GazetteerService } from './gazetteer';
import { RecordSearchService } from './records';
import { findMediaFile } from './mediafiles';
import { TreeSession } from './session';

/** Must match `appId` in electron-builder.yml so Windows groups taskbar entries correctly. */
const APP_ID = 'com.rulz.ancestry';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(import.meta.dirname, '../renderer/index.html');
/** The one page this app is allowed to show. */
const appUrl = devServerUrl ?? pathToFileURL(rendererFile).href;

let mainWindow: BrowserWindow | undefined;
let appDb: Db | undefined;
let appDbPath = '';
let treeSession: TreeSession | undefined;
let gazetteer: GazetteerService | undefined;
let treeEngine: AppInfo['treeEngine'] = { ok: false, error: 'not checked yet' };

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
  return join(app.getPath('documents'), app.isPackaged ? 'RulZ Ancestry' : 'RulZ Ancestry (dev)');
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'RulZ Ancestry',
    autoHideMenuBar: true,
    backgroundColor: '#f6f4ef',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => window.show());

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
): void {
  const handlers = createHandlers(session, platform, places, records);
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
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'RulZ Ancestry (dev)'));
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

  app.on('will-quit', () => {
    // Backs up the open tree if it changed, then closes it.
    const closed = treeSession?.shutdown();
    if (closed?.backupError) console.error(`backup on quit failed: ${closed.backupError}`);
    treeSession = undefined;
    gazetteer?.close();
    gazetteer = undefined;
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

    // The search for records outside the tree: the other request the app
    // makes of the internet, and the only one that sends something of a tree.
    // See `records.ts` for what it sends and when.
    // It asks through a session of its own that lives in memory only, so
    // that no cookie and no answer of a source is ever written to disk, and
    // a source cannot tell by a cookie that two searches came from one PC.
    const records = new RecordSearchService({
      appDb,
      fetch: (url, init) => electronSession.fromPartition(RECORDS_PARTITION).fetch(url, init),
      appVersion: app.getVersion(),
    });

    registerIpc(treeSession, gazetteer, records);
    protocol.handle(MEDIA_SCHEME, serveMedia);
    mainWindow = createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  });
}
