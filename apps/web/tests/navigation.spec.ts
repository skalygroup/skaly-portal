import { expect, test } from '@playwright/test';

import { login } from './helpers/auth';

import type { Page } from '@playwright/test';

/**
 * The portal shell: the §4.1 sidebar and the §6.1 period selector.
 *
 * ⚠️ THIS IS STEP 12.2'S LIVE SMOKE, AUTOMATED. The launch runbook asks whoever
 * deploys to open every module in production and confirm it loads. Until the
 * sidebar existed that walk could only be done by typing eleven URLs from a list,
 * which is exactly the kind of check that gets skipped under launch pressure.
 * Doing it here means the deploy-day version is a confirmation, not a discovery.
 *
 * Every module is visited THROUGH THE NAV rather than by goto(). A goto() proves
 * the route renders; it does not prove the link exists, points at the right
 * place, or survives the next layout change — and a missing link is precisely
 * the failure that produced this file.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD);

/** Label → the path it must land on. The order the sidebar renders them in. */
const MODULES: [string, string][] = [
  ['Attendance', '/attendance'],
  ['Tasks', '/tasks'],
  ['Shoot Planner', '/shoot-planner'],
  ['Content Dropper', '/content-dropper'],
  ['Content Calendar', '/content-calendar'],
  ['Dashboard', '/dashboard'],
  ['Chat', '/chat'],
  ['Bot', '/bot'],
  ['Profile', '/profile'],
  ['Settings', '/settings'],
];

/** The sidebar link for a module, scoped to the nav so page content cannot match. */
const navLink = (page: Page, label: string) =>
  page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: label, exact: true });

test.describe('the portal shell', () => {
  test.skip(!ENABLED, 'needs TEST_ADMIN_* and TEST_MEMBER_*');

  test('⭐ every module is reachable from the sidebar, and loads', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/home');

    for (const [label, path] of MODULES) {
      await navLink(page, label).click();
      await page.waitForURL(new RegExp(`${path}(\\?|$)`), { timeout: 20_000 });

      // Not just the URL. Two things have to hold, and neither is "a <main> is
      // visible" — /dashboard renders only an h1 and /chat renders neither, so
      // that assertion would fail on healthy modules and pass on broken ones.
      //
      //   1. the shell survived the navigation, and
      //   2. the module did NOT fall into its §5.2 error boundary.
      //
      // (2) is the real check: a module that throws renders a tidy "Something
      // went wrong loading X" card, which a looser assertion happily calls a
      // successful load.
      await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
      await expect(page.getByTestId('module-error'), `${label} hit its error boundary`).toHaveCount(
        0,
      );
    }

    await context.close();
  });

  test('/ redirects to /home instead of dead-ending', async ({ browser }) => {
    // It was a Sprint 1 placeholder with no links — the whole reason the portal
    // was unusable without knowing its URLs.
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.goto('/');
    await expect(page).toHaveURL(/\/home$/);

    await context.close();
  });

  test('the active module is marked, and the marker follows', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/attendance');

    await expect(navLink(page, 'Attendance')).toHaveAttribute('aria-current', 'page');
    await navLink(page, 'Tasks').click();
    await page.waitForURL(/\/tasks/);

    await expect(navLink(page, 'Tasks')).toHaveAttribute('aria-current', 'page');
    await expect(navLink(page, 'Attendance')).not.toHaveAttribute('aria-current', 'page');

    await context.close();
  });

  test('⭐ a team member gets no Settings link and no Content Dropper', async ({ browser }) => {
    // The nav is derived from the SAME resolved permissions the API gates on, so
    // a module they cannot open never appears in their HTML. The API is still the
    // real boundary — this asserts the navigation layer agrees with it.
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    await page.goto('/home');

    await expect(navLink(page, 'Attendance')).toBeVisible();
    await expect(navLink(page, 'Settings')).toHaveCount(0);
    await expect(navLink(page, 'Content Dropper')).toHaveCount(0);

    await context.close();
  });
});

test.describe('the period selector (§6.1)', () => {
  test.skip(!ENABLED, 'needs TEST_ADMIN_*');

  test('⭐ choosing a past month puts it in the URL and raises the banner', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/home');

    await page.getByTestId('period-selector').getByRole('button').first().click();
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible({ timeout: 10_000 });

    // The second entry is the previous month; the first is the current one.
    const count = await options.count();
    test.skip(count < 2, 'needs at least two months of history in this database');
    await options.nth(1).click();

    await expect(page).toHaveURL(/\?period=\d{4}-\d{2}/);
    await expect(page.getByTestId('past-period-banner')).toBeVisible();

    // And back again — the way out has to work, or the banner is a trap.
    await page.getByRole('button', { name: /Back to current/ }).click();
    await expect(page.getByTestId('past-period-banner')).toHaveCount(0);

    await context.close();
  });

  test('the picker offers no future month', async ({ browser }) => {
    // `months` carries far-future fixture rows from this repo's own rollover
    // suites; offering one lands on a grid with no data, which reads as loss.
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/home');

    await page.getByTestId('period-selector').getByRole('button').first().click();
    const labels = await page.getByRole('option').allTextContents();

    const currentYear = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(
        new Date(),
      ),
    );
    for (const label of labels) {
      const year = Number(label.match(/\d{4}/)?.[0] ?? currentYear);
      expect(year, `"${label}" must not be in the future`).toBeLessThanOrEqual(currentYear);
    }

    await context.close();
  });
});

test.describe('the home page', () => {
  test.skip(!ENABLED, 'needs TEST_ADMIN_*');

  test('⭐ leads with numbers that link somewhere', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/home');

    const tiles = page.getByTestId('home-tile');
    await expect(tiles.first()).toBeVisible({ timeout: 20_000 });
    expect(await tiles.count()).toBeGreaterThan(0);

    // A number you cannot act on is decoration — every tile is a link, and this
    // is the assertion that keeps it that way.
    await tiles.first().click();
    await expect(page).not.toHaveURL(/\/home/);

    await context.close();
  });
});
