import { test, expect } from '@playwright/test';
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

async function setActive(email: string, active: boolean) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('UPDATE staff SET active = $1 WHERE email = $2', [active, email]);
  } finally {
    await client.end();
  }
}

async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
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
    await setActive(MEMBER_EMAIL, false);
    try {
      await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
      await expect(page.getByText('Account deactivated. Contact your admin.')).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await setActive(MEMBER_EMAIL, true);
    }
  });

  test('admin without MFA → redirects to /mfa-setup', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/mfa-setup$/);
  });
});
