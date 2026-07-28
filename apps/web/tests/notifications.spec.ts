import { expect, test } from '@playwright/test';

import { accessToken, createHolidayOnFreeDate, login } from './helpers/auth';

import type { Browser } from '@playwright/test';

/**
 * The notification bell, live (Sprint 10 STEP 12).
 *
 * The cross-tab assertion is the one worth having: [Mark all read] must clear the
 * badge in BOTH of B's tabs. Two tabs in ONE context here, deliberately — the same
 * signed-in user with two windows open is exactly the scenario `notify:read` exists
 * for, and separate contexts would be two different people instead.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

const DELIVERY_MS = 3_000;

function currentIstPeriod(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}


async function openAs(browser: Browser, email: string, password: string, path = '/attendance') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, password);
  await page.goto(path);
  // Tolerant close: opening a second page in the same context can race Playwright own
  // fixture teardown, and a disposal error there would fail a test whose assertions all
  // passed — a red result that says nothing about the product.
  return { context, page, close: async () => { try { await context.close(); } catch { /* already disposed */ } } };
}

test.describe('notifications — live bell', () => {
  test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the notifications E2E.');

  test('⭐ a mention reaches B\'s bell live, without a reload', async ({ browser }) => {
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/chat');
    const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, '/attendance');

    try {
      // Clear B's bell so the assertion is about THIS notification.
      const bToken = await accessToken(b.context);
      await b.page.request.put(`${process.env.NEXT_PUBLIC_API_URL}/v1/notifications/read-all`, {
        headers: { authorization: `Bearer ${bToken}` },
      });
      await b.page.reload();

      // B's display name, so the mention actually resolves server-side.
      const meRes = await b.page.request.get(`${process.env.NEXT_PUBLIC_API_URL}/v1/staff/me`, {
        headers: { authorization: `Bearer ${bToken}` },
      });
      const me = (await meRes.json()) as { name?: string };
      test.skip(!me.name, 'Could not resolve the member display name.');

      const composer = a.page.getByTestId('chat-composer');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await composer.click();
      await composer.fill(`E2E-NOTIF @${me.name} please look`);
      await composer.press('Enter');

      // The badge increments from the notify:new payload — no refetch, no reload.
      await expect(b.page.getByTestId('notification-badge')).toBeVisible({ timeout: DELIVERY_MS });
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('⭐ [Mark all read] clears the badge in BOTH of B\'s tabs', async ({ browser }) => {
    // Two logins plus a second tab. login() alone costs ~15s (helpers/auth.ts, and the
    // STEP 1.2 budget note), so this does not fit the 60s global — it is heavy, not slow.
    test.setTimeout(150_000);

    // Both land on /attendance, and the notification is triggered by ONE API call
    // rather than a chat mention. The mention path is already proven by the test above;
    // repeating it here only added a chat page load and a server-side name resolution
    // to a test that is about notify:read reaching a SECOND TAB. Trimming it is what
    // brought this inside its budget.
    const admin = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/attendance');
    const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, '/attendance');
    const period = currentIstPeriod();
    let holidayId: string | null = null;

    try {
      // Start from a known-empty bell so the badge assertions are about THIS event.
      const bToken = await accessToken(b.context);
      await b.page.request.put(`${process.env.NEXT_PUBLIC_API_URL}/v1/notifications/read-all`, {
        headers: { authorization: `Bearer ${bToken}` },
      });
      await b.page.reload();

      // A SECOND tab for the same user — same context, so the same session. This is
      // exactly the scenario notify:read exists for.
      const tab2 = await b.context.newPage();
      await tab2.goto('/attendance');

      const aToken = await accessToken(admin.context);
      const created = await createHolidayOnFreeDate(
        admin.page.request,
        process.env.NEXT_PUBLIC_API_URL ?? '',
        aToken,
        period,
        'E2E Cross-tab Holiday',
      );
      test.skip(!created, 'No day in this period would accept a holiday.');
      holidayId = created?.id ?? null;

      await expect(b.page.getByTestId('notification-badge')).toBeVisible({ timeout: DELIVERY_MS });
      await expect(tab2.getByTestId('notification-badge')).toBeVisible({ timeout: DELIVERY_MS });

      // Mark read in tab 1 …
      await b.page.getByRole('button', { name: /Notifications/ }).click();
      await b.page.getByRole('button', { name: 'Mark all read' }).click();

      // … and tab 2 must agree, via notify:read carrying the ids. Without that echo
      // the second tab keeps a badge for notifications that are already read.
      await expect(tab2.getByTestId('notification-badge')).toBeHidden({ timeout: DELIVERY_MS });
      await expect(b.page.getByTestId('notification-badge')).toBeHidden({ timeout: DELIVERY_MS });
    } finally {
      if (holidayId) {
        await admin.page.request
          .delete(`${process.env.NEXT_PUBLIC_API_URL}/v1/holidays/${holidayId}`, {
            headers: { authorization: `Bearer ${await accessToken(admin.context)}` },
          })
          .catch(() => undefined);
      }
      await admin.close();
      await b.close();
    }
  });

  test('a holiday notifies everyone except the actor', async ({ browser }) => {
    const period = currentIstPeriod();
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/attendance?period=${period}`);
    const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, '/attendance');

    try {
      const bToken = await accessToken(b.context);
      await b.page.request.put(`${process.env.NEXT_PUBLIC_API_URL}/v1/notifications/read-all`, {
        headers: { authorization: `Bearer ${bToken}` },
      });
      await b.page.reload();

      const aToken = await accessToken(a.context);
      // Clear the ACTOR bell as well. Asserting "A has no badge" is meaningless while
      // A still carries unread notifications from earlier tests in this file.
      await a.page.request.put(`${process.env.NEXT_PUBLIC_API_URL}/v1/notifications/read-all`, {
        headers: { authorization: `Bearer ${aToken}` },
      });
      await a.page.reload();

      const created = await createHolidayOnFreeDate(
        a.page.request,
        process.env.NEXT_PUBLIC_API_URL ?? '',
        aToken,
        period,
        'E2E Notify Holiday',
      );
      test.skip(!created, 'No day in this period would accept a holiday.');

      try {
        // holiday_added was one of Sprint 10's five gap producers — the service had
        // been broadcasting the socket event since Sprint 3 while writing no row.
        await expect(b.page.getByTestId('notification-badge')).toBeVisible({ timeout: DELIVERY_MS });
        // …and never to the actor (the ADR-006 non-actor rule, applied generally).
        await expect(a.page.getByTestId('notification-badge')).toBeHidden({ timeout: 2_000 });
      } finally {
        const id = created?.id;
        if (id) {
          await a.page.request.delete(`${process.env.NEXT_PUBLIC_API_URL}/v1/holidays/${id}`, {
            headers: { authorization: `Bearer ${aToken}` },
          });
        }
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
