import { expect, test } from '@playwright/test';

import { authHeaders, login } from './helpers/auth';
import { staffIdByEmail, withDb } from './helpers/db';

import type { Page } from '@playwright/test';

/**
 * Reports, end to end (Sprint 11 STEP 12 — ADR-027).
 *
 * Two properties live here and nowhere else:
 *
 *   1. A generate request returns immediately and the row settles on its own.
 *      The 202 is easy to assert anywhere; that the ROW moves without the user
 *      touching anything needs a real socket and a real render.
 *   2. ⭐ The API stays answerable WHILE a PDF renders. That is the entire point
 *      of moving @react-pdf/renderer onto a worker thread, and it is invisible
 *      to every unit test — a blocked event loop is only observable from
 *      outside the process.
 *
 * The FAILED half of `report_ready` is asserted in
 * apps/api/test/services/ReportService.test.ts, which can force a worker to
 * reply `{ ok: false }`. This spec cannot make a real render fail on demand, so
 * it asserts the property that covers both outcomes instead: the row LEAVES
 * pending on its own. A report stuck spinning forever is the failure mode that
 * ships green out of every happy-path test.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && process.env.DATABASE_URL);

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** A render is 10–15s by ADR-027's own numbers; give it room plus the upload. */
const SETTLE_MS = 60_000;

function currentIstPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
}

/**
 * Start an org report from the panel and return the id the API minted.
 *
 * The id comes off the 202's body rather than being scraped from the DOM — the
 * row is keyed by it (`data-testid="report-{id}"`), so having it up front is
 * what lets every assertion below target THIS report and not whichever one
 * happens to be at the top of the list.
 */
async function generateOrgReport(page: Page): Promise<string> {
  const accepted = page.waitForResponse(
    (r) => r.url().includes('/v1/reports/generate') && r.request().method() === 'POST',
  );

  await page.getByLabel('Report').selectOption('org_monthly');
  await page.getByLabel('Period').fill(currentIstPeriod());
  await page.getByRole('button', { name: 'Generate' }).click();

  const res = await accepted;
  // 202, not 200: the work is accepted, not done.
  expect(res.status()).toBe(202);
  const body = (await res.json()) as { data: { reportId: string; status: string } };
  expect(body.data.status).toBe('pending');
  return body.data.reportId;
}

async function deleteReport(id: string): Promise<void> {
  await withDb((c) => c.query('DELETE FROM reports WHERE id = $1', [id]));
}

