import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expect,
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export type AppTarget = 'built' | 'packaged';

export interface AppOptions {
  /** Which form of the app to launch; set per project in playwright.config.ts. */
  appTarget: AppTarget;
}

interface AppFixtures {
  /**
   * A throwaway profile folder, so tests never touch the real user's data.
   * The app keeps new trees inside it too (in `Trees`), not in Documents.
   */
  userDataDir: string;
  app: ElectronApplication;
  window: Page;
}

const desktopDir = resolve(import.meta.dirname, '..');
const packagedExe = join(desktopDir, 'release', 'win-unpacked', 'RulZ Ancestry.exe');

/** Starts the app with the given profile folder. Tests that restart the app call this again. */
export function launchApp(appTarget: AppTarget, userDataDir: string): Promise<ElectronApplication> {
  const userData = `--user-data-dir=${userDataDir}`;
  return appTarget === 'packaged'
    ? electron.launch({ executablePath: packagedExe, args: [userData] })
    : electron.launch({ args: [desktopDir, userData], cwd: desktopDir });
}

export const test = base.extend<AppOptions & AppFixtures>({
  appTarget: ['built', { option: true }],

  // Playwright requires the first argument to be an object destructuring pattern.
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'rulz-e2e-'));
    await use(dir);
    // SQLite and Chromium release their file handles shortly after exit.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  },

  app: async ({ appTarget, userDataDir }, use) => {
    const app = await launchApp(appTarget, userDataDir);
    await use(app);
    // A test may already have closed the app to restart it.
    await app.close().catch(() => undefined);
  },

  window: async ({ app }, use) => {
    await use(await app.firstWindow());
  },
});

/**
 * Makes the system folder picker answer with `dir` (or as cancelled, for null)
 * without showing it. A real system dialog cannot be driven from a test.
 */
export async function answerFolderPicker(
  app: ElectronApplication,
  dir: string | null,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: chosen === null, filePaths: chosen === null ? [] : [chosen] });
  }, dir);
}

/** Creates a tree from the start screen, in the default place inside the test profile. */
export async function createTree(window: Page, name: string): Promise<void> {
  await window.getByTestId('new-tree-name').fill(name);
  await window.getByTestId('create-tree').click();
  await expect(window.getByTestId('workspace')).toBeVisible();
}

export interface PersonFields {
  given?: string;
  surname?: string;
  /** The label of the option, e.g. "Female". */
  sex?: string;
  birthDate?: string;
  birthPlace?: string;
  deathDate?: string;
  deathPlace?: string;
}

/** Fills the new-person fields of whichever dialog is open. */
export async function fillPerson(window: Page, fields: PersonFields): Promise<void> {
  const text: [keyof PersonFields, string][] = [
    ['given', 'person-given'],
    ['surname', 'person-surname'],
    ['birthDate', 'person-birth-date'],
    ['birthPlace', 'person-birth-place'],
    ['deathDate', 'person-death-date'],
    ['deathPlace', 'person-death-place'],
  ];
  for (const [field, testId] of text) {
    const value = fields[field];
    if (value !== undefined) await window.getByTestId(testId).fill(value);
  }
  if (fields.sex !== undefined) {
    await window.getByTestId('person-sex').selectOption({ label: fields.sex });
  }
}

/** Adds a person with the "Add person" button and waits until their page is shown. */
export async function addPerson(window: Page, fields: PersonFields): Promise<void> {
  await window.getByTestId('add-person').click();
  await expect(window.getByTestId('add-person-dialog')).toBeVisible();
  await fillPerson(window, fields);
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('add-person-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-page')).toBeVisible();
}

/** Submits the relative dialog that a button on the person page opened. */
export async function addRelative(window: Page, fields: PersonFields): Promise<void> {
  await expect(window.getByTestId('relative-dialog')).toBeVisible();
  await fillPerson(window, fields);
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('relative-dialog')).toHaveCount(0);
}

/** Opens a person's page by clicking their row in the list. */
export async function openPerson(window: Page, listName: string): Promise<void> {
  await window.getByTestId('person-row').filter({ hasText: listName }).first().click();
  await expect(window.getByTestId('person-page')).toBeVisible();
}

export { expect } from '@playwright/test';
