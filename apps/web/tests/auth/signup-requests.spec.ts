import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { login } from '../helpers/auth';

/**
 * E2E: admin signup-request review (Sprint 1 STEP 14).
 *
 * Needs a live web app + API + Supabase test project and an MFA-enrolled admin
 * (so the middleware lets them past /mfa-setup into /settings). Configure via:
 *
 *   E2E_BASE_URL          web origin (default http://localhost:3000)
 *   DATABASE_URL          API Postgres — seeds a pending request, asserts result
 *   TEST_ADMIN_EMAIL      an admin with staff.mfa_enrolled = true
 *   TEST_ADMIN_PASSWORD
 *
 * Without these the whole describe self-skips, so the suite stays green until
 * the infra is wired. The applicant-side privacy boundary (internal note never
 * reaches the DOM) is covered deterministically in signup.ui.spec.ts.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD && process.env.DATABASE_URL);

const uniqueEmail = (tag: string) => `e2e-${tag}-${Date.now()}@test.skaly.in`;

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedPendingRequest(email: string, name: string) {
  return withDb(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO signup_requests (name, email, date_of_birth, mobile_number, role_requested, status)
       VALUES ($1, $2, '1995-05-05', '+919876543210', 'team_member', 'pending') RETURNING id`,
      [name, email],
    );
    return rows[0].id as string;
  });
}

async function cleanup(email: string) {
  await withDb(async (c) => {
    await c.query('DELETE FROM staff WHERE email = $1', [email]);
    await c.query('DELETE FROM signup_requests WHERE email = $1', [email]);
  });
}

/**
 * The old assertion pinned the destination to /settings, /home or / — but an
 * admin without MFA lands on /mfa-setup, so it failed on the redirect rather
 * than on anything this spec is about. The shared helper waits for "anywhere
 * but /login" instead.
 */
async function loginAsAdmin(page: Page) {
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
}

test.describe('admin signup requests (live flow)', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_* and DATABASE_URL to run the admin review flow.');
  });

  test('approve creates a staff row and marks the request approved', async ({ page }) => {
    const email = uniqueEmail('approve');
    const name = 'Approve Candidate';
    await seedPendingRequest(email, name);

    try {
      await loginAsAdmin(page);
      await page.goto('/settings/signup-requests?status=pending');

      const card = page.locator('article', { hasText: email });
      await expect(card).toBeVisible();

      await card.getByRole('button', { name: 'Approve' }).click();
      await page.getByRole('button', { name: 'Confirm approval' }).click();

      await expect(page.getByText(`Approved. ${name} has been notified.`)).toBeVisible();
      await expect(page.locator('article', { hasText: email })).toHaveCount(0);

      // DB: request approved + staff row exists.
      const result = await withDb(async (c) => {
        const reqRow = await c.query('SELECT status FROM signup_requests WHERE email = $1', [email]);
        const staffRow = await c.query('SELECT id FROM staff WHERE email = $1', [email]);
        return { status: reqRow.rows[0]?.status, staffCount: staffRow.rowCount };
      });
      expect(result.status).toBe('approved');
      expect(result.staffCount).toBe(1);
    } finally {
      await cleanup(email);
    }
  });

  test('reject stores the internal note and never leaks it to the applicant', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('reject');
    const name = 'Reject Candidate';
    await seedPendingRequest(email, name);

    try {
      await loginAsAdmin(page);
      await page.goto('/settings/signup-requests?status=pending');

      const card = page.locator('article', { hasText: email });
      await card.getByRole('button', { name: 'Reject' }).click();
      await page.getByLabel(/Internal note/).fill('INTERNAL: not a good fit');
      await page.getByLabel(/Message to user/).fill('We are not moving forward');
      await page.getByRole('button', { name: 'Confirm rejection' }).click();

      await expect(page.getByText(`Rejected. ${name} has been notified.`)).toBeVisible();

      // DB: note stored.
      const dbNote = await withDb(async (c) => {
        const r = await c.query(
          'SELECT status, rejection_note FROM signup_requests WHERE email = $1',
          [email],
        );
        return r.rows[0];
      });
      expect(dbNote.status).toBe('rejected');
      expect(dbNote.rejection_note).toContain('INTERNAL');

      // Applicant view: public message present, internal note absent.
      const applicant = await browser.newContext();
      const ap = await applicant.newPage();
      await ap.goto(`/signup/pending?email=${encodeURIComponent(email)}&role=team_member`);
      await expect(ap.getByText('We are not moving forward')).toBeVisible({ timeout: 20_000 });
      await expect(ap.locator('body')).not.toContainText('INTERNAL');
      await applicant.close();
    } finally {
      await cleanup(email);
    }
  });
});
