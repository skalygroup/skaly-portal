import { test, expect, type Route } from '@playwright/test';

/**
 * Signup UI + client behaviour. Drives a real browser against the web dev
 * server only — the API is stubbed via route interception and timers are driven
 * with the Playwright clock — so the polling, approval, and rejection paths run
 * deterministically anywhere (the infra-gated real flow lives in signup.spec.ts).
 */

const STATUS_GLOB = '**/auth/signup-requests/me/status*';

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('signup page (request access)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signup');
  });

  test('renders PATH A (Google) and PATH B (form)', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /Join the workspace/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText('Date of birth')).toBeVisible();
    await expect(page.getByLabel('Mobile number')).toBeVisible();
    await expect(page.getByText('Role requested')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeVisible();
  });

  test('client-side validation blocks an invalid submit', async ({ page }) => {
    await page.getByRole('button', { name: 'Submit request' }).click();
    // Zod errors render; no navigation away from /signup.
    await expect(page.getByText('Invalid email')).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
  });

  test('rejects a wrong-type and an oversized CV inline', async ({ page }) => {
    await page.locator('#cv').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await expect(page.getByText('CV must be a PDF, DOC, or DOCX file.')).toBeVisible();

    await page.locator('#cv').setInputFiles({
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(6 * 1024 * 1024),
    });
    await expect(page.getByText('CV must be 5 MB or smaller.')).toBeVisible();
  });

  test('valid submit posts multipart and lands on the pending page', async ({ page }) => {
    await page.route('**/v1/auth/signup/request', (route) =>
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ requestId: 'r1', status: 'pending' }) }),
    );
    const requestPromise = page.waitForRequest('**/v1/auth/signup/request');

    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill('jane@example.com');
    // Custom date picker: open the trigger, pick a day via "Today".
    await page.getByText('dd-mm-yyyy').click();
    await page.getByRole('button', { name: 'Today' }).click();
    await page.getByLabel('Mobile number').fill('+919876543210');
    await page.getByRole('button', { name: 'Submit request' }).click();

    const req = await requestPromise;
    expect(req.method()).toBe('POST');
    expect(req.headers()['content-type'] ?? '').toContain('multipart/form-data');
    await expect(page).toHaveURL(/\/signup\/pending\?email=jane%40example\.com&role=team_member/);
  });

  test('409 ALREADY_PROCESSED shows an inline sign-in link', async ({ page }) => {
    await page.route('**/v1/auth/signup/request', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'ALREADY_PROCESSED', message: 'exists' } }),
      }),
    );

    await page.getByLabel('Full name').fill('Jane Doe');
    await page.getByLabel('Email').fill('jane@example.com');
    // Custom date picker: open the trigger, pick a day via "Today".
    await page.getByText('dd-mm-yyyy').click();
    await page.getByRole('button', { name: 'Today' }).click();
    await page.getByLabel('Mobile number').fill('+919876543210');
    await page.getByRole('button', { name: 'Submit request' }).click();

    const banner = page.getByRole('alert');
    await expect(banner.getByText(/already exists for this email/i)).toBeVisible();
    await expect(banner.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login');
    await expect(page).toHaveURL(/\/signup$/);
  });
});

test.describe('pending page (polling)', () => {
  // Real timers (not page.clock): the poll's fetch path goes through Supabase
  // getSession, whose internal timers deadlock under a faked clock. The first
  // poll fires at 10s, so these wait in real time with a generous timeout.
  test('approved status → success toast and redirect to login', async ({ page }) => {
    await page.route(
      STATUS_GLOB,
      jsonRoute({ status: 'approved', publicRejectionMessage: null, submittedAt: new Date().toISOString() }),
    );
    await page.goto('/signup/pending?email=jane%40example.com&role=team_member');

    await expect(page.getByRole('heading', { name: /approved/i })).toBeVisible({ timeout: 20_000 });
    // A 2s timer then bounces to /login.
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('rejected status shows the public message, never the internal note', async ({ page }) => {
    await page.route(
      STATUS_GLOB,
      jsonRoute({
        status: 'rejected',
        publicRejectionMessage: 'Not the right fit at this time.',
        // A leaked internal note (the real API can never send this) must be
        // ignored by the page — defense in depth (STEP 7 contract).
        rejectionNote: 'SECRET_INTERNAL_NOTE_DO_NOT_SHOW',
        submittedAt: new Date().toISOString(),
      }),
    );
    await page.goto('/signup/pending?email=jane%40example.com&role=team_member');

    await expect(page.getByText('Not the right fit at this time.')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('body')).not.toContainText('SECRET_INTERNAL_NOTE_DO_NOT_SHOW');
    // Stays put — no redirect on rejection.
    await expect(page).toHaveURL(/\/signup\/pending/);
  });

  test('missing email param shows a graceful empty state', async ({ page }) => {
    await page.goto('/signup/pending');
    await expect(page.getByRole('heading', { name: 'Nothing to show' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to login' })).toBeVisible();
  });
});

test.describe('invite page', () => {
  test('missing token → invalid link', async ({ page }) => {
    await page.goto('/signup/invite');
    await expect(page.getByRole('heading', { name: 'Invalid link' })).toBeVisible();
  });

  test('expired token → expired terminal page (mocked check)', async ({ page }) => {
    await page.route('**/v1/auth/invite/*/check', (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INVITE_EXPIRED', message: 'expired' } }),
      }),
    );
    await page.goto('/signup/invite?token=0123456789012345678901234567890123456789');
    await expect(page.getByRole('heading', { name: 'Invite expired' })).toBeVisible();
  });

  test('valid token → form with read-only email (mocked check)', async ({ page }) => {
    await page.route('**/v1/auth/invite/*/check', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'invited@example.com', role: 'team_member' }),
      }),
    );
    await page.goto('/signup/invite?token=0123456789012345678901234567890123456789');
    await expect(page.getByRole('heading', { name: 'Accept your invite' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue('invited@example.com');
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  });
});
