import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import { manifestsByTier } from '@rulz/connectors';
import { checkTreeEngine, getSqliteInfo, openDatabase, type Db } from '@rulz/db';
import { IPC, type AppInfo } from '../shared/ipc';

/** Must match `appId` in electron-builder.yml so Windows groups taskbar entries correctly. */
const APP_ID = 'com.rulz.ancestry';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const rendererFile = join(import.meta.dirname, '../renderer/index.html');
/** The one page this app is allowed to show. */
const appUrl = devServerUrl ?? pathToFileURL(rendererFile).href;

let mainWindow: BrowserWindow | undefined;
let appDb: Db | undefined;
let appDbPath = '';
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

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (event): AppInfo => {
    assertTrustedSender(event);
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
  });
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
    appDb?.close();
    appDb = undefined;
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);

    // The app needs no camera, microphone, location or notification access.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );

    appDbPath = join(app.getPath('userData'), 'app.db');
    appDb = openDatabase(appDbPath);
    treeEngine = runTreeEngineCheck();

    registerIpc();
    mainWindow = createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  });
}
