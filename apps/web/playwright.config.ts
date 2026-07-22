import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Load apps/web/.env.e2e (gitignored) so the live specs get their credentials
 * without the caller having to export anything.
 *
 * Deliberately NOT `set -a; . ./.env.e2e` in a shell: these values are unquoted,
 * and a password containing `$` gets partially expanded by the shell — a real
 * password silently arrives truncated at the `$`, and the failure looks like a
 * broken login flow rather than a broken loader. Read the file literally instead.
 * Hand-parsed rather than adding a dotenv dependency for six lines.
 */
function loadE2eEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(join(__dirname, '.env.e2e'), 'utf8');
  } catch {
    return; // absent is fine — the live specs self-skip.
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    // Strip one layer of wrapping quotes if present; otherwise take it verbatim.
    const value = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value; // a real env var still wins
  }
}
loadE2eEnv();

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Sprint 7 close-out asks for webkit too. Install once: `playwright install webkit`.
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
