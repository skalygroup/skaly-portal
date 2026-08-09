import { expect, test } from '@playwright/test';

import { authHeaders, login } from './helpers/auth';
import { withDb } from './helpers/db';

import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

/**
 * ⭐ The month-boundary journey, end to end (Sprint 13 STEP 9, ADR-035/036/037).
 *
 * ── WHICH ENTRY POINT, AND WHY ──────────────────────────────────────────────
 * ADR-037 §4 is "two entry points, ONE idempotent core": the cron authenticates
 * with X-Internal-Secret, an admin with a session, and both land in the same
 * `RolloverService.run`. This suite drives the ADMIN one throughout — it needs no
 * new secret in .env.e2e, and it is the path a real person takes when they click
 * [Manual rollover] at 08:00 after a failed night. The secret path's own gate
 * (401 on a wrong secret, timing-safe) is asserted at the route layer in
 * apps/api/test/routes/internal.test.ts, where a bad secret can be tried a
 * hundred times without a browser.
 *
 * ── WHICH PERIOD ────────────────────────────────────────────────────────────
 * A far-future period, never `currentIstPeriod()`. Rolling over the live month
 * against the shared dev database would generate real rows for every seeded
 * client and every other suite's fixtures, and the damage would surface as
 * unrelated failures somewhere else in the run. Teardown removes everything this
 * spec created, keyed on that period alone.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const API = process.env.NEXT_PUBLIC_API_URL?.replace(/\/v1$/, '') ?? 'http://localhost:3001';
const ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

/** Far from the live month AND from every other suite's fixture periods. */
const PERIOD = '2087-03';

async function resetPeriod(): Promise<void> {
  await withDb(async (c) => {
    await c.query("DELETE FROM notifications WHERE payload->>'period' = $1", [PERIOD]);
    await c.query(
      "DELETE FROM audit_log WHERE table_name = 'months' AND new_value->>'period' = $1",
      [PERIOD],
    );
    for (const t of ['content_calendar', 'shoot_schedules', 'content_pipelines', 'attendance_logs']) {
      await c.query(`DELETE FROM ${t} WHERE period = $1`, [PERIOD]);
    }
    await c.query('DELETE FROM months WHERE period = $1', [PERIOD]);
  });
}

