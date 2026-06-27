import { test, expect, type Page } from '@playwright/test';

/**
 * MFA setup UI (Sprint 1 STEP 13). Drives a real browser against the web dev
 * server with every network dependency mocked — the backend enroll/verify calls
 * and Supabase's own challenge/verify factor endpoints — so it runs anywhere
 * without a live Supabase project or seeded admin (the runnable counterpart to
 * the infra-gated mfa.spec.ts).
 */

// 1×1 PNG — stands in for the QR the backend would return as a data URL.
const QR_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SECRET = 'JBSWY3DPEHPK3PXP';
const RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `code-${i.toString().padStart(2, '0')}`);
const FACTOR_ID = 'factor-test-1';

async function mockEnroll(page: Page) {
  await page.route('**/v1/auth/mfa/enroll', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        factorId: FACTOR_ID,
        qrCodeDataUrl: QR_DATA_URL,
        secret: SECRET,
        recoveryCodes: RECOVERY_CODES,
      }),
    }),
  );
}

// Supabase client-side challenge always succeeds in these tests; the `verify`
// outcome is what each test varies.
async function mockSupabaseChallenge(page: Page) {
  await page.route('**/auth/v1/factors/*/challenge', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'challenge-1', type: 'totp', expires_at: 9999999999 }),
    }),
  );
}

test.describe('mfa setup page', () => {
  test('renders QR, manual secret, and the 6-digit input', async ({ page }) => {
    await mockEnroll(page);
    await page.goto('/mfa-setup');

    await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeVisible();

    const qr = page.getByAltText('MFA QR code');
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('src', QR_DATA_URL);

    await expect(
      page.getByText("Can't scan? Enter this code manually in your authenticator app:"),
    ).toBeVisible();
    await expect(page.getByText(SECRET)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy setup code' })).toBeVisible();

    // Six OTP slots are present (input-otp renders one input + six boxes).
    await expect(page.getByLabel('6-digit verification code')).toBeVisible();
  });

  test('wrong code shows "Incorrect code. Try again."', async ({ page }) => {
    await mockEnroll(page);
    await mockSupabaseChallenge(page);
    await page.route('**/auth/v1/factors/*/verify', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_code', message: 'Invalid TOTP code entered' }),
      }),
    );

    await page.goto('/mfa-setup');
    await page.getByLabel('6-digit verification code').fill('000000');

    await expect(page.getByText('Incorrect code. Try again.')).toBeVisible();
    // Still on the enroll step — no recovery codes leaked.
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toHaveCount(0);
  });

  test('correct code reveals recovery codes behind the saved-it gate', async ({ page }) => {
    await mockEnroll(page);
    await mockSupabaseChallenge(page);
    // Supabase verify success returns a session; supabase-js persists it.
    await page.route('**/auth/v1/factors/*/verify', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'fake-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 9999999999,
          refresh_token: 'fake-refresh-token',
          user: { id: 'user-1', aud: 'authenticated', role: 'authenticated' },
        }),
      }),
    );
    // Backend flips staff.mfa_enrolled.
    await page.route('**/v1/auth/mfa/verify', (route) => route.fulfill({ status: 204, body: '' }));

    await page.goto('/mfa-setup');
    await page.getByLabel('6-digit verification code').fill('123456');

    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();

    // All ten codes are listed exactly once.
    for (const code of RECOVERY_CODES) {
      await expect(page.getByText(code, { exact: true })).toBeVisible();
    }

    // Continue is gated until the acknowledgement checkbox is ticked. The real
    // checkbox is visually hidden (sr-only), so toggle it via its label.
    const cont = page.getByRole('button', { name: 'Continue to portal' });
    await expect(cont).toBeDisabled();
    await page.getByText(/saved my recovery codes somewhere secure/).click();
    await expect(page.getByRole('checkbox')).toBeChecked();
    await expect(cont).toBeEnabled();
  });
});
