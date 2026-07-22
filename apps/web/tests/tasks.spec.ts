import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { login } from './helpers/auth';

/**
 * E2E smoke: Work Allocation / tasks (Sprint 4 STEP 8). Smoke depth only.
 *
 * NOTE: the guide names this tests/e2e/tasks.spec.ts, but the Playwright config's
 * testDir is ./tests (Sprint 1 convention), so it lives here — same as
 * tests/attendance.spec.ts. Config runs chromium; webkit is not wired in this repo.
 *
 * Needs a live web app + API + Supabase test project and seeded staff mirrored as
 * Supabase users. Configure via env (same as attendance.spec.ts):
 *
 *   E2E_BASE_URL          web origin (default http://localhost:3000)
 *   NEXT_PUBLIC_API_URL   API origin (default http://localhost:3001)
 *   DATABASE_URL          API Postgres — seeds/cleans tasks, reads staff ids
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD    an admin (MFA enrolled)
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD  a team_member (the seeded one)
 *
 * Without these the whole describe self-skips so the suite stays green until the
 * infra is wired (same pattern as tests/auth/login.spec.ts).
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

const MARK = 'E2E-TASK:'; // description prefix for everything this suite creates

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

async function staffIdByEmail(c: Client, email: string): Promise<string> {
  const { rows } = await c.query('SELECT id FROM staff WHERE email = $1 AND deleted_at IS NULL', [email]);
  return rows[0]?.id as string;
}

/** Insert a task directly (bypasses the create UI) for deterministic setup. */
async function seedTask(
  c: Client,
  opts: { desc: string; createdBy: string; status?: string; dependencyId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO tasks (id, period, date, description, status, dependency_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, PERIOD, DATE, `${MARK} ${opts.desc}`, opts.status ?? 'To Do', opts.dependencyId ?? null, opts.createdBy],
  );
  return id;
}

async function cleanup() {
  await withDb(async (c) => {
    await c.query(`UPDATE tasks SET dependency_id = NULL WHERE description LIKE $1`, [`${MARK}%`]);
    await c.query(`DELETE FROM tasks WHERE description LIKE $1`, [`${MARK}%`]); // cascades assignees + attachments
  });
}

// login() + captureApiToken() come from tests/helpers/auth — see the barrier
// note there; the local copies omitted it and raced every grid fetch.

/** The Bearer token the browser sends — captured from the first /v1 API call. */
async function captureApiToken(page: Page): Promise<string> {
  const req = await page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  return req.headers()['authorization']!;
}

/** Open the status dropdown for a task row and pick a status. */
async function setStatus(page: Page, rowText: string, from: string, to: string) {
  const row = page.getByRole('row').filter({ hasText: rowText });
  await row.getByRole('button', { name: from, exact: true }).click();
  await page.getByRole('listbox').getByRole('button', { name: to, exact: true }).click();
}

