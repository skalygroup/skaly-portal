import { test, expect } from '@playwright/test';

/**
 * Reset-password UI (Sprint 1 STEP 13). Without the recovery session that
 * Supabase's email link establishes, the page is a dead-end pointing back to
 * /forgot-password. That branch is fully deterministic (no session, no infra),
 * so it lives here; the happy path (valid recovery session → set new password →
 * redirect to /login) needs a live Supabase project and lives in the
 * infra-gated password-reset.spec.ts.
 */
test.describe('reset password page (no recovery session)', () => {
  test('shows the expired-link dead-end with a path to request a new one', async ({ page }) => {
    await page.goto('/reset-password');

    // Resolves once the client has confirmed there's no session (short grace).
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByText(/This reset link has expired or is invalid/)).toBeVisible();

    const link = page.getByRole('link', { name: /Request a new link/ });
    await expect(link).toHaveAttribute('href', '/forgot-password');
  });

  test('does not render the new-password form without a session', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByLabel('New password')).toHaveCount(0);
  });
});
