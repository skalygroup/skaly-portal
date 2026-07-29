import { test, expect } from '@playwright/test';

import { login } from './helpers/auth';
import { withDb } from './helpers/db';
import { currentIstPeriod, priorIstPeriod } from './helpers/period-dates';

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

// login() comes from tests/helpers/auth — see the barrier note there. The local
// copy here omitted it and every grid fetch went out unauthenticated.

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
    /**
     * Last month — DERIVED, not queried.
     *
     * This used to take `ORDER BY period DESC OFFSET 1`, which reads as "the
     * previous month" and is not: other suites leave rows in `months` dated
     * 2098, so this locked a period with no attendance behind it. Both
     * assertions below then passed against an EMPTY grid — a grid with no cells
     * has no toggles whether it is locked or not — so the test could not fail.
     */
    const period = priorIstPeriod();
    const exists = await withDb(async (c) => {
      const { rows } = await c.query('SELECT 1 FROM months WHERE period = $1', [period]);
      return rows.length > 0;
    });
    test.skip(!exists, `No months row for ${period}.`);

    await withDb((c) => c.query('UPDATE months SET locked = true WHERE period = $1', [period]));
    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`/attendance?period=${period}`);

      await expect(page.getByText('This period is locked. Read-only.')).toBeVisible();
      // The grid has to have DATE ROWS for "no toggles" to mean anything.
      // Counted by rows, not by `[data-editable]`: that attribute lives on the
      // interactive cell, which a locked period does not render at all — so
      // using it here would fail on a perfectly populated locked month.
      await expect(page.getByRole('grid')).toBeVisible();
      expect(await page.getByRole('row').count()).toBeGreaterThan(1);
      // No interactive toggles in a locked grid (cells are <span>s).
      await expect(page.getByRole('button', { name: /Toggle/ })).toHaveCount(0);
    } finally {
      await withDb((c) => c.query('UPDATE months SET locked = false WHERE period = $1', [period]));
    }
  });
});