test.describe('tasks — live smoke', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the tasks smoke.');
  });
  test.afterEach(async () => {
    if (FLOW_ENABLED) await cleanup();
  });

  test('lifecycle: admin creates a task with an assignee, then transitions its status', async ({ page }) => {
    const desc = `${MARK} lifecycle ${Date.now()}`;
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/tasks?period=${PERIOD}`);

    await page.getByRole('button', { name: 'Add task' }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder('What needs doing?').fill(desc);
    await dialog.getByTestId('create-client').selectOption({ index: 1 }); // first real client
    await dialog.locator('button[aria-pressed]').first().click(); // add one assignee
    await dialog.getByTestId('create-deadline').fill(`${PERIOD}-20`);
    await dialog.getByRole('button', { name: 'Create task' }).click();

    const row = page.getByRole('row').filter({ hasText: desc });
    await expect(row).toBeVisible();
    // /\d+ assignee/, not /assignee/i: the latter also matches the "Edit
    // assignees" button in the same cell, and two matches is a strict-mode throw.
    await expect(row.getByLabel(/\d+ assignee/i)).toBeVisible(); // avatar stack rendered

    await setStatus(page, desc, 'To Do', 'In Progress');
    await expect(row.getByRole('button', { name: 'In Progress', exact: true })).toBeVisible();
  });

  test('dependency block: a task cannot go Done until its dependency is Done', async ({ page }) => {
    const { aId, aDesc, bDesc } = await withDb(async (c) => {
      const admin = await staffIdByEmail(c, ADMIN_EMAIL);
      const a = await seedTask(c, { desc: `dep-A ${Date.now()}`, createdBy: admin, status: 'In Progress' });
      await seedTask(c, { desc: `dep-B ${Date.now()}`, createdBy: admin, status: 'To Do', dependencyId: a });
      const { rows } = await c.query('SELECT id, description FROM tasks WHERE id = $1', [a]);
      return { aId: a, aDesc: rows[0].description as string, bDesc: (await c.query(`SELECT description FROM tasks WHERE dependency_id=$1`, [a])).rows[0].description as string };
    });

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/tasks?period=${PERIOD}`);

    // B is blocked (A is In Progress): the badge shows and Done is refused.
    const bRow = page.getByRole('row').filter({ hasText: bDesc });
    await expect(bRow.getByText(/Blocked by/i)).toBeVisible();
    await setStatus(page, bDesc, 'To Do', 'Done');
    await expect(bRow.getByRole('button', { name: 'To Do', exact: true })).toBeVisible(); // unchanged

    // Resolve A, then B can transition.
    await setStatus(page, aDesc, 'In Progress', 'Done');
    await expect(page.getByRole('row').filter({ hasText: aDesc }).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await setStatus(page, bDesc, 'To Do', 'Done');
    await expect(bRow.getByRole('button', { name: 'Done', exact: true })).toBeVisible();

    void aId;
  });

  test('ownership: team_member edits own assigned task, not an unassigned one (UI + API 403)', async ({ page }) => {
    const { ownDesc, unassignedId, ownId } = await withDb(async (c) => {
      const admin = await staffIdByEmail(c, ADMIN_EMAIL);
      const member = await staffIdByEmail(c, MEMBER_EMAIL);
      const own = await seedTask(c, { desc: `own ${Date.now()}`, createdBy: admin });
      const unassigned = await seedTask(c, { desc: `unassigned ${Date.now()}`, createdBy: admin });
      await c.query('INSERT INTO task_assignees (task_id, staff_id, assigned_by) VALUES ($1,$2,$3)', [own, member, admin]);
      const ownRow = (await c.query('SELECT description FROM tasks WHERE id=$1', [own])).rows[0];
      return { ownDesc: ownRow.description as string, unassignedId: unassigned, ownId: own };
    });

    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    const tokenPromise = captureApiToken(page);
    await page.goto(`/tasks?period=${PERIOD}`);
    const token = await tokenPromise;

    // Own assigned task: the status chip is an operable dropdown button.
    const ownRow = page.getByRole('row').filter({ hasText: ownDesc });
    await expect(ownRow.getByRole('button', { name: 'To Do', exact: true })).toBeEnabled();

    // Unassigned task: the status renders as a plain chip, not a button.
    const unRow = page.getByRole('row').filter({ hasText: 'unassigned' });
    await expect(unRow.getByRole('button', { name: 'To Do', exact: true })).toHaveCount(0);

    // API is the real boundary: status on an unassigned task → 403; a non-status
    // field (description) on the OWN task → 403.
    const res1 = await page.request.patch(`${API_BASE}/v1/tasks/${unassignedId}`, {
      headers: { authorization: token }, data: { status: 'Done' },
    });
    expect(res1.status()).toBe(403);
    const res2 = await page.request.patch(`${API_BASE}/v1/tasks/${ownId}`, {
      headers: { authorization: token }, data: { description: 'hacked' },
    });
    expect(res2.status()).toBe(403);
  });

  test('attachment: admin uploads, lists, and deletes a PDF', async ({ page }) => {
    const desc = await withDb(async (c) => {
      const admin = await staffIdByEmail(c, ADMIN_EMAIL);
      const id = await seedTask(c, { desc: `attach ${Date.now()}`, createdBy: admin });
      return (await c.query('SELECT description FROM tasks WHERE id=$1', [id])).rows[0].description as string;
    });

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/tasks?period=${PERIOD}`);

    const row = page.getByRole('row').filter({ hasText: desc });
    await row.getByRole('button', { name: 'Attachments' }).click();
    const panel = page.getByRole('dialog', { name: 'Attachments' });
    await expect(panel).toBeVisible();

    await panel.locator('input[type="file"]').setInputFiles({
      name: 'e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    });

    await expect(panel.getByText('e2e.pdf')).toBeVisible();
    await panel.getByRole('button', { name: 'Delete' }).first().click();
    await expect(panel.getByText('e2e.pdf')).toHaveCount(0);
  });
});
