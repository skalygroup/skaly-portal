import { expect, test } from '@playwright/test';

import { authHeaders, login, typeInto } from './helpers/auth';
import { staffIdByEmail, withDb } from './helpers/db';
import { mfaAdminUid, resetEnrollment } from './helpers/mfa-admin';
import { totp } from './helpers/totp';

import type { Browser, Page } from '@playwright/test';

/**
 * Recovery codes, end to end (Sprint 11 STEP 8 — ADR-002's last deferral).
 *
 * This is the "I lost my phone" path, and it is the only way back into an
 * enrolled account that does not involve an admin. It cannot be tested from a
 * fixture: a recovery code is stored as a hash and shown exactly once, at
 * enrolment, so the only way to hold a valid one is to enrol and read it off
 * the screen — which is what this spec does before every test.
 *
 * Runs against the DEDICATED throwaway admin (TEST_MFA_ADMIN_*), never a
 * human's account; see helpers/mfa-admin.ts.
 *
 * A redeemed code does NOT step the session up to aal2 — only Supabase's own
 * verify mints that, and the API never sees a TOTP code. So redeeming clears
 * the factor and lands on /mfa-setup to enrol a new authenticator, which is
 * also what losing the device actually means.
 */
const MFA_EMAIL = process.env.TEST_MFA_ADMIN_EMAIL ?? '';
const MFA_PASSWORD = process.env.TEST_MFA_ADMIN_PASSWORD ?? '';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const FLOW_ENABLED = Boolean(
  MFA_PASSWORD && ADMIN_PASSWORD && SUPABASE_URL && SERVICE_KEY && process.env.DATABASE_URL,
);

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Enrol the throwaway admin and return a known set of recovery codes.
 *
 * ⚠️ THE CODES COME FROM `/recovery/regenerate`, NOT FROM THE ENROLMENT SCREEN.
 *
 * The enrolment screen shows them only when the API minted them, and it does not
 * always mint them: `POST /v1/auth/mfa/enroll` answers 501 where the installed
 * Supabase admin SDK has no server-side enroll, and `mfa-setup` then falls back
 * to enrolling through the user's own session — a path that issues NO codes and
 * renders no `<pre>` to read. Which path runs is a property of the deployment,
 * so a spec that scraped the screen would pass or fail on the environment
 * rather than on the feature.
 *
 * `regenerate` needs aal2, which the enrolment above has just produced, and it
 * is the same endpoint the profile card uses — so the set obtained here is one a
 * real user could hold.
 */
async function enrolAndCaptureCodes(page: Page): Promise<string[]> {
  await login(page, MFA_EMAIL, MFA_PASSWORD);
  await page.waitForURL(/\/mfa-setup/, { timeout: 20_000 });

  const secret = (await page.locator('code.select-all').innerText()).trim();

  // Step over an imminent window boundary so the code cannot expire between the
  // fill and Supabase validating it.
  const remainingMs = 30_000 - (Date.now() % 30_000);
  if (remainingMs < 5_000) await page.waitForTimeout(remainingMs + 500);
  await page.getByLabel('6-digit verification code').fill(totp(secret));

  // Reached only on a genuinely correct code, so arriving here IS the assertion
  // that Supabase accepted it.
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible({
    timeout: 30_000,
  });

  // The acknowledgement gate exists only when codes were actually shown.
  const ack = page.getByText(/saved my recovery codes somewhere secure/);
  if (await ack.isVisible()) await ack.click();
  await page.getByRole('button', { name: 'Continue to portal' }).click();
  await page.waitForURL((u) => !/\/mfa-setup|\/mfa-challenge|\/login/.test(u.pathname), {
    timeout: 20_000,
  });

  const res = await page.request.post(`${API}/v1/auth/mfa/recovery/regenerate`, {
    headers: await authHeaders(page.context()),
  });
  expect(res.ok(), `regenerate failed: ${res.status()}`).toBe(true);
  const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
  expect(recoveryCodes.length, 'a regenerated set must contain codes').toBeGreaterThan(2);

  return recoveryCodes;
}

/** A fresh context signing in — the closest thing to "logs out" this app has. */
async function signInAgain(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await typeInto(page.getByLabel('Email'), MFA_EMAIL);
  await typeInto(page.locator('#password'), MFA_PASSWORD);
  await page.getByRole('button', { name: /Sign in/i }).click();
  // Deliberately NOT the shared login(): that helper clears the TOTP challenge
  // for you, and the challenge page is the subject here.
  await page.waitForURL(/\/mfa-challenge/, { timeout: 20_000 });
  return page;
}

/**
 * Clear the shared MFA failure budget by having an admin reset this account's
 * MFA — the product's own remedy for MFA_LOCKED.
 *
 * The budget lives in Redis with a 15-minute TTL, which is longer than a suite
 * run: a lockout left behind fails mfa.spec.ts's enrolment (verifyMfa checks it
 * first) with an error about the wrong thing entirely. Going through the admin
 * endpoint rather than reaching into Redis keeps this suite free of a Redis
 * client, and asserts in passing that the button an admin would actually press
 * does the job.
 */
async function adminResetMfa(browser: Browser): Promise<void> {
  const targetId = await staffIdByEmail(MFA_EMAIL);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = await authHeaders(context);
    const res = await page.request.put(`${API}/v1/staff/${targetId}/mfa/reset`, {
      headers: auth,
    });
    expect(res.ok(), `admin MFA reset failed: ${res.status()}`).toBe(true);
  } finally {
    await context.close();
  }
}

