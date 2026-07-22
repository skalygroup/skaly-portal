import { test, expect, type Page } from '@playwright/test';

// typeInto, not fill(): fill() leaves this React-controlled input empty in
// webkit, so the form submitted blank.
import { typeInto } from '../helpers/auth';

/**
 * Forgot-password UI (Sprint 1 STEP 13). The backend is anti-enumeration: it
 * always returns 200 regardless of whether the email exists, and the UI must
 * mirror that — the same neutral confirmation in every case. We mock the
 * endpoint to 200 and assert the identical message for a known vs. unknown
 * address (the leak-proofing the prompt calls out).
 */

// The confirmation copy is broken across an echoed-email <strong>, so we assert
// the stable, account-agnostic remainder of the sentence.
const NEUTRAL_MESSAGE = /a reset link is on its way/;

async function mockReset(page: Page) {
  await page.route('**/v1/auth/password-reset', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'sent' }),
    }),
  );
}

test.describe('forgot password page', () => {
  test('client-side validation blocks an invalid email', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('Invalid email')).toBeVisible();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test('known email → neutral confirmation', async ({ page }) => {
    await mockReset(page);
    await page.goto('/forgot-password');
    await typeInto(page.getByLabel('Email'), 'admin@skalygroup.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByText(NEUTRAL_MESSAGE)).toBeVisible();
  });

  test('unknown email → identical confirmation (no enumeration leak)', async ({ page }) => {
    await mockReset(page);
    await page.goto('/forgot-password');
    await typeInto(page.getByLabel('Email'), 'nobody@nowhere.example');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByText(NEUTRAL_MESSAGE)).toBeVisible();
  });
});
