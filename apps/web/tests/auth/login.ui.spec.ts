import { test, expect } from '@playwright/test';

/**
 * Login UI + client-side validation. Drives a real browser against the web dev
 * server only — no Supabase, API, or seeded users — so it runs deterministically
 * anywhere (this is the runnable counterpart to the infra-gated login.spec.ts).
 */
test.describe('login page (redesign)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('renders the redesigned split-screen', async ({ page }) => {
    // Form column ('#password' avoids the "Show password" toggle button).
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    await expect(page.getByRole('link', { name: /Request access/ })).toHaveAttribute(
      'href',
      '/signup',
    );

    // Brand panel (visible at the default desktop viewport)
    await expect(page.getByText('organised.')).toBeVisible();
    await expect(page.getByText('Operations platform')).toBeVisible();
  });

  test('client-side validation blocks an invalid submit', async ({ page }) => {
    // Empty email + password → zod errors, no Supabase call, stays on /login.
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid email')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    // A too-short password is still rejected client-side.
    await page.getByLabel('Email').fill('person@skalygroup.com');
    await page.locator('#password').fill('short');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(/at least 10/i)).toBeVisible();
  });

  test('password visibility toggle works', async ({ page }) => {
    const password = page.locator('#password');
    await password.fill('SuperSecret1!');
    await expect(password).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');

    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });
});