test.describe('mfa recovery codes — live', () => {
  // Enrolment + a possible 30s TOTP-window wait + a second sign-in.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    test.skip(!FLOW_ENABLED, 'Set TEST_MFA_ADMIN_*, TEST_ADMIN_*, SUPABASE_* and DATABASE_URL.');
    await resetEnrollment();
  });

  test.afterEach(async () => {
    if (FLOW_ENABLED) await resetEnrollment();
  });

  test('⭐ a valid recovery code signs you in and reports what is left', async ({ page, browser }) => {
    const codes = await enrolAndCaptureCodes(page);

    const second = await signInAgain(browser);
    try {
      await second.getByRole('button', { name: /Use a recovery code/ }).click();
      await second.getByLabel('Recovery code').fill(codes[0]!);
      await second.getByRole('button', { name: 'Use recovery code' }).click();

      // Redeeming clears the factor, so the middleware's enrolment rule takes
      // over from its aal2 rule — /mfa-setup is where it would send us anyway.
      await second.waitForURL(/\/mfa-setup/, { timeout: 20_000 });

      // The count is the whole reason the banner exists: someone down to their
      // last code needs to know before they lose it, not after.
      await expect(second.getByText(/You signed in with a recovery code/)).toBeVisible();
      await expect(second.getByText(`${codes.length - 1} codes remaining.`)).toBeVisible();

      // The DB agrees — the code is SPENT, not merely accepted.
      const used = await withDb(async (c) => {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM mfa_recovery_codes
             WHERE staff_id = (SELECT id FROM staff WHERE email = $1) AND used_at IS NOT NULL`,
          [MFA_EMAIL],
        );
        return Number(rows[0]!.n);
      });
      expect(used).toBe(1);

      // And the authenticator is genuinely gone from Supabase, not just from
      // our own flag — the two disagreeing is what strands someone at a
      // challenge they can never pass.
      //
      // VERIFIED factors only. Landing on /mfa-setup starts a fresh enrolment on
      // mount, so an `unverified` factor exists by the time this runs and is
      // correct: it is the new authenticator being offered, not the old one
      // surviving.
      const uid = await mfaAdminUid();
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}/factors`, {
        headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
      });
      const factors = (await res.json()) as Array<{ status: string }>;
      expect(factors.filter((f) => f.status === 'verified')).toHaveLength(0);
    } finally {
      await second.context().close();
    }
  });

  /**
   * Single use, enforced by the database rather than by a read-then-write.
   *
   * Asserted at the API rather than through /mfa-challenge because a redeemed
   * code has already cleared the factor: the second sign-in lands on
   * /mfa-setup, and there is no challenge page left to type into. The UI half
   * of the redeem is covered above; what is left to prove is that the code
   * itself is dead, and that is a property of the endpoint.
   */
  test('a spent recovery code is refused the second time', async ({ page, browser }) => {
    const codes = await enrolAndCaptureCodes(page);
    const auth = await authHeaders(page.context());

    const redeem = (code: string) =>
      page.request.post(`${API}/v1/auth/mfa/recovery`, {
        headers: { ...auth, 'content-type': 'application/json' },
        data: { code },
      });

    const first = await redeem(codes[0]!);
    expect(first.status()).toBe(200);

    const second = await redeem(codes[0]!);
    expect(second.status()).toBe(403);
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('MFA_FAILED');

    // Two consumed-code failures would otherwise sit in the budget for 15
    // minutes; the reuse above spent one of the three.
    await adminResetMfa(browser);
  });

  /**
   * ONE failure budget for the whole MFA step, shared by every credential type
   * (Auth-Matrix §10).
   *
   * The mix is the point. A budget counted per credential type would mean three
   * TOTP attempts AND three code attempts — six — which is not what the spec
   * says and not what anyone reviewing an incident would assume. So this burns
   * one on a bad TOTP code and two on bad recovery codes, and the third must
   * lock.
   */
  test('three bad attempts across BOTH credential types lock the step', async ({ page, browser }) => {
    const codes = await enrolAndCaptureCodes(page);

    const second = await signInAgain(browser);
    try {
      // 1 — a bad TOTP code. The API never sees it, so the page reports the
      // failure itself; without that report the budget would silently be
      // per-credential-type.
      await second.getByLabel('6-digit verification code').fill('000000');
      await expect(second.getByText('Incorrect code. Try again.')).toBeVisible({ timeout: 30_000 });

      await second.getByRole('button', { name: /Use a recovery code/ }).click();

      // 2 — a bad recovery code.
      await second.getByLabel('Recovery code').fill('deadbeef00');
      await second.getByRole('button', { name: 'Use recovery code' }).click();
      await expect(second.getByText(/isn.t valid, or it has already been used/)).toBeVisible();

      // 3 — the budget is now SPENT, but this attempt still reports the code as
      // invalid: `assertMfaNotLocked` runs BEFORE the check and asks whether the
      // three were already used, so the third failure is what fills the budget
      // rather than what meets it.
      await second.getByLabel('Recovery code').fill('deadbeef01');
      await second.getByRole('button', { name: 'Use recovery code' }).click();
      await expect(second.getByText(/isn.t valid, or it has already been used/)).toBeVisible();

      // 4 — and now a GENUINELY VALID code is refused. That is the assertion
      // worth making: a lock that only rejected wrong credentials would be
      // indistinguishable from no lock at all. The message changes from "wrong"
      // to "locked", which is the difference between "try again" and "stop".
      await second.getByLabel('Recovery code').fill(codes[0]!);
      await second.getByRole('button', { name: 'Use recovery code' }).click();
      await expect(second.getByText(/Too many failed attempts/)).toBeVisible();
    } finally {
      await second.context().close();
      // The lock outlives this test by 15 minutes and would fail mfa.spec.ts
      // with a message about the wrong thing. Clear it the way an admin would.
      await adminResetMfa(browser);
    }
  });
});
