import AxeBuilder from '@axe-core/playwright';
import type { ElectronApplication, Page } from '@playwright/test';
import { createTree, expect, test } from './fixtures';

/** The help of the app (part 6.5): reached from both screens, every topic reads, and it is accessible. */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const TOPICS = [
  ['start', 'Starting out'],
  ['import', 'Importing from Ancestry'],
  ['network', 'What leaves your PC, and when'],
  ['living', 'Living people'],
  ['packs', 'Data packs and disk space'],
  ['ai', 'The AI assistant'],
  ['backups', 'Backups'],
  ['updates', 'Updates'],
  ['uninstall', 'Uninstalling'],
  ['smartscreen', 'The SmartScreen warning'],
  ['privacy', 'Privacy'],
] as const;

async function stayOffline(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ net, session }) => {
    const refuse = () => Promise.resolve(new Response('offline', { status: 503 }));
    net.fetch = refuse;
    session.fromPartition('records').fetch = refuse;
  });
}

async function seriousProblems(window: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page: window })
    .setLegacyMode(true)
    .withTags(TAGS)
    .include('[data-testid="help-dialog"]')
    .analyze();
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.help}`);
}

test('opens from the start screen, shows every topic and closes with Escape', async ({
  app,
  window,
}) => {
  await stayOffline(app);
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await window.getByTestId('help-open').click();
  const dialog = window.getByTestId('help-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Help topics' })).toBeVisible();
  await expect(window.getByTestId('help-text').getByRole('heading', { level: 3 })).toHaveText(
    'Starting out',
  );

  for (const [id, title] of TOPICS) {
    await window.getByTestId(`help-topic-${id}`).click();
    await expect(window.getByTestId(`help-topic-${id}`)).toHaveAttribute('aria-current', 'true');
    const heading = window.getByTestId('help-text').getByRole('heading', { level: 3 });
    await expect(heading).toHaveText(title);
    // The text is read from its heading: the focus moved there.
    await expect(heading).toBeFocused();
  }

  await window.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(window.getByTestId('help-open')).toBeFocused();
});

test('is reached from the tree screen and says nothing the app does not do', async ({
  app,
  window,
}) => {
  await stayOffline(app);
  await createTree(window, 'Help tree');
  await window.getByTestId('help-open').click();
  await expect(window.getByTestId('help-dialog')).toBeVisible();
  await window.getByTestId('help-topic-smartscreen').click();
  await expect(window.getByTestId('help-text')).toContainText('Windows protected your PC');
  await expect(window.getByTestId('help-text')).toContainText('Run anyway');
  await window.getByTestId('help-close').click();
  await expect(window.getByTestId('help-dialog')).toHaveCount(0);
  await expect(window.getByTestId('help-open')).toBeFocused();
});

test('has no serious accessibility problem in either theme, and fits at 200%', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  await stayOffline(app);
  await window.getByTestId('help-open').click();
  await expect(window.getByTestId('help-dialog')).toBeVisible();

  for (const theme of ['dark', 'light'] as const) {
    await app.evaluate(({ nativeTheme }, value) => {
      nativeTheme.themeSource = value;
    }, theme);
    for (const [id] of TOPICS) {
      await window.getByTestId(`help-topic-${id}`).click();
      expect.soft(await seriousProblems(window), `${theme}, ${id}`).toEqual([]);
    }
  }

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setContentSize(1280, 800);
    win?.webContents.setZoomFactor(2);
  });
  await expect
    .poll(() => window.evaluate(() => Math.round(globalThis.innerWidth)))
    .toBeLessThanOrEqual(700);
  await window.getByTestId('help-topic-uninstall').click();
  const fits = await window.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-testid="help-dialog"] .dialog-body');
    const text = document.querySelector<HTMLElement>('[data-testid="help-text"]');
    return {
      sideways: body === null || body.scrollWidth <= body.clientWidth,
      text: text === null || text.scrollWidth <= text.clientWidth,
    };
  });
  expect(fits).toEqual({ sideways: true, text: true });
  await expect(window.getByTestId('help-close')).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
});
