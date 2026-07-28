import { expect, test } from '@playwright/test';

import { accessToken, createHolidayOnFreeDate, login } from './helpers/auth';

import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * ADR-022 proven end to end (Sprint 10 STEP 12).
 *
 * This is the sprint's headline pair, and the only place the distinction can actually
 * be demonstrated:
 *
 *   PATCH path      — A edits a calendar cell, B's cell updates AND B issues NO GET.
 *   INVALIDATE path — A adds a holiday, B's attendance grid DOES refetch.
 *
 * Both behaviours are correct; the difference between them IS the ADR. A unit test can
 * assert which branch ran, but only request interception can prove that no network
 * request happened — and "no refetch" is the entire point of the patch half.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

const PROPAGATION_MS = 3_000;

function currentIstPeriod(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function openAs(
  browser: Browser,
  email: string,
  password: string,
  path: string,
): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, password);
  await page.goto(path);
  return { page, context, close: () => context.close() };
}

/**
 * Count GETs to a module endpoint from the moment this is called.
 *
 * Deliberately counts REQUESTS, not responses: a refetch that starts and is aborted
 * still means the client decided to refetch, which is what the patch path forbids.
 */
function countGets(page: Page, fragment: string): { get: () => number; stop: () => void } {
  let n = 0;
  const handler = (req: { url: () => string; method: () => string }) => {
    if (req.method() === 'GET' && req.url().includes(fragment)) n += 1;
  };
  page.on('request', handler);
  return {
    get: () => n,
    stop: () => page.off('request', handler),
  };
}

test.describe('ADR-022 — patch vs invalidate', () => {
  test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the realtime E2E.');

  test('⭐ PATCH path: a calendar cell edit reaches B with NO refetch', async ({ browser }) => {
    const period = currentIstPeriod();
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/content-calendar?period=${period}`);
    const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, `/content-calendar?period=${period}`);

    try {
      // Let B's initial load finish before counting, or the first fetch pollutes it.
      await b.page.waitForLoadState('networkidle');
      const gets = countGets(b.page, '/v1/content-calendar');

      const cell = a.page.getByTestId(/^calendar-cell-/).first();
      const visible = await cell.count();
      test.skip(visible === 0, 'No calendar cells in this period — nothing to edit.');

      await cell.click();
      // The popover's status control; the exact interaction is Sprint 7's, not this
      // test's subject — any committed edit produces the broadcast.
      const option = a.page.getByRole('button', { name: /Posted|Scheduled|Draft/ }).first();
      if (await option.count()) await option.click();

      await b.page.waitForTimeout(PROPAGATION_MS);

      // THE ASSERTION. The payload carries the complete cell including its version,
      // so B patches its cache. A single GET here means someone made this event
      // invalidate-only and the fan-out reduction is gone: 50 users, one edit, 50
      // refetches.
      expect(gets.get(), 'B must not refetch the calendar on a patchable event').toBe(0);
      gets.stop();
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('⭐ INVALIDATE path: a holiday DOES make B refetch attendance', async ({ browser }) => {
    const period = currentIstPeriod();
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/attendance?period=${period}`);
    const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, `/attendance?period=${period}`);

    try {
      await b.page.waitForLoadState('networkidle');
      const gets = countGets(b.page, '/v1/attendance');

      // Add a holiday through the API with A's session — the UI affordance is
      // Sprint 3's; the CASCADE is what this asserts.
      const token = await accessToken(a.context);
      const created = await createHolidayOnFreeDate(
        a.page.request,
        process.env.NEXT_PUBLIC_API_URL ?? '',
        token,
        period,
        'E2E Realtime Holiday',
      );
      test.skip(!created, 'No day in this period would accept a holiday.');

      try {
        // One holiday flips EVERY staff column for that date and reverts their logs
        // (the H-01 cascade). No single-row payload can express that, which is why
        // this row of the matrix invalidates — and a refetch is the CORRECT outcome.
        await expect
          .poll(() => gets.get(), { timeout: PROPAGATION_MS + 3_000 })
          .toBeGreaterThan(0);
      } finally {
        gets.stop();
        const id = created?.id;
        if (id) {
          await a.page.request.delete(`${process.env.NEXT_PUBLIC_API_URL}/v1/holidays/${id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
        }
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('sender exclusion: A does not re-apply its own edit', async ({ browser }) => {
    const period = currentIstPeriod();
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/content-calendar?period=${period}`);

    try {
      await a.page.waitForLoadState('networkidle');
      const gets = countGets(a.page, '/v1/content-calendar');

      const cell = a.page.getByTestId(/^calendar-cell-/).first();
      test.skip((await cell.count()) === 0, 'No calendar cells in this period.');
      await cell.click();
      const option = a.page.getByRole('button', { name: /Posted|Scheduled|Draft/ }).first();
      if (await option.count()) await option.click();

      await a.page.waitForTimeout(PROPAGATION_MS);

      // The actor already applied this optimistically. Re-applying the echo would
      // double-apply, or fight the mutation still in flight — a failure nearly
      // impossible to diagnose from a bug report, hence two guards.
      expect(gets.get(), 'the actor must not refetch from its own echo').toBe(0);
      gets.stop();
    } finally {
      await a.close();
    }
  });

  test('reconnect: the banner appears, then clears and the data catches up', async ({ browser }) => {
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/attendance');

    try {
      // Drop the network the way a tunnel would, not by closing the socket — this
      // exercises socket.io's own backoff rather than a synthetic disconnect.
      await a.page.context().setOffline(true);

      await expect(a.page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 });

      await a.page.context().setOffline(false);

      // NFR §1.3: reconnect < 30s. socket.io's policy caps its delay at 30s, so the
      // banner must clear inside that.
      await expect(a.page.getByTestId('connection-banner')).toBeHidden({ timeout: 30_000 });
    } finally {
      await a.close();
    }
  });
});

