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
 * (Browsers: `npx playwright install chromium webkit` once.)
 *
 * THE API MUST HAVE ITS RATE LIMIT LIFTED for a full-suite run. The global cap
 * is 150 req/min keyed by IP (API-Contract §2); a whole suite is ~50 sign-ins
 * plus grid fetches from one address, so specs late in the run get 429 where
 * they assert 403 — rate-limited rather than tested. Start the API with:
 *   PORT=3002 RATE_LIMIT_MAX=1000000 pnpm --filter @skaly/api dev
 * and point both the app and the specs at it:
 *   NEXT_PUBLIC_API_URL=http://localhost:3002
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  /**
   * 60s, not Playwright's default 30s — because `login()` does not fit in 30s.
   *
   * The helper's own barriers add up: waitForURL past /login (15s) + the TOTP
   * window step-over (up to 3.5s) + waitForURL past /mfa-challenge (15s) = 33.5s
   * worst case for ONE admin sign-in. Any spec that signs in twice — search.spec
   * §CMD+K, and every two-context real-time spec Sprint 10 adds — was over budget
   * by construction, not flaky. It presented as a 30s timeout with the email field
   * caught half-typed, which reads like broken auth and is not.
   *
   * Raised here rather than per-spec: the cost lives in the shared helper, so the
   * budget belongs next to it. 60s still fails a genuine hang promptly.
   */
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  /**
   * One worker. fullyParallel:false only serialises tests WITHIN a file — files
   * still run concurrently, and the default here was 4 workers.
   *
   * These are live specs against one database and one set of shared accounts.
   * With parallel files, login.spec's deactivation case (which flips
   * staff.active and restores it) overlapped attendance's team_member case,
   * which then signed in during the deactivated window and failed. Same story
   * for anything else touching shared rows. Every "passes alone, fails in the
   * suite" symptom in this suite traced back to here, and each one previously
   * got explained away as flakiness.
   */
  workers: 1,
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
