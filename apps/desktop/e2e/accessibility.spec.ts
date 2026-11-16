import AxeBuilder from '@axe-core/playwright';
import type { ElectronApplication, Page } from '@playwright/test';
import { addPerson, addRelative, createTree, expect, test } from './fixtures';

/**
 * Accessibility, part 6.3 of the plan: axe on each main screen in both themes, in
 * Windows high contrast and with reduced motion; a walk through the app with the
 * keyboard alone; and the page at 200%. The people are made up.
 *
 * A screen fails the test when axe finds a serious or a critical problem on it. The
 * message names the rule, what it says and where on the page it was found.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Scheme = 'dark' | 'light';
const SCHEMES: readonly Scheme[] = ['dark', 'light'];

/** Sets the theme the way the system does: the page follows prefers-color-scheme. */
async function setScheme(app: ElectronApplication, scheme: Scheme): Promise<void> {
  await app.evaluate(({ nativeTheme }, theme) => {
    nativeTheme.themeSource = theme;
  }, scheme);
}

/** What axe found on a screen, as lines of text; empty when there is nothing serious. */
// Legacy mode: the default opens a second page to merge results, which an Electron window cannot do.
async function problemsOn(window: Page, include?: string): Promise<string[]> {
  let axe = new AxeBuilder({ page: window }).setLegacyMode(true).withTags(TAGS);
  if (include !== undefined) axe = axe.include(include);
  const { violations } = await axe.analyze();
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}. Found at ${violation.nodes
          .slice(0, 4)
          .map((node) => node.target.join(' '))
          .join(' | ')}`,
    );
}

/**
 * Checks one screen and notes what is wrong with it without stopping, so that one run
 * lists every screen that has a problem. `include` limits the check to a dialog.
 */
async function audit(window: Page, screen: string, include?: string): Promise<void> {
  const problems = await problemsOn(window, include);
  expect.soft(problems, `${screen}: ${problems.join('\n')}`).toEqual([]);
}

/** Opens a dialog with a button, checks it, closes it with Escape and checks the focus came back. */
async function auditDialog(
  window: Page,
  screen: string,
  open: string,
  dialog: string,
): Promise<void> {
  const opener = window.getByTestId(open).first();
  await opener.click();
  const shown = window.getByTestId(dialog);
  await expect(shown).toBeVisible();
  // Give what the dialog reads on opening a moment to arrive.
  await window.waitForTimeout(400);
  await audit(window, screen, `[data-testid="${dialog}"]`);
  await window.keyboard.press('Escape');
  await expect(shown).toHaveCount(0);
  // The dialog gives the focus back to the button that opened it.
  await expect(opener, `${screen}: the focus did not return to the button`).toBeFocused();
}

/**
 * Nothing in these tests reaches the internet: every request the app makes answers
 * with a refusal, except the listing of the census, which names one made-up state.
 */
async function stayOffline(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ net, session }) => {
    const refuse = () => Promise.resolve(new Response('offline', { status: 503 }));
    net.fetch = refuse;
    session.fromPartition('records').fetch = refuse;
  });
}

/** Brin Hale with his parents Tobin and Odile, his partner Selby and their daughter Rose. */
async function buildFamily(window: Page): Promise<void> {
  await addPerson(window, {
    given: 'Brin',
    surname: 'Hale',
    sex: 'Male',
    birthDate: '1880',
    birthPlace: 'Testford',
    deathDate: '1950',
  });
  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Tobin', surname: 'Hale', sex: 'Male', birthDate: '1850' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, { given: 'Odile', surname: 'Reed', sex: 'Female' });
  await window.getByTestId('add-partner').click();
  await addRelative(window, { given: 'Selby', surname: 'Cole', sex: 'Female' });
  await window.getByTestId('add-child-to-family').click();
  await addRelative(window, { given: 'Rose', surname: 'Hale', sex: 'Female', birthDate: '1905' });
  await expect(window.getByTestId('person-count')).toHaveText('5 people');
  await expect(window.getByTestId('person-name')).toHaveText('Brin Hale');
}

/** Checks every screen in one theme: the start screen, the workspace, each dialog and each chart. */
async function auditEverything(window: Page, app: ElectronApplication, scheme: Scheme) {
  const at = (screen: string) => `${screen} (${scheme} theme)`;
  await setScheme(app, scheme);

  // The start screen.
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await audit(window, at('start screen'));

  await createTree(window, `Access ${scheme}`);
  await buildFamily(window);

  // The workspace: the list, and a person page.
  await audit(window, at('workspace with a person page'));

  // Dialogs of the person page.
  await auditDialog(window, at('add a person'), 'add-person', 'add-person-dialog');
  await auditDialog(window, at('edit an event'), 'edit-event', 'event-dialog');
  await auditDialog(window, at('family group sheet'), 'open-report', 'report-dialog');
  await auditDialog(window, at('Ahnentafel'), 'open-ahnentafel', 'report-dialog');
  await auditDialog(window, at('relationship'), 'open-relationship', 'relationship-dialog');
  await auditDialog(window, at('merge'), 'open-merge', 'merge-pick-dialog');
  await auditDialog(window, at('fact sources'), 'event-sources', 'fact-sources-dialog');
  await auditDialog(window, at('search records'), 'open-records', 'record-search');
  await auditDialog(window, at('AI assistant'), 'open-ai-assistant', 'ai-assistant');

  // Dialogs of the toolbar.
  await auditDialog(window, at('sources'), 'open-sources', 'sources-dialog');
  await auditDialog(window, at('media'), 'open-media', 'media-library');
  await auditDialog(window, at('places'), 'open-places', 'places-dialog');
  await auditDialog(window, at('packs and census'), 'open-packs', 'packs-dialog');
  await auditDialog(window, at('inbox'), 'open-inbox', 'record-inbox');
  await auditDialog(window, at('backups'), 'open-backups', 'backups-dialog');
  await auditDialog(window, at('duplicates'), 'open-duplicates', 'duplicates-dialog');
  await auditDialog(window, at('export'), 'open-export', 'export-dialog');

  // The charts, each with its text outline open.
  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
  for (const kind of ['pedigree', 'descendants', 'hourglass', 'fan']) {
    await window.getByTestId(`chart-kind-${kind}`).click();
    await expect(window.getByTestId('chart-canvas')).toHaveAttribute('data-kind', kind);
    const outline = window.getByTestId('chart-outline-toggle');
    if ((await outline.getAttribute('open')) === null) await outline.locator('summary').click();
    await expect(window.getByTestId('chart-outline')).toBeVisible();
    await audit(window, at(`${kind} chart`));
  }
  await auditDialog(window, at('save or print a chart'), 'chart-export', 'report-dialog');
}

for (const scheme of SCHEMES) {
  test(`has no serious or critical problem on the screens, ${scheme} theme`, async ({
    app,
    window,
  }) => {
    test.setTimeout(300_000);
    await stayOffline(app);
    await auditEverything(window, app, scheme);
  });
}

test('keeps every border and every selected state in Windows high contrast', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  await stayOffline(app);
  await createTree(window, 'Contrast');
  await buildFamily(window);
  await window.emulateMedia({ forcedColors: 'active' });
  expect(await window.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

  await audit(window, 'workspace in high contrast');

  // Buttons, fields and the selected row keep a border or a system colour.
  const edges = await window.evaluate(() => {
    const width = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).borderTopWidth : 'missing';
    };
    const paint = (selector: string) => {
      const row = document.querySelector(selector);
      if (!row) return 'missing';
      const style = getComputedStyle(row);
      return `${style.color} on ${style.backgroundColor}`;
    };
    return {
      button: width('[data-testid="add-person"]'),
      search: width('[data-testid="search-box"]'),
      table: width('table.table'),
      selected: paint('.person-list .row.selected'),
      plain: paint('.person-list .row:not(.selected)'),
    };
  });
  expect(edges.button).not.toBe('0px');
  expect(edges.search).not.toBe('0px');
  expect(edges.table).not.toBe('0px');
  // The selected row is not drawn with the colours of a plain row.
  expect(edges.selected).not.toBe('missing');
  expect(edges.plain).not.toBe('missing');
  expect(edges.selected).not.toBe(edges.plain);

  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-box').first()).toBeVisible();
  const box = await window.evaluate(() => {
    const element = document.querySelector('[data-testid="chart-box"]');
    return element ? getComputedStyle(element).borderTopWidth : 'missing';
  });
  expect(box).not.toBe('0px');
  // Sex is told by colour only; in high contrast the edge of the box differs by style instead.
  const edgeStyles = await window.evaluate(() =>
    [...document.querySelectorAll('[data-testid="chart-box"]')].map((element) => ({
      sex: [...element.classList].find((name) => name.startsWith('sex-')),
      style: getComputedStyle(element).borderLeftStyle,
    })),
  );
  const styleOf = (sex: string) => edgeStyles.find((entry) => entry.sex === sex)?.style;
  expect(styleOf('sex-M')).toBe('solid');
  expect(styleOf('sex-F')).toBe('double');
  await audit(window, 'chart in high contrast');
  await window.getByTestId('chart-kind-fan').click();
  await expect(window.getByTestId('chart-canvas')).toHaveAttribute('data-kind', 'fan');
  await audit(window, 'fan chart in high contrast');
});

test('turns off animation and smooth scrolling with reduced motion', async ({ app, window }) => {
  test.setTimeout(120_000);
  await stayOffline(app);
  await createTree(window, 'Calm');
  await buildFamily(window);
  // The app has no animation of its own. The rule for reduced motion is a safeguard that
  // shortens any animation and transition to nothing, so what is checked is that it is in force:
  // the computed duration changes when the setting does.
  const durations = () =>
    window.evaluate(() => {
      const button = document.querySelector('[data-testid="add-person"]');
      if (!button) throw new Error('no button');
      const style = getComputedStyle(button);
      return {
        animation: style.animationDuration,
        transition: style.transitionDuration,
        scroll: getComputedStyle(document.documentElement).scrollBehavior,
      };
    });
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  const before = await durations();
  expect(before.animation).toBe('0s');
  await window.emulateMedia({ reducedMotion: 'reduce' });
  const after = await durations();
  expect(after.animation).not.toBe('0s');
  expect(Number.parseFloat(after.animation)).toBeLessThan(0.001);
  expect(Number.parseFloat(after.transition)).toBeLessThan(0.001);
  expect(after.scroll).toBe('auto');
  expect(await window.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  await audit(window, 'workspace with reduced motion');
  const smooth = await window.evaluate(() =>
    [...document.querySelectorAll('*')].some(
      (element) => getComputedStyle(element).scrollBehavior === 'smooth',
    ),
  );
  expect(smooth).toBe(false);
  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
});

/**
 * Presses Tab until the control with the test id has the focus, and fails if the
 * focus ever rests on the page itself or the control is not reached in `limit` presses.
 */
async function tabTo(
  window: Page,
  testId: string,
  { back = false, limit = 80 }: { back?: boolean; limit?: number } = {},
): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    await window.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const state = await window.evaluate((id) => {
      const active = document.activeElement;
      return {
        tag: active?.tagName ?? 'NONE',
        found: active?.getAttribute('data-testid') === id,
      };
    }, testId);
    expect(state.tag, `the focus is lost after ${presses + 1} presses of Tab`).not.toMatch(
      /^(BODY|HTML|NONE)$/,
    );
    if (state.found) return;
  }
  throw new Error(`Tab did not reach ${testId} in ${limit} presses`);
}

test('can be used from the keyboard alone', async ({ window }) => {
  test.setTimeout(180_000);
  const kb = window.keyboard;

  // The start screen: Tab to the name of the tree, type it and press Enter.
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await tabTo(window, 'new-tree-name');
  await kb.type('Keyboard tree');
  await kb.press('Enter');
  await expect(window.getByTestId('workspace')).toBeVisible();
  // The start screen is gone with its focus: the new screen has it, on its title.
  await expect(window.getByTestId('tree-name')).toBeFocused();

  // Add a person with a birth date: given name, surname, sex, birth date.
  await tabTo(window, 'add-person');
  await kb.press('Enter');
  await expect(window.getByTestId('add-person-dialog')).toBeVisible();
  await expect(window.getByTestId('person-given')).toBeFocused();
  await kb.type('Walter');
  await kb.press('Tab');
  await kb.type('Wren');
  await kb.press('Tab');
  await kb.press('Tab');
  await kb.type('1880');
  await kb.press('Enter');
  await expect(window.getByTestId('add-person-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-name')).toHaveText('Walter Wren');
  // The dialog gave the focus back to the button that opened it.
  await expect(window.getByTestId('add-person')).toBeFocused();

  // Add a parent from the person page.
  await tabTo(window, 'add-parent');
  await kb.press('Enter');
  await expect(window.getByTestId('relative-dialog')).toBeVisible();
  await expect(window.getByTestId('person-given')).toBeFocused();
  await kb.type('Edmund');
  await kb.press('Tab');
  await kb.type('Wren');
  await kb.press('Enter');
  await expect(window.getByTestId('relative-dialog')).toHaveCount(0);
  await expect(window.getByTestId('parent-family')).toHaveCount(1);
  // The button that added the parent is gone: the focus is on the person's heading.
  await expect(window.getByTestId('person-name')).toBeFocused();

  // Edit the birth event from the page.
  await tabTo(window, 'edit-event');
  await kb.press('Enter');
  await expect(window.getByTestId('event-dialog')).toBeVisible();
  await tabTo(window, 'event-date');
  await kb.press('Control+A');
  await kb.type('12 Mar 1880');
  await kb.press('Enter');
  await expect(window.getByTestId('event-dialog')).toHaveCount(0);
  await expect(window.getByTestId('event-row').first()).toContainText('12 Mar 1880');
  await expect(window.getByTestId('edit-event').first()).toBeFocused();

  // Open the chart.
  await tabTo(window, 'open-chart');
  await kb.press('Enter');
  await expect(window.getByTestId('chart-view')).toBeVisible();
  await expect(window.getByTestId('chart-root-name')).toBeFocused();

  // Open the text outline and move to the parent through it.
  await tabTo(window, 'chart-outline-summary');
  await kb.press('Enter');
  await expect(window.getByTestId('chart-outline')).toBeVisible();
  await tabTo(window, 'outline-person');
  await tabTo(window, 'outline-person');
  await expect(window.getByTestId('outline-person').nth(1)).toBeFocused();
  await kb.press('Enter');
  await expect(window.getByTestId('chart-root-name')).toHaveText('Edmund Wren');
  // The chart was drawn again for the parent: the focus is on him in the outline.
  await expect(window.locator('[data-outline-root]')).toBeFocused();

  // Back to the person page, and the family group sheet: open it and close it with Escape.
  await tabTo(window, 'chart-details', { back: true });
  await kb.press('Enter');
  await expect(window.getByTestId('person-page')).toBeVisible();
  // The chart is gone with its button: the focus is on the heading of the person's page.
  await expect(window.getByTestId('person-name')).toBeFocused();
  await expect(window.getByTestId('person-name')).toHaveText('Edmund Wren');
  await tabTo(window, 'open-report');
  await kb.press('Enter');
  await expect(window.getByTestId('report-dialog')).toBeVisible();
  await kb.press('Escape');
  await expect(window.getByTestId('report-dialog')).toHaveCount(0);
  await expect(window.getByTestId('open-report')).toBeFocused();
});

test('has no clipped text and no sideways scrolling at 200%', async ({ app, window }) => {
  test.setTimeout(120_000);
  await stayOffline(app);
  await createTree(window, 'Large text');
  await buildFamily(window);

  // A window of 1280 by 800 at 200% is a page 640 by 400.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setContentSize(1280, 800);
    win?.webContents.setZoomFactor(2);
  });
  await expect
    .poll(() => window.evaluate(() => Math.round(globalThis.innerWidth)))
    .toBeLessThanOrEqual(700);

  const noSideways = () =>
    window.evaluate(() => ({
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      main: (() => {
        const main = document.querySelector('main');
        return main === null || main.scrollWidth <= main.clientWidth;
      })(),
    }));
  expect(await noSideways()).toEqual({ page: true, main: true });

  // The person's name and the main buttons are on screen and whole.
  const name = window.getByTestId('person-name');
  await name.scrollIntoViewIfNeeded();
  await expect(name).toBeVisible();
  const whole = await name.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(whole).toBe(true);
  for (const id of ['add-person', 'open-chart', 'open-report', 'delete-person']) {
    const button = window.getByTestId(id);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const inside = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= globalThis.innerWidth + 1;
    });
    expect(inside, `${id} is cut off at the side`).toBe(true);
  }

  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
  expect(await noSideways()).toEqual({ page: true, main: true });
  await expect(window.getByTestId('chart-kind-pedigree')).toBeVisible();
  await expect(window.getByTestId('chart-export')).toBeVisible();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
});
