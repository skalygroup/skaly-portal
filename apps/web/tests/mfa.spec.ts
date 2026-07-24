import { test, expect } from '@playwright/test';
import { Client } from 'pg';

import { login } from './helpers/auth';
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

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const sbHeaders = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` };

/** The throwaway admin's Supabase uid, read from the staff row that links them. */
async function mfaAdminUid(): Promise<string> {
  const { rows } = await withDb((c) =>
    c.query('SELECT supabase_uid FROM staff WHERE email = $1 AND deleted_at IS NULL', [MFA_EMAIL]),
  );
  const uid = rows[0]?.supabase_uid as string | undefined;
  if (!uid) throw new Error(`No staff row with a supabase_uid for ${MFA_EMAIL}.`);
  return uid;
}

/**
 * Put the throwaway admin back in the un-enrolled state: no TOTP factor in
 * Supabase, mfa_enrolled=false in our own table. Both halves matter — a factor
 * left behind sends the next run to /mfa-challenge instead of /mfa-setup, and a
 * stale mfa_enrolled=true does the same via the middleware.
 */
async function resetEnrollment(): Promise<void> {
  const uid = await mfaAdminUid();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}/factors`, {
    headers: sbHeaders,
  });
  const factors = (await res.json()) as Array<{ id: string }>;
  for (const f of Array.isArray(factors) ? factors : []) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}/factors/${f.id}`, {
      method: 'DELETE',
      headers: sbHeaders,
    });
  }
  await withDb((c) => c.query('UPDATE staff SET mfa_enrolled = false WHERE email = $1', [MFA_EMAIL]));
}

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

    // Continue is gated on the acknowledgement when codes were actually issued.
    // The backend mints them; on the client-side fallback path the list is empty
    // and the gate is absent — handle both rather than assume which ran.
    const cont = page.getByRole('button', { name: 'Continue to portal' });
    const ack = page.getByText(/saved my recovery codes somewhere secure/);
    if (await ack.isVisible()) {
      await expect(cont).toBeDisabled();
      await ack.click();
      await expect(cont).toBeEnabled();
    }
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
