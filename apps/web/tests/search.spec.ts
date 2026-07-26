import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { captureApiToken, login } from './helpers/auth';

/**
 * E2E: the CMD+K palette and its role isolation (Sprint 9 STEP 12).
 *
 * Unlike the bot specs there is no model here, so everything is deterministic —
 * the assertions are on what the palette renders, where it navigates, and what
 * the API returns for the same query under a different role.
 *
 * The isolation test is the one that matters: a freelancer must not be able to
 * reach task text through search that they cannot reach anywhere else (ADR-015).
 * It is asserted at BOTH layers — the rendered group and the raw endpoint — because
 * a UI that merely hides rows the API returned is not isolation.
 *
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD / TEST_ADMIN_TOTP_SECRET
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD
 *   TEST_FREELANCER_EMAIL / TEST_FREELANCER_PASSWORD
 *   DATABASE_URL, NEXT_PUBLIC_API_URL
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FREELANCER_EMAIL = process.env.TEST_FREELANCER_EMAIL ?? '';
const FREELANCER_PASSWORD = process.env.TEST_FREELANCER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const FLOW_ENABLED = Boolean(
  ADMIN_PASSWORD && MEMBER_PASSWORD && FREELANCER_PASSWORD && process.env.DATABASE_URL,
);

const MARK = 'E2E-SEARCH:';
/** A word that exists nowhere else in the database, so a hit is unambiguous. */
const TOKEN = 'zephyrine';

function istPeriod(offsetMonths = 0): string {
  const now = new Date();
  const ist = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(now);
  const [y, m] = ist.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + offsetMonths, 1));
  return d.toISOString().slice(0, 7);
}
const PERIOD = istPeriod(0);
const PRIOR = istPeriod(-1);

const CURRENT_TASK = `${MARK} ${TOKEN} current`;
const PRIOR_TASK = `${MARK} ${TOKEN} archived`;

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** True when the prior month had to be created for the fixture (so we drop it). */
let createdPriorMonth = false;
let clientName = '';
let memberName = '';
let memberId = '';

test.beforeAll(async () => {
  if (!FLOW_ENABLED) return;
  await withDb(async (c) => {
    const admin = await c.query('SELECT id FROM staff WHERE email = $1', [ADMIN_EMAIL]);
    const member = await c.query('SELECT id, name FROM staff WHERE email = $1', [MEMBER_EMAIL]);
    memberId = member.rows[0].id as string;
    memberName = member.rows[0].name as string;

    const months = await c.query('SELECT period FROM months WHERE period = $1', [PRIOR]);
    if (months.rowCount === 0) {
      await c.query('INSERT INTO months (period, label, locked) VALUES ($1,$1,false)', [PRIOR]);
      createdPriorMonth = true;
    }

    await c.query(
      `INSERT INTO tasks (period, date, description, status, created_by)
       VALUES ($1,$2,$3,'To Do',$4), ($5,$6,$7,'To Do',$4)`,
      [PERIOD, `${PERIOD}-05`, CURRENT_TASK, admin.rows[0].id, PRIOR, `${PRIOR}-05`, PRIOR_TASK],
    );

    const client = await c.query(
      `SELECT name FROM clients
       WHERE active = true AND is_internal = false AND deleted_at IS NULL
       ORDER BY name LIMIT 1`,
    );
    clientName = (client.rows[0]?.name as string) ?? '';
  });
});

test.afterAll(async () => {
  if (!FLOW_ENABLED) return;
  await withDb(async (c) => {
    await c.query('DELETE FROM tasks WHERE description LIKE $1', [`${MARK}%`]);
    if (createdPriorMonth) await c.query('DELETE FROM months WHERE period = $1', [PRIOR]);
  });
});

/**
 * Open the palette with the real chord.
 *
 * Retried, not pressed once: the listener is registered by a React effect, so a
 * chord that lands before hydration finishes goes nowhere and the press is simply
 * lost. Webkit hydrates late enough for that to happen most runs. Retrying is
 * what a user does too — this is not papering over a product bug, there is no
 * hotkey on any page before its JS is live.
 */
async function openPalette(page: Page) {
  const input = page.getByPlaceholder('Search tasks, clients, staff…');
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(input).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  return input;
}

