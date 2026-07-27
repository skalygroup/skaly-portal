import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { login } from './helpers/auth';

/**
 * E2E smoke: Shoot Planner (Sprint 5 STEP 8) — lifecycle, freelancer isolation
 * (ADR-011 / M-07), reset gate.
 *
 * NOTE: the guide names this tests/e2e/shoot-planner.spec.ts, but the Playwright
 * config's testDir is ./tests (Sprint 1 convention), so it lives here — same as
 * tests/tasks.spec.ts. Config runs chromium; webkit is not wired in this repo.
 *
 * Needs a live web app + API + Supabase test project. Configure via env (same
 * as tasks.spec.ts, plus the freelancer login from STEP 8.1):
 *
 *   E2E_BASE_URL          web origin (default http://localhost:3000)
 *   NEXT_PUBLIC_API_URL   API origin (default http://localhost:3001)
 *   DATABASE_URL          API Postgres — seeds/restores slots, reads staff ids
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD            an admin
 *   TEST_FREELANCER_EMAIL / TEST_FREELANCER_PASSWORD  a freelancer (Sprint 1 invite)
 *
 * Without these the whole describe self-skips so the suite stays green until
 * the infra is wired (same pattern as tests/auth/login.spec.ts).
 *
 * Re-runnable: slots are borrowed from the current period's Unset pool and
 * restored to Unset (pieces back to the client default) in afterEach; the
 * second freelancer is a throwaway staff row (no auth user — never logs in)
 * deleted in afterEach; shoot_confirmed notifications for touched slots are
 * deleted.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const FREELANCER_EMAIL = process.env.TEST_FREELANCER_EMAIL ?? '';
const FREELANCER_PASSWORD = process.env.TEST_FREELANCER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && FREELANCER_PASSWORD && process.env.DATABASE_URL);

const OTHER_FREELANCER_EMAIL = 'e2e-other-freelancer@skaly.test';

/** Current IST month 'YYYY-MM' — matches the backend / useMonthContext. */
function currentIstPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date());
}
const PERIOD = currentIstPeriod();
const DATE = `${PERIOD}-15`;

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// login() comes from tests/helpers/auth — see the barrier note there.

/** The Bearer token the browser sends — captured from the first /v1 API call. */
async function captureApiToken(page: Page): Promise<string> {
  const req = await page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  return req.headers()['authorization']!;
}

interface SlotRef {
  id: string;
  clientId: string;
  clientName: string;
  slotIndex: number;
}

/** One Unset slot per distinct client for the current period, alphabetical. */
async function pickUnsetSlots(c: Client, count: number): Promise<SlotRef[]> {
  const { rows } = await c.query(
    `SELECT DISTINCT ON (s.client_id)
            s.id, s.client_id AS "clientId", cl.name AS "clientName", s.slot_index AS "slotIndex"
     FROM shoot_schedules s
     JOIN clients cl ON cl.id = s.client_id
     WHERE s.period = $1 AND s.slot_status = 'Unset'
       AND cl.active AND NOT cl.is_internal AND cl.deleted_at IS NULL
     ORDER BY s.client_id, s.slot_index`,
    [PERIOD],
  );
  return (rows as SlotRef[]).slice(0, count);
}

async function staffIdByEmail(c: Client, email: string): Promise<string | undefined> {
  const { rows } = await c.query(
    "SELECT id FROM staff WHERE email = $1 AND role = 'freelancer' AND deleted_at IS NULL",
    [email],
  );
  return rows[0]?.id as string | undefined;
}

// Slots this run mutated — restored to Unset in afterEach.
const touched: string[] = [];