test.describe('reports', () => {
  test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_* and DATABASE_URL to run the reports E2E.');
  // One render, one upload, one socket round trip per test.
  test.describe.configure({ timeout: 120_000 });

  test('⭐ generate → pending → ready without a reload → Download yields a PDF', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/reports');

    const reportId = await generateOrgReport(page);

    try {
      const row = page.getByTestId(`report-${reportId}`);
      await expect(row).toContainText('Generating');

      // NOTHING happens in the browser between here and the assertion. No
      // reload, no click, no navigation — if the socket event never arrives,
      // this row spins until the timeout, which is exactly the bug being ruled
      // out. (`staleTime` is 15s, so a refetch on focus could otherwise hide a
      // dead socket; the tab is never re-focused.)
      await expect(row).not.toContainText('Generating', { timeout: SETTLE_MS });
      await expect(row).toContainText('Ready');

      // ── Download ───────────────────────────────────────────────────────
      // The link is read off the panel's OWN request, not off the popup it
      // opens. `window.open` to a PDF leaves the new page on about:blank while
      // Chromium decides whether to render or download it, so `popup.url()` is
      // a race — fetching it hung until the test timed out, which reads as a
      // broken download and is really a test watching the wrong object.
      //
      // Intercepting `GET /v1/reports/:id` proves more anyway: the link is
      // presigned at CLICK time from `file_key`, and fetching it confirms the
      // whole chain — the key was written, the object is in R2, and the
      // signature is valid right now.
      const linkResponse = page.waitForResponse(
        (r) => r.url().includes(`/v1/reports/${reportId}`) && r.request().method() === 'GET',
      );
      await row.getByRole('button', { name: /Download/ }).click();
      const { data } = (await (await linkResponse).json()) as { data: { downloadUrl: string | null } };
      expect(data.downloadUrl, 'a ready report must presign a link on click').toBeTruthy();

      const fetched = await page.request.get(data.downloadUrl!);
      expect(fetched.headers()['content-type']).toContain('application/pdf');
      // A size floor, never exact bytes: the PDF embeds a generation timestamp,
      // so byte-equality would fail on every run for the right reason.
      expect((await fetched.body()).length).toBeGreaterThan(1000);

      // The link was never carried in the notification payload (audit M-08) —
      // a presigned URL dies in 24h and anything holding it outlives it.
      const notified = await withDb(async (c) => {
        const { rows } = await c.query<{ payload: unknown }>(
          `SELECT payload FROM notifications WHERE type = 'report_ready'
             AND payload->>'reportId' = $1`,
          [reportId],
        );
        return rows[0]?.payload;
      });
      expect(JSON.stringify(notified ?? {})).not.toContain('http');
    } finally {
      await deleteReport(reportId);
    }
  });

  /**
   * ⭐ ADR-027's whole point, asserted from the outside.
   *
   * `@react-pdf/renderer` renders SYNCHRONOUSLY. On the request event loop a
   * 10–15s render blocks every other request on the instance including
   * /v1/health — and INFRA §4 sets healthcheckTimeout to 30s, so a month-end
   * burst would not be a slow-report problem, it would be a restart loop.
   *
   * The probe deliberately uses `page.request`, which goes out on a connection
   * the browser is not using for anything else, and it is fired repeatedly for
   * the duration of the render rather than once — a single well-timed sample
   * could land in a gap between two blocking stretches and pass against a
   * genuinely blocked loop.
   */
  test('⭐ /v1/health stays under 500ms while a report renders', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/reports');

    const reportId = await generateOrgReport(page);

    try {
      const row = page.getByTestId(`report-${reportId}`);
      const auth = await authHeaders(page.context());
      const worst: number[] = [];

      // Wait for the row to exist before probing. The list refetches after the
      // 202, so for a moment there is no row — and `isVisible()` on a missing
      // element is `false`, which exits the loop on its first evaluation and
      // reports zero samples. A render that was never observed is not a render
      // that did not block.
      await expect(row).toContainText('Generating');

      // Probe until the report settles, so the samples cover the render rather
      // than a fixed window that might end before it starts. The deadline is
      // not belt-and-braces: without it a report that never settles spins here
      // until the whole test times out, and the failure names the timeout
      // instead of the thing that actually broke.
      const deadline = Date.now() + SETTLE_MS;
      while (await row.getByText('Generating').isVisible().catch(() => false)) {
        expect(Date.now(), 'the report never left pending — the push is dead').toBeLessThan(deadline);
        const started = Date.now();
        const res = await page.request.get(`${API}/v1/health`, { headers: auth });
        worst.push(Date.now() - started);
        expect(res.status()).toBe(200);
        await page.waitForTimeout(250);
      }

      expect(worst.length, 'the render finished before a single probe went out').toBeGreaterThan(2);
      expect(Math.max(...worst)).toBeLessThan(500);
    } finally {
      await deleteReport(reportId);
    }
  });

  /**
   * A failed report, deep-linked — the two halves of audit M-08 in one test.
   *
   * The row is SEEDED rather than rendered, on purpose. A real render cannot be
   * made to fail on demand, and this test is not about the worker: it is about
   * what the panel does with a `failed` row when a notification sends someone
   * straight to it. Seeding is what makes both assertions deterministic.
   *
   *   - `report_ready` links to `/settings/reports?reportId={id}` precisely so
   *     it does not carry a presigned URL that dies overnight. That only pays
   *     off if landing here SHOWS you the report you clicked for; otherwise the
   *     fix trades a leaked URL for a scavenger hunt.
   *   - A failed row must carry its reason and a way forward. "Failed" with no
   *     reason and no button is a dead end, and the worker already wrote
   *     `error_message` for exactly this.
   */
  test('a deep-linked failed report is highlighted, explains itself, and offers Retry', async ({
    page,
  }) => {
    const adminId = await staffIdByEmail(ADMIN_EMAIL);
    const reason = 'E2E seeded failure — no data for that period.';
    // Two rows, so "highlighted" always has a neighbour to be different FROM.
    // With one row the comparison silently degrades to no comparison at all.
    const [reportId, decoyId] = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO reports (period, type, generated_by, status, error_message)
         VALUES ($1, 'org_monthly', $2, 'failed', $3),
                ($1, 'org_monthly', $2, 'failed', 'E2E decoy')
         RETURNING id`,
        [currentIstPeriod(), adminId, reason],
      );
      return [rows[0]!.id, rows[1]!.id];
    });

    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`/settings/reports?reportId=${reportId}`);

      const row = page.getByTestId(`report-${reportId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Failed');
      await expect(row).toContainText(reason);
      await expect(row.getByRole('button', { name: /Retry/ })).toBeVisible();

      // The highlight, asserted as "different from the other rows" rather than
      // as a colour — pinning the token would fail on any theme change and say
      // nothing about whether the deep link worked.
      const backgrounds = await page
        .locator('tr[data-testid^="report-"]')
        .evaluateAll((rows) =>
          rows.map((el) => ({
            id: el.getAttribute('data-testid'),
            bg: getComputedStyle(el).backgroundColor,
          })),
        );
      const mine = backgrounds.find((r) => r.id === `report-${reportId}`);
      const others = backgrounds.filter((r) => r.id !== `report-${reportId}`);
      expect(mine).toBeDefined();
      expect(others.length).toBeGreaterThan(0);
      for (const other of others) expect(mine!.bg).not.toBe(other.bg);
    } finally {
      await deleteReport(reportId);
      await deleteReport(decoyId);
    }
  });
});
