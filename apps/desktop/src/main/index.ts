import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session as electronSession,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { manifestsByTier } from '@rulz/connectors';
import { checkTreeEngine, getSqliteInfo, openOrResetAppDatabase, type Db } from '@rulz/db';
import { API_METHODS, channelFor, type AppInfo, type IpcResult } from '../shared/ipc';
import { createHandlers, toIpcError, type Platform } from './handlers';
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
};

function registerIpc(session: TreeSession): void {
  const handlers = createHandlers(session, platform);
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

    registerIpc(treeSession);
    mainWindow = createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  });
}
