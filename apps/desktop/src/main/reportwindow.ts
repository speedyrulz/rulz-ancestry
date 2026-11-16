import { BrowserWindow, session, type Session, type WebContents } from 'electron';
import {
  REPORT_MARGINS,
  isReportRequestAllowed,
  reportDataUrl,
  type ReportRenderJob,
} from './report';

/**
 * The Electron half of making a report: a hidden window, sealed as
 * `job.seal` says, that holds the report's HTML just long enough to turn it
 * into a PDF or send it to a printer. The window is closed in every case.
 */

/**
 * One session for every report, set up once. A partition that does not start
 * with "persist:" lives in memory only, and it is emptied after each report.
 */
let sealedSession: Session | null = null;

function sealedSessionOnce(): Session {
  if (sealedSession !== null) return sealedSession;
  const sealed = session.fromPartition('report-sealed');
  sealed.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isReportRequestAllowed(details.url) });
  });
  sealed.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sealed.setPermissionCheckHandler(() => false);
  sealedSession = sealed;
  return sealed;
}

async function inSealedWindow<T>(
  job: ReportRenderJob,
  use: (contents: WebContents) => Promise<T>,
): Promise<T> {
  const sealed = sealedSessionOnce();

  const window = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 900,
    height: 1200,
    webPreferences: {
      session: sealed,
      javascript: job.seal.javascript,
      sandbox: job.seal.sandbox,
      contextIsolation: job.seal.contextIsolation,
      nodeIntegration: job.seal.nodeIntegration,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      spellcheck: false,
    },
  });
  try {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadURL(reportDataUrl(job.html));
    return await use(window.webContents);
  } finally {
    window.destroy();
    sealed.closeAllConnections().catch(() => undefined);
    sealed.clearStorageData().catch(() => undefined);
    sealed.clearCache().catch(() => undefined);
  }
}

/** Renders the report to a PDF with page numbers and an outline of its headings. */
export function renderReportPdf(job: ReportRenderJob): Promise<Uint8Array> {
  return inSealedWindow(job, (contents) =>
    contents.printToPDF({
      pageSize: job.paper,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: job.footerTemplate,
      margins: REPORT_MARGINS,
      generateDocumentOutline: true,
    }),
  );
}

/** Sends the report to a printer through the system's print dialog. False when the user cancels. */
export function printReportPages(job: ReportRenderJob): Promise<boolean> {
  return inSealedWindow(
    job,
    (contents) =>
      new Promise<boolean>((resolve, reject) => {
        // Electron 45 has no switch for Chromium's page header and footer (the title and
        // the data address). They are printed only when `header` or `footer` text is
        // given, so neither is passed.
        contents.print({ silent: false, printBackground: true, pageSize: job.paper }, (ok, why) => {
          if (ok) resolve(true);
          else if (why === 'cancelled' || why === 'Print job canceled') resolve(false);
          else reject(new Error(why === '' ? 'the report could not be printed' : why));
        });
      }),
  );
}