/** Type a query and wait past the 200ms debounce for the request to settle. */
async function search(page: Page, q: string) {
  const input = await openPalette(page);
  const pending = page.waitForResponse(
    (r) => r.url().includes('/v1/search') && r.status() === 200,
    { timeout: 15_000 },
  );
  await input.pressSequentially(q);
  await pending;
}

/** The items of one result group, by its heading. */
function group(page: Page, heading: string) {
  return page.locator('[cmdk-group]').filter({ has: page.getByText(heading, { exact: true }) });
}

test.describe('CMD+K palette', () => {
  test.beforeEach(async () => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_*, TEST_FREELANCER_* and DATABASE_URL.');
  });

  test('opens from any page and navigates to a client result', async ({ page }) => {
    test.skip(!clientName, 'No active client in this database to search for.');

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // Any portal page — the palette is mounted in the layout, not the page.
    await page.goto('/attendance');
    await search(page, clientName);

    const clients = group(page, 'Clients');
    await expect(clients.getByText(clientName, { exact: true }).first()).toBeVisible();

    // Clicked rather than Entered: which group holds cmdk's selection first is
    // cmdk's business, and this test is about where a CLIENT result goes.
    await clients.getByText(clientName, { exact: true }).first().click();
    await page.waitForURL(/\/content-dropper/);
  });

  test('the scope pill is the difference between this month and all time', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/attendance');
    await search(page, TOKEN);

    // Default scope is this month, so only the current-period task is there.
    await expect(page.getByText(CURRENT_TASK)).toBeVisible();
    await expect(page.getByText(PRIOR_TASK)).toHaveCount(0);

    const pending = page.waitForResponse(
      (r) => r.url().includes('scope=all_time') && r.status() === 200,
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: 'All time' }).click();
    await pending;

    await expect(page.getByText(PRIOR_TASK)).toBeVisible();
    // All-time results carry the period label so the row is placeable in time.
    await expect(page.getByText(PRIOR, { exact: false }).first()).toBeVisible();
  });

  test('a task result lands on its month with the row flashed gold', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/attendance');
    await search(page, TOKEN);

    await page.getByText(CURRENT_TASK).click();

    await page.waitForURL(/\/tasks\?/);
    await expect(page.getByText(CURRENT_TASK)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr.sk-row-flash')).toHaveCount(1);
    // Stripped on arrival, so a refresh doesn't replay the flash. Awaited rather
    // than sampled: the strip is a router.replace inside an effect.
    await page.waitForURL((u) => !u.searchParams.has('highlight'), { timeout: 10_000 });
  });

  test('staff: admin goes to the settings page, a team_member gets the profile in place', async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/attendance');
    await search(page, memberName);
    await group(page, 'Staff').getByText(memberName, { exact: true }).first().click();
    // The staff settings page itself is Sprint 11 — APPFLOW §12 pins the
    // destination, so the URL is what this asserts.
    await page.waitForURL(new RegExp(`/settings/staff/${memberId}`));

    const memberPage = await page.context().browser()!.newPage();
    try {
      await login(memberPage, MEMBER_EMAIL, MEMBER_PASSWORD);
      await memberPage.goto('/attendance');
      const before = memberPage.url();
      await search(memberPage, memberName);
      await group(memberPage, 'Staff').getByText(memberName, { exact: true }).first().click();

      // Opens in place: no navigation, and the profile is on screen.
      const dialog = memberPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(memberName)).toBeVisible();
      expect(memberPage.url()).toBe(before);
    } finally {
      await memberPage.close();
    }
  });

  test('freelancer: task text is unreachable through search, at both layers', async ({ page }) => {
    await login(page, FREELANCER_EMAIL, FREELANCER_PASSWORD);
    // A freelancer has no /attendance; the shoot planner is their page.
    await page.goto('/shoot-planner');
    const token = await captureApiToken(page, () => page.reload());

    await search(page, TOKEN);
    await expect(page.getByText(CURRENT_TASK)).toHaveCount(0);
    await expect(group(page, 'Tasks')).toHaveCount(0);

    // …and the endpoint itself, so this is isolation rather than a hidden row.
    const res = await page.request.get(
      `${API_BASE}/v1/search?q=${TOKEN}&scope=all_time`,
      { headers: { authorization: token } },
    );
    expect(res.status()).toBe(200);
    expect((await res.json()).data.tasks).toEqual([]);
  });
});
