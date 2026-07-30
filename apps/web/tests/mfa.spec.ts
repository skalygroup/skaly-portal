import { test, expect } from '@playwright/test';

import { login } from './helpers/auth';
import { withDb } from './helpers/db';
import { resetEnrollment } from './helpers/mfa-admin';
import { totp } from './helpers/totp';

/**
 * E2E: MFA enrollment against real Supabase (Sprint 8 STEP 9.4, ADR-002 — the
 * launch gate). No mocking: a real admin enrolls a real TOTP factor and the
 * 6-digit codes are computed from the secret the page shows, exactly as an
 * authenticator app would. tests/auth/mfa-setup.ui.spec.ts covers the same page
 * with everything mocked; this one proves the round trip actually works.
 *
 * Runs against a DEDICATED throwaway admin (TEST_MFA_ADMIN_*), never a human's
 * account: enrollment is only testable from the un-enrolled state, so the spec
 * resets that account — deleting its TOTP factor and clearing staff.mfa_enrolled
 * — before and after each run. Pointing this at a real admin would repeatedly
 * destroy their authenticator entry.
 *
 *   TEST_MFA_ADMIN_EMAIL / TEST_MFA_ADMIN_PASSWORD   throwaway admin
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY         to delete its factors
 *   DATABASE_URL                                     to read/reset mfa_enrolled
 */

const MFA_EMAIL = process.env.TEST_MFA_ADMIN_EMAIL ?? '';
const MFA_PASSWORD = process.env.TEST_MFA_ADMIN_PASSWORD ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const FLOW_ENABLED = Boolean(
  MFA_EMAIL && MFA_PASSWORD && SUPABASE_URL && SERVICE_KEY && process.env.DATABASE_URL,
);

// withDb / resetEnrollment moved to helpers — mfa-recovery.spec.ts needs the
// same reset, and two copies is one place to forget the mfa_enrolled half.

test.describe('mfa enrollment — live', () => {
  // Supabase enroll + challenge + verify plus a possible 30s TOTP-window wait.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async () => {
    test.skip(!FLOW_ENABLED, 'Set TEST_MFA_ADMIN_*, SUPABASE_* and DATABASE_URL to run the MFA E2E.');
    await resetEnrollment();
  });

  test.afterEach(async () => {
    if (FLOW_ENABLED) await resetEnrollment();
  });

  test('un-enrolled admin enrols TOTP and lands in the portal with mfa_enrolled set', async ({
    page,
  }) => {
    // An admin with mfa_enrolled=false cannot reach the portal — both the login
    // page and the middleware route them here (AUTH-MATRIX §10).
    await login(page, MFA_EMAIL, MFA_PASSWORD);
    await page.waitForURL(/\/mfa-setup/, { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeVisible();

    // The QR is a data: URL minted for this factor, not a placeholder asset.
    const qr = page.getByAltText('MFA QR code');
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\//);

    // The manual setup code is what an authenticator would consume — and what
    // this test consumes, which is the whole reason it can run unattended.
    const secret = (await page.locator('code.select-all').innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // Mint the code just after a window boundary if one is imminent, so it can't
    // expire between the fill and Supabase validating it.
    const remainingMs = 30_000 - (Date.now() % 30_000);
    if (remainingMs < 5_000) await page.waitForTimeout(remainingMs + 500);

    // The page auto-submits on the 6th digit.
    await page.getByLabel('6-digit verification code').fill(totp(secret));

    // Verified → the recovery-codes step. Reached only on a genuinely correct
    // code, so arriving here IS the assertion that Supabase accepted it.
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible({
      timeout: 30_000,
    });

    /**
     * ⭐ ADR-031's Rule, on the only path this environment actually runs.
     *
     * The gate is NOT optional. It used to be asserted as "if it's there" —
     * which is a tautology on the branch that matters: `/v1/auth/mfa/enroll`
     * 501s here (the installed auth-js admin client has no `mfa.enrollFactor`,
     * see AuthService.ts), so this test always takes the client fallback, and
     * that fallback is exactly the one that used to finish with zero codes and
     * no gate. Tolerating a missing gate made the hole ADR-031 closed invisible
     * to the one test that runs against real Supabase.
     */
    const cont = page.getByRole('button', { name: 'Continue to portal' });
    const ack = page.getByText(/saved my recovery codes somewhere secure/);
    await expect(ack, 'ADR-031 §3: the acknowledgment gate applies to BOTH paths').toBeVisible();
    await expect(cont).toBeDisabled();
    await ack.click();
    await expect(cont).toBeEnabled();
    await cont.click();

    // Landed inside the portal — not bounced back to setup or to the challenge.
    await page.waitForURL((u) => !/\/mfa-setup|\/mfa-challenge|\/login/.test(u.pathname), {
      timeout: 20_000,
    });

    // The backend recorded it: this is the flag the middleware gates on.
    const { rows } = await withDb((c) =>
      c.query('SELECT mfa_enrolled FROM staff WHERE email = $1', [MFA_EMAIL]),
    );
    expect(rows[0]?.mfa_enrolled).toBe(true);

    // ⭐ And the codes genuinely exist. Ten shown on screen proves the mint
    // returned; this proves it PERSISTED, which is what the redeem path spends.
    // Unambiguous because resetEnrollment() deleted this account's codes in
    // beforeEach — a leftover set from an earlier run cannot be what is counted.
    const codes = await withDb((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM mfa_recovery_codes
          WHERE staff_id = (SELECT id FROM staff WHERE email = $1)`,
        [MFA_EMAIL],
      ),
    );
    expect(codes.rows[0]?.n, 'ADR-031 Rule: nobody leaves enrollment without codes').toBe(10);
  });

  test('a wrong code is rejected and no recovery codes are revealed', async ({ page }) => {
    await login(page, MFA_EMAIL, MFA_PASSWORD);
    await page.waitForURL(/\/mfa-setup/, { timeout: 20_000 });
    await expect(page.getByAltText('MFA QR code')).toBeVisible();

    await page.getByLabel('6-digit verification code').fill('000000');

    await expect(page.getByText('Incorrect code. Try again.')).toBeVisible({ timeout: 30_000 });
    // The secrets stay behind the gate, and enrollment did not complete.
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toHaveCount(0);

    const { rows } = await withDb((c) =>
      c.query('SELECT mfa_enrolled FROM staff WHERE email = $1', [MFA_EMAIL]),
    );
    expect(rows[0]?.mfa_enrolled).toBe(false);
  });
});
