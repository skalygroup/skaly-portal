import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

/**
 * E2E smoke: Staff Attendance (Sprint 3 STEP 8). Smoke depth only — the
 * exhaustive grid suite is Sprint 13.
 *
 * NOTE: the guide names this apps/web/e2e/attendance.spec.ts, but the Playwright
 * config's testDir is ./tests (Sprint 1 convention), so it lives here.
 *
 * Needs a live web app + API + Supabase test project and seeded staff mirrored
 * as Supabase users. Configure via env:
 *
 *   E2E_BASE_URL          web origin (default http://localhost:3000)
 *   DATABASE_URL          API Postgres — reads the current period, toggles a lock
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD    an admin with MFA enrolled
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD  a team_member (the seeded one)
 *
 * Without these the whole describe self-skips so the suite stays green until the
 * infra is wired (same pattern as tests/auth/login.spec.ts).
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(
  ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL,
);

/** Current IST month 'YYYY-MM' — matches the backend / useMonthContext. */
function currentIstPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
}

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /Sign in/i }).click();
}

test.describe('attendance grid (live smoke)', () => {
  test.beforeEach(() => {
    test.skip(
      !FLOW_ENABLED,
      'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the attendance smoke.',
    );
  });

  test('admin can edit any cell', async ({ page }) => {
    const period = currentIstPeriod();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/attendance?period=${period}`);

    await expect(page.getByRole('grid')).toBeVisible();

    // Toggle the first working cell's present button and assert it flips.
    const toggle = page.getByRole('button', { name: /Toggle/ }).first();
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute('aria-pressed');
    await toggle.click();
    await expect(toggle).not.toHaveAttribute('aria-pressed', before ?? '');
  });

  test('team member: own column editable, others are not', async ({ page }) => {
    const period = currentIstPeriod();
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    await page.goto(`/attendance?period=${period}`);

    await expect(page.getByRole('grid')).toBeVisible();

    // At least one editable (own) cell, and non-editable cells are click-blocked.
    await expect(page.locator('[data-editable="true"]').first()).toBeVisible();
    const blocked = page.locator('[data-editable="false"]').first();
    await expect(blocked).toBeVisible();
    await expect(blocked).toHaveCSS('pointer-events', 'none');
  });

  test('locked period renders read-only', async ({ page }) => {
    // Lock a period with data (the prior IST month exists from the seed).
    const period = await withDb(async (c) => {
      const { rows } = await c.query(
        "SELECT period FROM months WHERE locked = false ORDER BY period DESC OFFSET 1 LIMIT 1",
      );
      return rows[0]?.period as string | undefined;
    });
    test.skip(!period, 'No prior month to lock.');

    await withDb((c) => c.query('UPDATE months SET locked = true WHERE period = $1', [period!]));
    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`/attendance?period=${period}`);

      await expect(page.getByText('This period is locked. Read-only.')).toBeVisible();
      // No interactive toggles in a locked grid (cells are <span>s).
      await expect(page.getByRole('button', { name: /Toggle/ })).toHaveCount(0);
    } finally {
      await withDb((c) => c.query('UPDATE months SET locked = false WHERE period = $1', [period!]));
    }
  });
});
