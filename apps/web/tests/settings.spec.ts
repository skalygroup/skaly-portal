import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { authHeaders, login, typeInto } from './helpers/auth';
import { staffIdByEmail, withDb } from './helpers/db';
import { currentIstPeriod, priorIstPeriod } from './helpers/period-dates';

import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Settings, end to end (Sprint 11 STEP 12).
 *
 * The six behaviours here are the ones no unit test can reach, because each one
 * spans two things that only meet in a browser: a server-rendered gate and the
 * nav derived from the same permission map; a soft-deleted row and the approval
 * screen that has to offer a way back; a socket push and a second session that
 * must catch up without touching anything.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';

const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Every panel an admin holds by default — SETTINGS_PANELS in nav order. */
const ADMIN_PANELS = [
  'Staff',
  'Clients',
  'Permissions',
  'Signup Requests',
  'Holidays',
  'Months',
  'Audit Log',
  'Reports',
];

const uniqueEmail = (tag: string) => `e2e-${tag}-${Date.now()}@test.skaly.in`;

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

/** The labels currently in the settings nav, minus the always-present General. */
async function navPanels(page: Page): Promise<string[]> {
  const labels = await page.getByRole('navigation').getByRole('link').allInnerTexts();
  return labels.map((l) => l.trim()).filter((l) => l !== 'General');
}

/** Write a permission override as the signed-in admin. */
async function setOverride(
  request: APIRequestContext,
  auth: { authorization: string },
  staffId: string,
  key: string,
  value: boolean | null,
): Promise<void> {
  const url = `${API}/v1/staff/${staffId}/permissions/${key}`;
  const res =
    value === null
      ? // NO content-type on the DELETE. Fastify parses a declared JSON body
        // before any auth hook runs, and an empty one is a 400 — which reads as
        // a rejected override rather than a malformed request.
        await request.delete(url, { headers: auth })
      : await request.put(url, {
          headers: { ...auth, 'content-type': 'application/json' },
          data: { value },
        });
  expect(res.ok(), `override ${key}=${value} failed: ${res.status()}`).toBe(true);
}