async function countRows(table: string): Promise<number> {
  const { rows } = await withDb((c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE period = $1`, [PERIOD]),
  );
  return Number(rows[0]?.n ?? 0);
}

async function notificationCount(type: string): Promise<number> {
  const { rows } = await withDb((c) =>
    c.query<{ n: string }>(
      "SELECT count(*) AS n FROM notifications WHERE type = $1 AND payload->>'period' = $2",
      [type, PERIOD],
    ),
  );
  return Number(rows[0]?.n ?? 0);
}

/** The one call under test, via the admin-session entry point. */
async function runRollover(
  request: APIRequestContext,
  context: BrowserContext,
): Promise<{ status: number; body: { data?: { status?: string; viewsRefreshed?: boolean } } }> {
  const res = await request.post(`${API}/v1/internal/rollover?period=${PERIOD}`, {
    headers: await authHeaders(context),
  });
  return { status: res.status(), body: (await res.json()) as never };
}


test.describe('the month boundary', () => {
  test.skip(!ENABLED, 'needs TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL');

  test.beforeEach(resetPeriod);
  test.afterAll(resetPeriod);

  test('⭐ a successful rollover provisions every module and notifies everyone', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const { status, body } = await runRollover(request, context);

    expect(status, 'the admin entry point is a real 200, not a 401').toBe(200);
    expect(body.data?.status).toBe('completed');
    expect(body.data?.viewsRefreshed, 'Tier 2 refreshed CONCURRENTLY').toBe(true);

    // Every module's rows exist for the new period — the thing a staff member
    // actually notices on the 1st.
    expect(await countRows('attendance_logs')).toBeGreaterThan(0);
    expect(await countRows('content_pipelines')).toBeGreaterThan(0);
    expect(await countRows('shoot_schedules')).toBeGreaterThan(0);
    expect(await countRows('content_calendar')).toBeGreaterThan(0);

    // Both tiers marked, in the row that is also the idempotency key.
    const { rows } = await withDb((c) =>
      c.query<{ rollover_completed_at: Date | null; view_refreshed_at: Date | null }>(
        'SELECT rollover_completed_at, view_refreshed_at FROM months WHERE period = $1',
        [PERIOD],
      ),
    );
    expect(rows[0]?.rollover_completed_at).not.toBeNull();
    expect(rows[0]?.view_refreshed_at).not.toBeNull();

    // month_ready to all staff, rollover_success to admins only.
    expect(await notificationCount('month_ready')).toBeGreaterThan(0);
    expect(await notificationCount('rollover_success')).toBeGreaterThan(0);

    await context.close();
  });

  test('⭐ triggering it twice creates the rows ONCE and fires month_ready ONCE', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    await login(await context.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD);

    const first = await runRollover(request, context);
    const afterFirst = {
      attendance: await countRows('attendance_logs'),
      calendar: await countRows('content_calendar'),
      ready: await notificationCount('month_ready'),
    };

    const second = await runRollover(request, context);

    expect(first.body.data?.status).toBe('completed');
    // The cron fires DAILY and retries 3× on failure, so this branch is the one
    // taken on ~29 nights out of 30. It has to be free and it has to be silent.
    expect(second.body.data?.status).toBe('already_completed');
    expect(second.status).toBe(200);

    expect(await countRows('attendance_logs')).toBe(afterFirst.attendance);
    expect(await countRows('content_calendar')).toBe(afterFirst.calendar);
    expect(await notificationCount('month_ready'), 'no second announcement').toBe(afterFirst.ready);

    await context.close();
  });

  test('⭐ a retry after a partial run resumes Tier 2 only', async ({ browser, request }) => {
    const context = await browser.newContext();
    await login(await context.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD);

    await runRollover(request, context);
    // Simulate the state a Tier 2 failure leaves behind: Tier 1 committed, the
    // refresh did not. This is what the cron's next retry actually finds, and the
    // whole point of ADR-037 §2 is that it resumes rather than re-runs.
    await withDb((c) =>
      c.query(
        "UPDATE months SET view_refreshed_at = NULL, rollover_failed_step = 'view_refresh' WHERE period = $1",
        [PERIOD],
      ),
    );
    const before = {
      attendance: await countRows('attendance_logs'),
      ready: await notificationCount('month_ready'),
    };

    const retry = await runRollover(request, context);

    expect(retry.body.data?.status).toBe('resumed');
    expect(retry.body.data?.viewsRefreshed).toBe(true);
    expect(await countRows('attendance_logs'), 'Tier 1 was NOT re-run').toBe(before.attendance);
    expect(await notificationCount('month_ready'), 'no duplicate announcement').toBe(before.ready);

    const { rows } = await withDb((c) =>
      c.query<{ rollover_failed_step: string | null }>(
        'SELECT rollover_failed_step FROM months WHERE period = $1',
        [PERIOD],
      ),
    );
    expect(rows[0]?.rollover_failed_step, 'cleared on recovery').toBeNull();

    await context.close();
  });

  test('the new month reaches an ordinary staff member’s bell, not just an admin’s', async ({
    browser,
    request,
  }) => {
    const adminCtx = await browser.newContext();
    await login(await adminCtx.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD);
    await runRollover(request, adminCtx);
    await adminCtx.close();

    const memberCtx = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    await login(memberPage, MEMBER_EMAIL, MEMBER_PASSWORD);
    await memberPage.goto('/attendance');

    // Fetched, not pushed: the member was not connected when the rollover ran, so
    // this asserts the DURABLE half of the delivery — which is the half that
    // matters at 00:01, when nobody has a tab open.
    await memberPage.getByRole('button', { name: /Notifications/ }).click();
    await expect(memberPage.getByText(/is ready/i).first()).toBeVisible({ timeout: 10_000 });

    // rollover_success is admin-only — a team member must not see it.
    await expect(memberPage.getByText('Rollover completed')).toHaveCount(0);

    await memberCtx.close();
  });

  test('⭐ [Manual rollover] on a failure notification completes the month', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Seed the exact row a failed 00:01 leaves in an admin's bell: the TEMPLATED
    // body (ADR-036 §2 — no assumption the AI summary arrived) plus the inline
    // action. Prose is deliberately not asserted anywhere in this file; the
    // summary is model output and pinning it would make the suite fail on a
    // rewording that harmed nobody.
    const { rows } = await withDb((c) =>
      c.query<{ id: string }>(
        `INSERT INTO notifications (staff_id, type, title, message, payload, is_read)
         SELECT id, 'rollover_failed', 'Rollover failed',
                $2, $3::jsonb, false
         FROM staff WHERE email = $1 RETURNING id`,
        [
          ADMIN_EMAIL,
          `Rollover for ${PERIOD} failed at step audit. The previous month is intact — data was not affected. A detailed summary is being generated.`,
          JSON.stringify({ period: PERIOD, failedStep: 'audit', action: 'manual_rollover' }),
        ],
      ),
    );
    expect(rows.length, 'the admin fixture must exist').toBeGreaterThan(0);

    await page.goto('/attendance');
    await page.getByRole('button', { name: /Notifications/ }).click();

    const card = page.getByText(/The previous month is intact/);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const action = page.getByTestId('manual-rollover').first();
    await expect(action).toBeVisible();
    await action.click();

    // It hits the SAME idempotent endpoint the cron does — so success here is the
    // real month being created, not a UI state change.
    await expect(page.getByText(/Rollover completed for/)).toBeVisible({ timeout: 20_000 });
    expect(await countRows('content_pipelines')).toBeGreaterThan(0);

    await context.close();
    void request;
  });

  test('the portal stays fully usable while a rollover runs (NFR §3.1)', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/attendance');

    // Fire the rollover and load a module AT THE SAME TIME. Tier 2's CONCURRENTLY
    // is what makes this pass — a plain REFRESH takes ACCESS EXCLUSIVE and the
    // dashboard read would block behind it for the refresh's duration.
    const [rollover] = await Promise.all([
      runRollover(request, context),
      page.goto('/dashboard'),
    ]);

    expect(rollover.body.data?.status).toBe('completed');
    await expect(page.locator('body')).toBeVisible();
    // Still navigable afterwards — nothing was left holding a lock.
    await page.goto('/tasks');
    await expect(page.locator('body')).toBeVisible();

    await context.close();
  });
});
