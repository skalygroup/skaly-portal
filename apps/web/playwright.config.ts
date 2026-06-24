import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the web app's E2E suite (apps/web/tests).
 *
 * Two tiers of tests live here:
 *  - login.ui.spec.ts   — UI + client-side validation. Needs ONLY the web dev
 *    server (started below), so it runs anywhere, including CI. Always-on.
 *  - login.spec.ts      — the full auth flow (real Supabase + API + seeded
 *    users). These self-skip unless the TEST_ and DATABASE_URL env vars are set,
 *    so the suite stays green until that infra is wired.
 *
 * Run:  pnpm --filter @skaly/web exec playwright test
 * (Browsers: `npx playwright install chromium` once.)
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  // Boot the web app for the suite; reuse an already-running dev server locally.
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
