import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { addPerson, addRelative, createTree, expect, test } from './fixtures';

/**
 * The screenshots of the README (part 6.5), taken from a tree of made-up people. It is skipped
 * unless RULZ_SCREENSHOTS=1, so that an ordinary run does not rewrite files of the repository:
 *
 *   RULZ_SCREENSHOTS=1 node ../../node_modules/@playwright/test/cli.js test --project=built e2e/screenshots.spec.ts
 *
 * The names and places are invented and belong to no real tree. Run it from apps/desktop after
 * `pnpm build`. The pictures are written to docs/screenshots.
 */

test.skip(
  process.env['RULZ_SCREENSHOTS'] !== '1',
  'writes docs/screenshots; set RULZ_SCREENSHOTS=1',
);

const OUT = resolve(import.meta.dirname, '../../../docs/screenshots');

async function stayOffline(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ net, session }) => {
    const refuse = () => Promise.resolve(new Response('offline', { status: 503 }));
    net.fetch = refuse;
    session.fromPartition('records').fetch = refuse;
  });
}

/** Aldric Quillon with his parents, his partner and their two children. */
async function buildFamily(window: Page): Promise<void> {
  await addPerson(window, {
    given: 'Aldric',
    surname: 'Quillon',
    sex: 'Male',
    birthDate: '3 Apr 1871',
    birthPlace: 'Testford',
    deathDate: '1946',
    deathPlace: 'Sample Valley',
  });
  await window.getByTestId('add-parent').click();
  await addRelative(window, {
    given: 'Bram',
    surname: 'Quillon',
    sex: 'Male',
    birthDate: '1842',
    deathDate: '1910',
  });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, {
    given: 'Elsbeth',
    surname: 'Marrow',
    sex: 'Female',
    birthDate: '1846',
    deathDate: '1919',
  });
  await window.getByTestId('add-partner').click();
  await addRelative(window, {
    given: 'Nessa',
    surname: 'Thorne',
    sex: 'Female',
    birthDate: '1874',
    deathDate: '1950',
  });
  await window.getByTestId('add-child-to-family').click();
  await addRelative(window, {
    given: 'Wilmer',
    surname: 'Quillon',
    sex: 'Male',
    birthDate: '1899',
    birthPlace: 'Testford',
  });
  await window.getByTestId('add-child-to-family').click();
  await addRelative(window, {
    given: 'Tamsin',
    surname: 'Quillon',
    sex: 'Female',
    birthDate: '1903',
  });
  await expect(window.getByTestId('person-name')).toHaveText('Aldric Quillon');
}

async function setTheme(app: ElectronApplication, theme: 'dark' | 'light'): Promise<void> {
  await app.evaluate(({ nativeTheme }, value) => {
    nativeTheme.themeSource = value;
  }, theme);
}

test('takes the screenshots of the README from a made-up tree', async ({ app, window }) => {
  test.setTimeout(120_000);
  mkdirSync(OUT, { recursive: true });
  await stayOffline(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
  });
  await setTheme(app, 'dark');

  await createTree(window, 'Quillon family');
  await buildFamily(window);
  await window.getByTestId('close-tree').click();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await expect(window.getByTestId('recent-tree')).toHaveCount(1);
  // The folders of the test profile are no place for a picture of the README: show the usual one.
  await window.evaluate(() => {
    for (const element of document.querySelectorAll('.path')) {
      const text = element.textContent ?? '';
      element.textContent = text.endsWith('Quillon family')
        ? String.raw`C:\Users\Name\Documents\RulZ Kinspora\Quillon family`
        : String.raw`C:\Users\Name\Documents\RulZ Kinspora`;
    }
  });
  // Only the top of the screen: the system check below it names the build, not the release.
  await window.screenshot({
    path: resolve(OUT, 'start-screen.png'),
    clip: { x: 0, y: 0, width: 1280, height: 730 },
  });

  await window.getByTestId('open-recent').click();
  await expect(window.getByTestId('workspace')).toBeVisible();
  await window.getByTestId('person-row').filter({ hasText: 'Aldric' }).first().click();
  await expect(window.getByTestId('person-name')).toHaveText('Aldric Quillon');
  await window.screenshot({ path: resolve(OUT, 'person-page.png') });

  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
  await window.getByTestId('chart-kind-hourglass').click();
  await expect(window.getByTestId('chart-box')).toHaveCount(6);
  await window.screenshot({ path: resolve(OUT, 'chart.png') });

  await setTheme(app, 'light');
  await expect(window.getByTestId('theme-toggle')).toHaveAccessibleName('Use the dark theme');
  await window.screenshot({ path: resolve(OUT, 'chart-light.png') });
});