async function cleanup() {
  await withDb(async (c) => {
    if (touched.length > 0) {
      await c.query(
        `DELETE FROM notifications WHERE type = 'shoot_confirmed' AND payload->>'slotId' = ANY($1)`,
        [touched],
      );
      await c.query(
        `UPDATE shoot_schedules s
         SET slot_status = 'Unset', slot_date = NULL, freelancer_id = NULL,
             pieces_expected = cl.pieces_per_visit, updated_at = now()
         FROM clients cl
         WHERE cl.id = s.client_id AND s.id = ANY($1::uuid[])`,
        [touched],
      );
      touched.length = 0;
    }
    // Throwaway second freelancer: null any references, then remove the row.
    await c.query(
      'UPDATE shoot_schedules SET freelancer_id = NULL WHERE freelancer_id IN (SELECT id FROM staff WHERE email = $1)',
      [OTHER_FREELANCER_EMAIL],
    );
    await c.query('DELETE FROM staff WHERE email = $1', [OTHER_FREELANCER_EMAIL]);
  });
}

test.describe('shoot planner — live smoke', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_FREELANCER_* and DATABASE_URL to run the shoot-planner smoke.');
  });
  test.afterEach(async () => {
    if (FLOW_ENABLED) await cleanup();
  });

  test('lifecycle: schedule → confirm (toast) → reset back to Unset', async ({ page }) => {
    const { slot, freelancerId } = await withDb(async (c) => {
      const [slot] = await pickUnsetSlots(c, 1);
      const freelancerId = await staffIdByEmail(c, FREELANCER_EMAIL);
      return { slot, freelancerId };
    });
    // Skip messages: no Unset slot in the period, or STEP 8.1 (Sprint 1 invite) not done.
    if (!slot || !freelancerId) return test.skip();
    touched.push(slot.id);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/shoot-planner?period=${PERIOD}`);

    const cell = page.getByTestId(`slot-cell-${slot.clientId}-${slot.slotIndex}`);
    await expect(cell.getByTestId('slot-unset')).toBeVisible();

    // Unset → Scheduled: date + pieces + freelancer via the popover.
    await cell.click();
    const popover = page.getByTestId('slot-popover');
    await expect(popover).toBeVisible();
    // Pick the freelancer FIRST — it is the only step that waits for a network
    // response, and everything typed before it is lost.
    //
    // The staff query is `enabled: canEdit`, so it cannot start until /staff/me and
    // /months resolve. It lands ~400ms after the grid paints, hands the popover a new
    // `freelancers` prop, and remounts it — and the popover seeds its draft from props
    // with useState, so a date filled before that point is silently reset to "" and
    // the Schedule button goes back to disabled. Measured: value present at +200ms,
    // gone at +500ms.
    //
    // selectOption blocks until the options exist, so ordering it first means the
    // remount has already happened by the time anything is typed. This is also what a
    // person does — they wait for the form to finish loading.
    await popover.getByTestId('slot-freelancer').selectOption(freelancerId!);
    await popover.getByTestId('slot-date').fill(DATE);
    await popover.getByRole('button', { name: 'More pieces' }).click();
    await expect(popover.getByTestId('slot-cta')).toBeEnabled();
    await popover.getByTestId('slot-cta').click(); // "Schedule"
    await expect(cell.getByTestId('slot-scheduled')).toBeVisible();

    // Scheduled → Confirmed: chip flips + the Content Dropper toast fires.
    await cell.click();
    await expect(page.getByTestId('slot-popover')).toBeVisible();
    await page.getByTestId('slot-popover').getByTestId('slot-cta').click(); // "Confirm"
    await expect(page.getByText('Shoot confirmed. Content Dropper updated.')).toBeVisible();
    await expect(cell.getByTestId('slot-confirmed')).toBeVisible();

    // ⋯ → Reset → dialog → back to Unset with fields cleared.
    await page.getByTestId(`slot-menu-${slot.clientId}-${slot.slotIndex}`).click();
    await page.getByTestId('slot-reset').click();
    await expect(page.getByTestId('reset-dialog')).toBeVisible();
    await page.getByTestId('reset-confirm').click();
    await expect(cell.getByTestId('slot-unset')).toBeVisible();
    await expect(cell.getByText('Wk')).toHaveCount(0); // date cleared
  });

  test('freelancer isolation: own row only, read-only UI, PATCH 403, non-owned GET 404', async ({ page }) => {
    const seeded = await withDb(async (c) => {
      const [ownSlot, otherSlot] = await pickUnsetSlots(c, 2);
      const freelancerId = await staffIdByEmail(c, FREELANCER_EMAIL);
      if (!ownSlot || !otherSlot || !freelancerId) return null;
      const { rows } = await c.query(
        `INSERT INTO staff (name, email, role) VALUES ('E2E Other Freelancer', $1, 'freelancer')
         ON CONFLICT (email) DO UPDATE SET deleted_at = NULL, role = 'freelancer'
         RETURNING id`,
        [OTHER_FREELANCER_EMAIL],
      );
      const otherId = rows[0].id as string;
      // Assign one slot to each freelancer directly — deterministic setup.
      await c.query(
        `UPDATE shoot_schedules SET slot_status = 'Scheduled', slot_date = $2, freelancer_id = $3 WHERE id = $1`,
        [ownSlot.id, DATE, freelancerId],
      );
      await c.query(
        `UPDATE shoot_schedules SET slot_status = 'Scheduled', slot_date = $2, freelancer_id = $3 WHERE id = $1`,
        [otherSlot.id, DATE, otherId],
      );
      return { own: ownSlot, other: otherSlot };
    });
    // Skip message: needs 2 clients with Unset slots and the STEP 8.1 freelancer login.
    if (!seeded) return test.skip();
    const { own, other } = seeded;
    touched.push(own.id, other.id);

    await login(page, FREELANCER_EMAIL, FREELANCER_PASSWORD);
    const tokenPromise = captureApiToken(page);
    await page.goto(`/shoot-planner?period=${PERIOD}`);
    const token = await tokenPromise;

    // Own row visible; the other freelancer's client row absent (ADR-011).
    await expect(page.getByRole('grid')).toBeVisible();
    await expect(page.getByText(own.clientName)).toBeVisible();
    await expect(page.getByText(other.clientName)).toHaveCount(0);

    // Read-only: no clickable cell buttons, no ⋯ menu; clicking opens nothing.
    await expect(page.getByTestId(`slot-cell-${own.clientId}-${own.slotIndex}`)).toHaveCount(0);
    await expect(page.getByTestId(`slot-menu-${own.clientId}-${own.slotIndex}`)).toHaveCount(0);
    await page.getByTestId('slot-scheduled').first().click();
    await expect(page.getByTestId('slot-popover')).toHaveCount(0);

    // API is the real boundary: freelancer PATCH → 403 (even on the own slot).
    const patchRes = await page.request.patch(`${API_BASE}/v1/shoot-planner/${own.id}`, {
      headers: { authorization: token },
      data: { piecesExpected: 5 },
    });
    expect(patchRes.status()).toBe(403);

    // Non-owned slot GET → 404 (existence hidden), own slot GET → 200.
    const notOwned = await page.request.get(`${API_BASE}/v1/shoot-planner/${other.id}`, {
      headers: { authorization: token },
    });
    expect(notOwned.status()).toBe(404);
    const owned = await page.request.get(`${API_BASE}/v1/shoot-planner/${own.id}`, {
      headers: { authorization: token },
    });
    expect(owned.status()).toBe(200);
  });

  test('reset gate: POST reset without confirm → 400 SHOOT_RESET_CONFIRMATION_REQUIRED', async ({ page }) => {
    const [slot] = await withDb((c) => pickUnsetSlots(c, 1));
    if (!slot) return test.skip(); // no slot in the current period

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const tokenPromise = captureApiToken(page);
    await page.goto(`/shoot-planner?period=${PERIOD}`);
    const token = await tokenPromise;

    const res = await page.request.post(`${API_BASE}/v1/shoot-planner/${slot.id}/reset`, {
      headers: { authorization: token },
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SHOOT_RESET_CONFIRMATION_REQUIRED');
  });
});
