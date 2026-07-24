import { expect, type Locator, type Page } from '@playwright/test';

import { totp } from './totp';

/**
 * Shared E2E auth helpers.
 *
 * These existed as five near-identical copies across the module specs, and the
 * copies drifted: Sprint 6's content-dropper spec learned that a sign-in must be
 * awaited before navigating, added the barrier below, and the other four never
 * got it — so attendance, tasks and shoot-planner raced their sign-in and every
 * grid fetch went out unauthenticated. Those specs had never actually run (the
 * .env.e2e loader was broken), so nothing surfaced it until Sprint 7.
 *
 * One copy, so the next lesson lands everywhere.
 */

/**
 * Type into a React-controlled field, key by key.
 *
 * NOT `fill()`: in webkit it leaves these inputs empty. fill() sets `value` and
 * dispatches one input event, and React's value tracker treats that as no change,
 * so the next render restores "". Chromium tolerates it; webkit does not, which
 * is why the whole suite passed on one engine and failed on the other.
 */
export async function typeInto(field: Locator, value: string): Promise<void> {
  await field.click();
  await field.pressSequentially(value);
}

/**
 * Sign in and WAIT for the post-login redirect.
 *
 * The barrier is load-bearing, not politeness: the login page redirects only
 * after signInWithPassword resolves and the session is persisted. A page.goto()
 * issued before that races the sign-in, the module's first API call goes out
 * with no Authorization header, and the grid renders its "Could not load …"
 * error state — which reads like a broken feature, not a broken test.
 *
 * The destination varies (an admin without MFA lands on /mfa-setup, others on
 * /), so the predicate is "anywhere but /login" rather than a specific path.
 */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  const emailField = page.getByLabel('Email');
  // #password, never getByLabel('Password'): the redesigned form has both the
  // field and a "Forgot password?" control, so the accessible-name lookup is
  // ambiguous and trips Playwright's strict mode.
  const passwordField = page.locator('#password');
  await typeInto(emailField, email);
  await typeInto(passwordField, password);
  // Both values must survive to the submit. Asserted rather than assumed: with
  // fill() in webkit they did not, and an empty submit fails at the redirect
  // barrier below looking exactly like broken auth.
  await expect(emailField).toHaveValue(email);
  await expect(passwordField).toHaveValue(password);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
  await clearMfaChallenge(page);
}

/**
 * Step an enrolled admin/manager session up to aal2.
 *
 * Sprint 8 STEP 8 put a TOTP challenge in front of the portal: a password login
 * is aal1, and the middleware bounces privileged aal1 sessions to
 * /mfa-challenge (src/middleware.ts, guard (e)). Every admin spec written before
 * that gate — attendance, tasks, shoot-planner, content-* — signed in, landed on
 * /mfa-challenge, and then timed out hunting for grid controls on a page that
 * was never the portal. `login()` only waited for "not /login", so the challenge
 * page counted as a successful sign-in and the real failure surfaced 30 seconds
 * later as a missing button.
 *
 * Rather than teach each spec about MFA, the barrier lives here: the code is
 * computed from TEST_ADMIN_TOTP_SECRET exactly as an authenticator app would.
 * Non-privileged roles never see the challenge, so this is a no-op for them.
 */
export async function clearMfaChallenge(page: Page): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/mfa-challenge')) return;

  const secret = process.env.TEST_ADMIN_TOTP_SECRET;
  if (!secret) {
    throw new Error(
      'Signed-in user was sent to /mfa-challenge but TEST_ADMIN_TOTP_SECRET is not set. ' +
        'The E2E admin must be an account whose TOTP secret this suite owns.',
    );
  }

  // A code minted in the last moments of its 30s window can expire between the
  // fill and Supabase validating it. Rather than retry (a retry must wait out the
  // whole window for a genuinely new code, and a 30s sleep cannot fit inside a
  // 30s test timeout), step over the boundary BEFORE minting: if the current
  // window has under 3s left, wait it out so the code we submit is always fresh.
  const remainingMs = 30_000 - (Date.now() % 30_000);
  if (remainingMs < 3_000) await page.waitForTimeout(remainingMs + 500);

  // The page auto-submits on the 6th digit — no submit button to click.
  await page.getByLabel('6-digit verification code').fill(totp(secret));
  await page.waitForURL((u) => !u.pathname.startsWith('/mfa-challenge'), { timeout: 15_000 });
}

/**
 * The Bearer header the browser sends, captured from a real /v1 call.
 *
 * waitForRequest only observes requests made AFTER it starts waiting, so calling
 * this once a page has settled waits forever. Pass the navigation that will
 * trigger the request; it is started after the listener is armed.
 */
export async function captureApiToken(
  page: Page,
  navigate: () => Promise<unknown> = () => page.reload(),
): Promise<string> {
  const pending = page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  await navigate();
  const req = await pending;
  return req.headers()['authorization']!;
}

/** Assert the caller is authenticated enough to have left the login page. */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/login/);
}
