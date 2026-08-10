import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { typeInto } from '../helpers/auth';

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

  // Delete, then VERIFY, then delete again if needed.
  //
  // A single delete is not enough: a request already in flight can finish after
  // it and write the pre-change row straight back, and the stale value then
  // survives the full 5-minute TTL. Whichever spec next signs in as this shared
  // account gets the old state — that is what failed the team_member cases in
  // attendance, tasks and content-dropper, in the NEXT run, from here.
  // Note the exit condition: it keeps deleting until the cache holds the NEW
  // value, and an empty key is explicitly not good enough. Returning on empty
  // was the bug — the delete lands, the key reads empty, and the in-flight
  // request writes the old row back a moment later.
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!redisCli(['DEL', `staff_lookup:${uid}`])) return; // no redis — TTL will do it
    await new Promise((r) => setTimeout(r, 200));
    const cached = redisCli(['GET', `staff_lookup:${uid}`]) ?? '';
    if (cached.includes(`"${column}":${value}`)) return;
  }
}

/**
 * redis-cli through the compose stack, rather than a redis client: apps/web has
 * no redis dependency and docker compose is already a hard prerequisite of these
 * live specs. Returns null when redis is unreachable.
 */
function redisCli(args: string[]): string | null {
  try {
    return execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], {
      cwd: join(__dirname, '..', '..', '..', '..'),
      encoding: 'utf8',
    });
  } catch {
    return null;
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
  // typeInto, not fill(): fill() leaves these React-controlled inputs empty in
  // webkit (see the helper), so the form submitted blank and all four cases
  // failed on the wrong thing.
  await typeInto(page.getByLabel('Email'), email);
  await typeInto(page.locator('#password'), password);
  await page.getByRole('button', { name: /Sign in/i }).click();
}

test.describe('login (live auth flow)', () => {
  test.beforeEach(() => {
    test.skip(
      !FLOW_ENABLED,
      'Set TEST_MEMBER_*, TEST_ADMIN_* and DATABASE_URL to run the live auth flow.',
    );
  });

  test('valid credentials (team member) → lands on /home', async ({ page }) => {
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    // `/` was the landing route until the §4.1 sidebar shipped. It rendered a
    // Sprint 1 placeholder with no links to anything, so it stopped being
    // somewhere to leave a person and became a redirect to `/home` — the route
    // that actually has content and is in the permission registry.
    await expect(page).toHaveURL(/\/home$/);
  });

  test('invalid password → inline credential error', async ({ page }) => {
    await login(page, MEMBER_EMAIL, 'WrongPassword!1');
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('deactivated account → ACCOUNT_DEACTIVATED message', async ({ page, browserName }) => {
    // One engine only. This case and the MFA one below mutate a staff row that
    // the whole suite shares, so running them once per project means two passes
    // toggling the same account and racing each other's cache invalidation —
    // whichever runs second sees the other's state. Neither asserts anything
    // engine-specific: the subject is API routing and one message.
    test.skip(browserName !== 'chromium', 'mutates shared staff state — run once');
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

  test('admin without MFA → redirects to /mfa-setup', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'mutates shared staff state — run once');
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