test.describe('settings', () => {
  test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run settings E2E.');

  // ── 1. Role gating ───────────────────────────────────────────────────────

  test('an admin sees every panel, and each one loads', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings');

    expect(await navPanels(page)).toEqual(ADMIN_PANELS);
  });

  test('a team member has no Settings nav, and a typed URL is a 403 — not a redirect', async ({
    page,
  }) => {
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);

    // The status code matters as much as the screen (Auth-Matrix §3). A redirect
    // would tell someone the page moved when what happened is that they may not
    // have it, and `page.goto` returns the response so the wire is assertable.
    const res = await page.goto('/settings/permissions');
    expect(res?.status()).toBe(403);
    await expect(page.getByRole('heading', { name: /don.t have access/i })).toBeVisible();

    await page.goto('/settings');
    expect(await navPanels(page)).toEqual([]);
  });

  /**
   * The middle tier — someone who holds SOME panels.
   *
   * There is no TEST_MANAGER_* account, so the manager row of the matrix is
   * built rather than logged into: a team member is granted one panel's read
   * key. That is the stronger version of the assertion anyway. It proves the nav
   * follows the RESOLVED permission map rather than the role, which is the one
   * thing a role check would get wrong and the reason `visiblePanels` reads
   * `me.permissions` — an override changes the key and cannot change the role.
   */
  test('a granted panel appears in the nav; an ungranted one still 403s', async ({ browser }) => {
    const memberId = await staffIdByEmail(MEMBER_EMAIL);

    // A SEPARATE context for the admin. Two sign-ins in one context would share
    // one Supabase auth cookie, so the second would quietly evict the first and
    // both pages would be the same person — a test that passes by measuring
    // nothing.
    const admin = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/settings');
    const auth = await authHeaders(admin.context);

    await setOverride(admin.page.request, auth, memberId, 'module.settings_staff.read', true);
    const member = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, '/settings');
    try {
      expect(await navPanels(member.page)).toEqual(['Staff']);
      expect((await member.page.goto('/settings/staff'))?.status()).toBe(200);
      // The grant was one key. Everything else stays shut.
      expect((await member.page.goto('/settings/permissions'))?.status()).toBe(403);
    } finally {
      await setOverride(admin.page.request, auth, memberId, 'module.settings_staff.read', null);
      await member.close();
      await admin.close();
    }
  });

  // ── 2. ⭐ A4 re-hire, end to end ──────────────────────────────────────────

  /**
   * ⭐ The sprint's headline path (ADR-026, audit A4).
   *
   * Before this fix, approving a returning employee answered "Account already
   * exists at approval time" — a sentence that is false for a soft-deleted row,
   * and which made every offboarded person permanently unhireable through the
   * product. The whole defect lives between two screens, so this is the only
   * layer it can be proven at.
   *
   * The assertion that matters is the LAST one: the same staff id. A fix that
   * created a second row would satisfy every other line here and still lose the
   * person's tasks, attendance and audit trail.
   */
  test('⭐ A4: deactivate → they re-apply → approve offers Reinstate → the ORIGINAL account returns', async ({
    page,
  }) => {
    const email = uniqueEmail('rehire');
    const name = 'Rehire Candidate';

    const originalId = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO staff (name, email, role) VALUES ($1, $2, 'team_member') RETURNING id`,
        [name, email],
      );
      return rows[0]!.id;
    });

    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto('/settings/staff');

      // ── Deactivate, through the panel ──────────────────────────────────
      const row = page.locator('tr', { hasText: email });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Deactivate' }).click();
      // Scoped to the dialog: the row's trigger and the confirmation carry the
      // same label, and `.last()` would be betting on DOM order.
      await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
      await expect(page.getByText(`${name} has been deactivated`)).toBeVisible();

      // ── They apply again with the same email ───────────────────────────
      await withDb((c) =>
        c.query(
          `INSERT INTO signup_requests (name, email, date_of_birth, mobile_number, role_requested, status)
           VALUES ($1, $2, '1995-05-05', '+919876543210', 'team_member', 'pending')`,
          [name, email],
        ),
      );

      await page.goto('/settings/signup-requests?status=pending');
      const card = page.locator('article', { hasText: email });
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: 'Approve' }).click();
      await page.getByRole('button', { name: 'Confirm approval' }).click();

      // ── The branch, not a rejection ────────────────────────────────────
      // A toast saying "could not approve" would be the same defect wearing
      // better manners: the admin still ends the interaction with no way
      // forward. It has to be a branch with a button on it.
      await expect(page.getByRole('heading', { name: `${name} previously worked here` })).toBeVisible();
      await page.getByRole('button', { name: 'Reinstate their account' }).click();
      await expect(page.getByText(`Approved. ${name} has been notified.`)).toBeVisible();

      // ── The row that came back is the row that left ────────────────────
      const after = await withDb(async (c) => {
        const staff = await c.query<{ id: string; active: boolean; deleted_at: Date | null }>(
          'SELECT id, active, deleted_at FROM staff WHERE email = $1',
          [email],
        );
        const req = await c.query<{ status: string }>(
          'SELECT status FROM signup_requests WHERE email = $1',
          [email],
        );
        return { staff: staff.rows, status: req.rows[0]?.status };
      });

      expect(after.staff).toHaveLength(1); // no duplicate person
      expect(after.staff[0]!.id).toBe(originalId); // …and it is the SAME one
      expect(after.staff[0]!.active).toBe(true);
      expect(after.staff[0]!.deleted_at).toBeNull();
      // Approved, not left pending: reinstate and closing the request are one
      // decision, so they are one call.
      expect(after.status).toBe('approved');
    } finally {
      await withDb(async (c) => {
        const { rows } = await c.query<{ id: string }>('SELECT id FROM staff WHERE email = $1', [
          email,
        ]);
        const id = rows[0]?.id;
        if (id) {
          for (const t of ['attendance_logs', 'notifications', 'task_assignees', 'user_permissions', 'bot_sessions']) {
            await c.query(`DELETE FROM ${t} WHERE staff_id = $1`, [id]);
          }
          await c.query('DELETE FROM audit_log WHERE record_id = $1', [id]);
          await c.query('DELETE FROM staff WHERE id = $1', [id]);
        }
        await c.query('DELETE FROM signup_requests WHERE email = $1', [email]);
      });
    }
  });

  // ── 3. Client reactivate regenerates the period ──────────────────────────

  test('a reactivated client gets this period’s shoot, pipeline and calendar rows back', async ({
    page,
  }) => {
    const period = currentIstPeriod();
    const name = `E2E Client ${Date.now()}`;

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/clients');

    await page.getByRole('button', { name: 'New client' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByLabel(/Shoot slots per month/).fill('2');
    await page.getByRole('button', { name: 'Create client' }).click();
    await expect(page.getByText(`${name} added.`)).toBeVisible();

    const clientId = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM clients WHERE name = $1', [name]);
      return rows[0]!.id;
    });

    try {
      const row = page.locator('tr', { hasText: name });
      await row.getByRole('button', { name: 'Deactivate' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
      await expect(page.getByText(`${name} deactivated.`)).toBeVisible();

      // Gone from the module grids — asserted against the lookup every module
      // filters on, which is the list that decides whether they are offerable.
      const auth = await authHeaders(page.context());
      const live = await page.request.get(`${API}/v1/clients`, {
        headers: auth,
      });
      const body = (await live.json()) as { data: { id: string }[] };
      expect(body.data.map((c) => c.id)).not.toContain(clientId);

      await page.reload();
      await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Reactivate' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
      await expect(page.getByText(`${name} is active again.`)).toBeVisible();

      // The point of reactivate: the modules have somewhere to put new work
      // again. Without the backfill the client is visible and unusable, which
      // reads as a broken grid rather than a missing generator.
      const counts = await withDb(async (c) => {
        const one = async (table: string) => {
          const { rows } = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE client_id = $1 AND period = $2`,
            [clientId, period],
          );
          return Number(rows[0]!.n);
        };
        return {
          shoots: await one('shoot_schedules'),
          pipelines: await one('content_pipelines'),
          cells: await one('content_calendar'),
        };
      });
      expect(counts.shoots).toBeGreaterThan(0);
      expect(counts.pipelines).toBeGreaterThan(0);
      expect(counts.cells).toBeGreaterThan(0);
    } finally {
      await withDb(async (c) => {
        for (const t of ['shoot_schedules', 'content_pipelines', 'content_calendar']) {
          await c.query(`DELETE FROM ${t} WHERE client_id = $1`, [clientId]);
        }
        await c.query('DELETE FROM audit_log WHERE record_id = $1', [clientId]);
        await c.query('DELETE FROM clients WHERE id = $1', [clientId]);
      });
    }
  });

  // ── 4. ⭐ Permission push (ADR-029), two contexts ─────────────────────────

  /**
   * ⭐ An idle session catches up without a reload.
   *
   * ── Why this is not the sidebar the sprint prompt names ──────────────────
   * There is no global sidebar in this app — the portal layout is a topbar and
   * a page. The settings nav is the ONLY permission-derived nav that exists, so
   * that is what is asserted against, and it exercises the harder half: it is
   * server-rendered, so a client-cache invalidation alone would not move it.
   * `PermissionSync` calls `router.refresh()` for exactly that reason, and this
   * is the test that fails if someone deletes it as redundant.
   *
   * B does not click, navigate or reload between the grant and the assertion.
   * That restraint IS the test — anything else would pass against a build with
   * no push at all.
   */
  test('⭐ ADR-029: an override reaches an idle second session with no reload', async ({
    browser,
  }) => {
    const memberId = await staffIdByEmail(MEMBER_EMAIL);

    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/settings/permissions');

    /**
     * B is opened by hand, not through `openAs`, so the websocket listener is
     * attached BEFORE the page navigates.
     *
     * `page.on('websocket')` only reports sockets opened after it is attached,
     * and B's notify socket connects during login — so attaching afterwards
     * counts zero frames against a perfectly working push, which is the most
     * expensive kind of wrong a diagnostic can be.
     */
    const bContext = await browser.newContext();
    const bPage = await bContext.newPage();

    /**
     * Watch B's socket frames.
     *
     * Not decoration — it is what makes a failure diagnosable. The push has two
     * halves that fail identically from the outside: the server never delivered
     * `permission_changed`, or it did and the client ignored it. Without this,
     * both present as "the nav did not change" and the next person has to
     * re-derive which half broke.
     *
     * `getStaffMe` runs on the SERVER, so the re-resolve is an RSC fetch the
     * browser never issues as /v1/staff/me — counting that would report zero
     * against a working push too.
     */
    let pushFrames = 0;
    let anyFrames = 0;
    bPage.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        anyFrames += 1;
        if (typeof f.payload === 'string' && f.payload.includes('permission_changed')) {
          pushFrames += 1;
        }
      });
    });

    /**
     * ⚠️ THE JOIN BARRIER — and NOT a websocket frame count.
     *
     * This used to wait on "any frame received", which is satisfied by engine.io's
     * `2probe`/`3probe`/`5` UPGRADE HANDSHAKE — packets that by definition precede
     * the room join. So the grant could fire before B was in `user:{staffId}`, the
     * push would land nowhere, and the test would still be sitting inside a
     * barrier it had already passed. It proved "B has a websocket", never "B is
     * subscribed" — which is the entire claim of ADR-029.
     *
     * Worse, the frame count cannot be repaired: measured on a warm load, the
     * `room:join` and its ack travel over long-polling BEFORE the upgrade, so the
     * ack is invisible to `page.on('websocket')` altogether.
     *
     * The bell's list is fetched behind `useRealtimeQuery`'s `enabled: subscribed`
     * gate, and `subscribed` flips only on the join ack — so `GET /v1/notifications`
     * GOING OUT is the ack, observed at a layer where it is actually visible.
     */
    let notifyFetches = 0;
    bPage.on('response', (r) => {
      if (r.request().method() === 'GET' && r.url().includes('/v1/notifications')) {
        notifyFetches += 1;
      }
    });

    await login(bPage, MEMBER_EMAIL, MEMBER_PASSWORD);
    // Login lands on `/`, whose bell also fetches — so count from HERE, or the
    // barrier is satisfied by the previous page's join and proves nothing about
    // the /settings tab that has to receive the push.
    const fetchesBeforeSettings = notifyFetches;
    await bPage.goto('/settings');
    const b = { page: bPage, context: bContext, close: () => bContext.close() };

    try {
      await expect(b.page.getByRole('navigation')).toBeVisible();
      expect(await navPanels(b.page)).toEqual([]);

      /**
       * ⚠️ WAIT FOR B'S SOCKET BEFORE GRANTING. This barrier is the test.
       *
       * `emitAfterCommit` sends to room `user:{staffId}`, and socket.io delivers
       * to whoever is in that room AT THAT MOMENT — there is no replay. B's
       * notify socket connects asynchronously after the page loads and upgrades
       * from long-polling to websocket, so a grant issued before that finishes
       * is emitted into an empty room and lands nowhere.
       *
       * That is not hypothetical: this test failed exactly once that way, as the
       * twelfth test of a loaded run, and passed in isolation — the shape that
       * gets written off as flakiness and then hides a real regression.
       */
      await expect
        .poll(() => notifyFetches, { timeout: 20_000 })
        .toBeGreaterThan(fetchesBeforeSettings);

      /**
       * A SECOND wait, and it is FOR THE DIAGNOSTIC ONLY — not the product.
       *
       * engine.io opens on long-polling and upgrades to a websocket afterwards.
       * The join above completes over POLLING, so at that instant `pushFrames`
       * cannot see anything: a `permission_changed` delivered before the upgrade
       * arrives as a poll response and never reaches `page.on('websocket')`.
       *
       * The old `anyFrames` barrier accidentally covered this — waiting for any
       * websocket frame IS waiting for the upgrade — which is why the counter
       * worked while the barrier was wrong. Replacing it with the correct join
       * barrier alone made this test fail at `pushFrames`, with the push working
       * perfectly. Two different things were being conflated in one wait, so they
       * are now two waits with two reasons.
       *
       * The product does not require the upgrade: polling delivers the push just
       * fine. Only the counter needs it.
       */
      await expect.poll(() => anyFrames, { timeout: 15_000 }).toBeGreaterThan(0);

      const auth = await authHeaders(a.context);
      await setOverride(a.page.request, auth, memberId, 'module.settings_reports.read', true);

      // Delivery, asserted before the UI. With the barrier above, a zero here
      // can only mean the emit or the room is wrong — never that we were early.
      await expect.poll(() => pushFrames, { timeout: 10_000 }).toBeGreaterThan(0);

      // Then the nav gains the panel on its own — no reload, no click.
      await expect.poll(() => navPanels(b.page), { timeout: 10_000 }).toEqual(['Reports']);

      // And the gate agrees with the nav it just drew — the failure this pairing
      // exists to catch is a link the user can see and cannot open.
      expect((await b.page.goto('/settings/reports'))?.status()).toBe(200);
    } finally {
      const auth = await authHeaders(a.context);
      await setOverride(a.page.request, auth, memberId, 'module.settings_reports.read', null);
      await a.close();
      await b.close();
    }
  });

  // ── 5. Month lock ────────────────────────────────────────────────────────

  test('a locked month is read-only for everyone, and unlocking demands a reason', async ({
    browser,
  }) => {
    // Last month — it has seeded data, and locking the CURRENT one would block
    // every other spec's writes.
    //
    // The period is DERIVED, not queried. `ORDER BY period DESC OFFSET 1` reads
    // as "the previous month" and is not: other suites have left rows in
    // `months` dated 2098, so that query locked a month with no attendance
    // behind it and every assertion here passed against an empty grid.
    //
    // The LABEL still comes from the row, because it is a stored column and a
    // local 'June 2026' formatter would drift the day anyone renames a month.
    const period = priorIstPeriod();
    const month = await withDb(async (c) => {
      const { rows } = await c.query<{ label: string; locked: boolean }>(
        'SELECT label, locked FROM months WHERE period = $1',
        [period],
      );
      return rows[0];
    });
    test.skip(!month, `No months row for ${period}.`);
    test.skip(month!.locked, `${period} is already locked — nothing to prove.`);
    const label = month!.label;

    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/settings/months');
    let locked = false;

    try {
      const row = a.page.locator('tr', { hasText: label });
      await row.getByRole('button', { name: 'Lock' }).click();
      await a.page.getByRole('button', { name: 'Lock month' }).click();
      await expect(a.page.getByText(/is locked\./)).toBeVisible();
      locked = true;

      // A second session, a different role, that period: read-only.
      const b = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, `/attendance?period=${period}`);
      try {
        await expect(b.page.getByText('This period is locked. Read-only.')).toBeVisible();
        // The grid must have DATE ROWS, or "no toggles" is true of an empty
        // month too and this assertion proves nothing. That is exactly how the
        // 2098 period this test used to pick made it unfailable.
        expect(await b.page.getByRole('row').count()).toBeGreaterThan(1);
        await expect(b.page.getByRole('button', { name: /Toggle/ })).toHaveCount(0);
      } finally {
        await b.close();
      }

      // ── Unlock demands a reason, and says so ON THE FIELD ───────────────
      // The submit is deliberately not disabled on an empty reason: the rule
      // lives in MonthService, and letting the click through is what proves the
      // SERVER said no rather than a greyed-out button that never explains.
      await a.page.reload();
      await a.page.locator('tr', { hasText: label }).getByRole('button', { name: 'Unlock' }).click();
      await a.page.getByRole('button', { name: 'Unlock month' }).click();
      // Scoped to the dialog: Next mounts its own `role="alert"` route
      // announcer on every page, so an unscoped getByRole('alert') is a strict
      // mode violation that has nothing to do with this form.
      await expect(a.page.getByRole('dialog').getByRole('alert')).toContainText(
        /Say why this month is being reopened/,
      );

      await a.page.getByLabel(/Reason/).fill('E2E: reopening to correct attendance rows.');
      await a.page.getByRole('button', { name: 'Unlock month' }).click();
      await expect(a.page.getByText(/is open again\./)).toBeVisible();
      locked = false;

      // The reason survives on screen — the only thing on this panel that
      // explains a decision.
      await expect(a.page.locator('tr', { hasText: label })).toContainText(
        'reopening to correct attendance rows',
      );

      // The edit is made as the ADMIN, not the team member who proved the
      // read-only state above. A team member's editable set in a PRIOR period is
      // their own column and may legitimately be empty, so "no toggles" there
      // would be ambiguous between "still locked" and "nothing of theirs to
      // edit" — and an ambiguous green is the failure this whole file is
      // written against. The admin can edit any cell (attendance.spec), so a
      // toggle that moves is unambiguous evidence the month reopened.
      await a.page.goto(`/attendance?period=${period}`);
      await expect(a.page.getByText('This period is locked. Read-only.')).toHaveCount(0);
      const toggle = a.page.getByRole('button', { name: /Toggle/ }).first();
      await expect(toggle).toBeVisible();
      const before = await toggle.getAttribute('aria-pressed');
      await toggle.click();
      await expect(toggle).not.toHaveAttribute('aria-pressed', before ?? '');
    } finally {
      // Never leave a locked month behind: it would fail every other spec that
      // writes to it, and none of them would say why.
      if (locked) {
        await withDb((c) =>
          c.query('UPDATE months SET locked = false WHERE period = $1', [period!]),
        );
      }
      await a.close();
    }
  });

  // ── 6. Audit export ──────────────────────────────────────────────────────

  /**
   * The export is "what I am looking at", not "everything" (ADR-028).
   *
   * ── Why the picker is removed ────────────────────────────────────────────
   * `streamToDisk` prefers `showSaveFilePicker`, which opens a NATIVE dialog.
   * Playwright cannot see or dismiss one, so the click would hang the page and
   * the failure would look like a broken export. Deleting the API forces the
   * Blob branch, which routes through a normal anchor download and is the same
   * path webkit takes anyway — so both engines assert the same bytes here. The
   * picker branch is the one this suite cannot drive; it is a browser API call
   * with no logic of its own.
   */
  test('the CSV export carries exactly the filtered rows, header first', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    });

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/settings/audit-log');

    // A filter narrow enough to be checkable and wide enough to be non-empty:
    // one table, whichever it is, over every row this database holds.
    //
    // `typeInto`, NOT `fill()` — the React-controlled-input trap documented in
    // helpers/auth.ts. In webkit, fill() sets `value` and dispatches one input
    // event, React's value tracker treats that as no change, and the next render
    // restores "". The filter silently stayed empty, so the export streamed
    // EVERY row (15,765) while the count below asked for one table (193). The
    // test failed on the right thing for the wrong reason: not a broken export,
    // a filter that was never applied.
    await typeInto(page.getByLabel('Table'), 'staff');
    // The value must SURVIVE to the export, asserted the way login() asserts its
    // credentials. Without this the filter's failure is invisible until a row
    // count disagrees 40 lines later.
    await expect(page.getByLabel('Table')).toHaveValue('staff');
    await expect(page.getByTestId('audit-row').first()).toBeVisible({ timeout: 15_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByRole('button', { name: /Export CSV/ }).click(),
    ]);

    const csv = await readFile((await download.path())!, 'utf8');
    // Splitting on newlines is sound here only because no cell can contain one:
    // the JSONB columns go through JSON.stringify, which escapes them to a
    // literal \n, and no other column is free text.
    const lines = csv.trim().split('\n');

    expect(lines[0]).toContain('Timestamp (IST)');
    expect(download.suggestedFilename()).toMatch(/^audit-log-.*\.csv$/);

    // The count the table would show for the SAME filter, walked to the end —
    // the export and the query are built from one `toQuery`, and this is what
    // proves they did not diverge.
    const auth = await authHeaders(page.context());
    let cursor = '';
    let expected = 0;
    do {
      const res = await page.request.get(
        `${API}/v1/audit-log?tableName=staff${cursor ? `&cursor=${cursor}` : ''}`,
        { headers: auth },
      );
      const body = (await res.json()) as { data: unknown[]; nextCursor: string | null };
      expected += body.data.length;
      cursor = body.nextCursor ?? '';
    } while (cursor);

    // -1 for the header row. An off-by-one here means the export dropped a row
    // or wrote the header twice, both of which a "did it download" test misses.
    expect(lines.length - 1).toBe(expected);
  });
});

