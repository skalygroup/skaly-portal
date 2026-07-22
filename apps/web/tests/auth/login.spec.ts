import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

/**
 * E2E: the login flow (Sprint 1 STEP 11).
 *
 * Requires a running web app + API and a Supabase test project whose users are
 * mirrored as staff rows in the API database. Configure via env:
 *
 *   E2E_BASE_URL          web app origin (default http://localhost:3000)
 *   DATABASE_URL          API Postgres (used to deactivate a user in a fixture)
 *   TEST_MEMBER_EMAIL     a team_member with portal access → lands on /
 *   TEST_MEMBER_PASSWORD
 *   TEST_ADMIN_EMAIL      an admin WITHOUT MFA enrolled → lands on /mfa-setup
 *   TEST_ADMIN_PASSWORD
 *
 * The deactivation case flips staff.active directly (the admin deactivate route
 * is Sprint 11), then restores it afterwards.
 */

const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? 'member@test.skaly.in';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? 'admin@test.skaly.in';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';

// These cases need a live Supabase test project + API + seeded users. Until the
// TEST_* credentials and DATABASE_URL are provided, the whole describe self-skips
// (so the suite stays green) rather than failing on missing infra.
const FLOW_ENABLED = Boolean(MEMBER_PASSWORD && ADMIN_PASSWORD && process.env.DATABASE_URL);

/**
 * Flip a boolean staff flag AND drop the API's cached staff lookup.
 *
 * The auth plugin caches the staff row in Redis under `staff_lookup:{uid}` for 5
 * minutes, so a raw UPDATE is invisible in BOTH directions: the deactivated user
 * still logs in, and — worse — the restore at the end of this test stays unseen,
 * so every later spec that signs in as this member gets "Account deactivated"
 * for up to five minutes. That is what makes a failure here cascade into
 * attendance, tasks, content-dropper and content-calendar.
 *
 * The product invalidates this key itself on the paths that own it (approval,
 * deactivation); this fixture writes SQL directly, so it must do the same.
 */
async function setStaffFlag(email: string, column: 'active' | 'mfa_enrolled', value: boolean) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let uid: string | null = null;
  try {
    // `column` is a literal from this file's own union type, never user input.
    const res = await client.query<{ supabase_uid: string | null }>(
      `UPDATE staff SET ${column} = $1 WHERE email = $2 RETURNING supabase_uid`,
      [value, email],
    );
    uid = res.rows[0]?.supabase_uid ?? null;
  } finally {
    await client.end();
  }
  if (!uid) return;
  // Via the compose stack's redis-cli rather than a redis client: apps/web has no
  // redis dependency, and docker compose is already a hard prerequisite of these
  // live specs. Non-fatal — a missed delete degrades to the old 5-minute staleness.
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'DEL', `staff_lookup:${uid}`], {
      cwd: join(__dirname, '..', '..', '..', '..'),
      stdio: 'ignore',
    });
  } catch {
    /* redis unreachable — the TTL will clear it eventually */
  }
}

/**
 * Local, deliberately: this spec asserts the login flow itself, so it must NOT
 * use the shared helper's post-login barrier — several of its cases expect to
 * STAY on /login (invalid password, deactivated account).
 *
 * `#password`, not getByLabel('Password'): the redesigned form also carries a
 * "Forgot password?" control, so the accessible name matches two elements and
 * Playwright's strict mode throws before the field is ever filled.
 */
async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /Sign in/i }).click();
}

test.describe('login (live auth flow)', () => {
  test.beforeEach(() => {
    test.skip(
      !FLOW_ENABLED,
      'Set TEST_MEMBER_*, TEST_ADMIN_* and DATABASE_URL to run the live auth flow.',
    );
  });

  test('valid credentials (team member) → redirects to /', async ({ page }) => {
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
  });

  test('invalid password → inline credential error', async ({ page }) => {
    await login(page, MEMBER_EMAIL, 'WrongPassword!1');
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('deactivated account → ACCOUNT_DEACTIVATED message', async ({ page }) => {
    await setStaffFlag(MEMBER_EMAIL, 'active', false);
    try {
      await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
      await expect(page.getByText('Account deactivated. Contact your admin.')).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      // Close the page BEFORE restoring. The login attempt leaves requests in
      // flight, and one that read active=false can write it back into the
      // staff_lookup cache after the restore deleted the key — re-poisoning it
      // for the full 5-minute TTL and handing every later spec that signs in as
      // this shared member an "Account deactivated" screen. No page, no new
      // requests; the settle covers whatever was already on the wire.
      await page.close();
      await new Promise((r) => setTimeout(r, 250));
      await setStaffFlag(MEMBER_EMAIL, 'active', true);
    }
  });

  test('admin without MFA → redirects to /mfa-setup', async ({ page }) => {
    // The test creates its own precondition instead of assuming it. The seeded
    // admin enrolled in MFA at some point, so this spec's "an admin WITHOUT MFA"
    // premise quietly stopped holding and the case failed on a stale fixture
    // rather than on the routing it exists to check.
    await setStaffFlag(ADMIN_EMAIL, 'mfa_enrolled', false);
    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await expect(page).toHaveURL(/\/mfa-setup$/);
    } finally {
      // Same reason as the deactivation case above — close first, then restore.
      await page.close();
      await new Promise((r) => setTimeout(r, 250));
      await setStaffFlag(ADMIN_EMAIL, 'mfa_enrolled', true);
    }
  });
});
