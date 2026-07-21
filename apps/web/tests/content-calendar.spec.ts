import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

/**
 * E2E: Content Calendar (Sprint 7 STEP 9) — cell edit via the popover, the
 * positioned-overlay gold highlight INCLUDING the virtualisation case, the
 * Trigger-2 round trip (gold dot appears, then disappears on a manual edit), the
 * 409 inline conflict, and the role gates.
 *
 * The overlay's hide-on-scroll-out is the reason this spec matters: it needs real
 * scroll events, which a backgrounded Chrome tab never dispatches. Playwright
 * launches with --disable-renderer-backgrounding (and friends), so its pages are
 * treated as foreground even headless — this is the right place to assert it, and
 * the only place it can be asserted reliably.
 *
 * Path note: the guide names this tests/e2e/content-calendar.spec.ts, but the
 * config's testDir is ./tests (Sprint 1 convention) and only chromium is wired —
 * same as the Sprint 5/6 specs.
 *
 * Needs a live web app + API + Supabase test project:
 *   E2E_BASE_URL · NEXT_PUBLIC_API_URL · DATABASE_URL
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD          (role test only)
 *   TEST_FREELANCER_EMAIL / TEST_FREELANCER_PASSWORD  (role test only)
 * Self-skips without them, like the other live specs. Re-runnable: every cell it
 * touches is restored in afterEach.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FREELANCER_EMAIL = process.env.TEST_FREELANCER_EMAIL ?? '';
const FREELANCER_PASSWORD = process.env.TEST_FREELANCER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const ENABLED = Boolean(ADMIN_PASSWORD && process.env.DATABASE_URL);

const ist = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', ...opts }).format(new Date());
const PERIOD = ist({ year: 'numeric', month: '2-digit' });
const TODAY = ist({ year: 'numeric', month: '2-digit', day: '2-digit' });

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /Sign in/i }).click();
  // Wait for the post-login redirect so a following goto() carries the token.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
}

/**
 * The Bearer header the browser sends — captured from a /v1 call.
 *
 * waitForRequest only observes requests made AFTER it starts waiting, so calling
 * it once a page has already finished loading waits forever. Start the wait, then
 * force a request: navigating (or re-navigating) always refetches the grid.
 */
async function captureApiToken(page: Page, navigate: () => Promise<unknown>): Promise<string> {
  const pending = page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  await navigate();
  const req = await pending;
  return req.headers()['authorization']!;
}

/**
 * Navigate to the calendar and return the Bearer header, captured from the grid
 * fetch that the navigation itself triggers. Every test takes the token here
 * rather than mid-test: capturing later would need a reload, and a reload
 * mid-test silently resets scroll position and re-mounts the grid under
 * whatever the test was about to assert.
 */
async function gotoCalendar(page: Page, period = PERIOD): Promise<string> {
  const auth = await captureApiToken(page, () => page.goto(`/content-calendar?period=${period}`));
  await expect(page.getByRole('grid')).toBeVisible();
  return auth;
}

/** The calendar's own column order — index 0 is the leftmost column. */
async function calendarClients(page: Page, auth: string): Promise<{ id: string; name: string }[]> {
  const res = await page.request.get(`${API_BASE}/v1/content-calendar?period=${PERIOD}`, {
    headers: { authorization: auth },
  });
  const body = (await res.json()) as { data: { clients: { id: string; name: string }[] } };
  return body.data.clients;
}

/**
 * Bring a client's column into the virtual window. With the perf fixture seeded,
 * most columns are NOT in the DOM at rest, so any assertion about an arbitrary
 * client's cell has to scroll to it first — otherwise the test is really
 * asserting "this client happened to be on screen", which passes or fails with
 * the client count.
 */
async function scrollColumnIntoView(page: Page, auth: string, clientId: string) {
  const clients = await calendarClients(page, auth);
  const index = clients.findIndex((c) => c.id === clientId);
  expect(index, 'client is not a calendar column').toBeGreaterThanOrEqual(0);
  await page.evaluate(
    ({ i }) => {
      const scroller = document.querySelector('[role="grid"]')!.parentElement!;
      // 90px columns after the 80px sticky date column; centre it in the viewport.
      scroller.scrollLeft = Math.max(0, 80 + i * 90 - scroller.clientWidth / 2);
    },
    { i: index },
  );
}

/** Restore a cell to a pristine generated state. */
async function resetCell(clientId: string, date = TODAY) {
  await withDb((c) =>
    c.query(
      `UPDATE content_calendar SET status='No Activity', source=NULL, note=NULL, version=1, updated_by=NULL
       WHERE client_id=$1 AND date=$2`,
      [clientId, date],
    ),
  );
}

test.describe('Content Calendar', () => {
  test.skip(!ENABLED, 'Set TEST_ADMIN_* and DATABASE_URL to run the live calendar E2E.');

  const touched = new Set<string>();
  test.afterEach(async () => {
    for (const id of touched) await resetCell(id);
    touched.clear();
  });

  test('admin edits a cell through the popover; it closes on outside click', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = await gotoCalendar(page);
    const [client] = await calendarClients(page, auth);
    touched.add(client!.id);

    const cell = page.getByTestId(`calendar-cell-${client!.id}-${TODAY}`);
    await cell.click();

    const popover = page.getByTestId(`cell-popover-${client!.id}-${TODAY}`);
    await expect(popover).toBeVisible();
    await popover.getByTestId('cell-status').selectOption('Ready');

    // Optimistic + server replace — the chip reflects the new status.
    await expect(cell).toHaveAttribute('aria-label', /Ready/);

    await page.getByTestId('popover-backdrop').click();
    await expect(popover).toBeHidden();

    // And it really persisted (not just an un-reverted optimistic write).
    const row = await withDb((c) =>
      c.query(`SELECT status, source FROM content_calendar WHERE client_id=$1 AND date=$2`, [client!.id, TODAY]),
    );
    expect(row.rows[0]).toMatchObject({ status: 'Ready', source: 'manual' });
  });

  test('gold overlay: visible on open, hidden on close, and hidden when its column scrolls out', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = await gotoCalendar(page);
    const [client] = await calendarClients(page, auth);
    touched.add(client!.id);

    const overlay = page.getByTestId(`column-highlight-${client!.id}`);
    await expect(overlay).toBeHidden();

    await page.getByTestId(`calendar-cell-${client!.id}-${TODAY}`).click();
    await expect(overlay).toBeVisible();

    // THE VIRTUALISATION CASE: scroll that column out of the virtual window. A
    // class-based highlight would vanish with the recycled column; a clamped
    // overlay would stick to the edge over the WRONG client. Ours must hide.
    await page.evaluate(() => {
      const grid = document.querySelector('[role="grid"]');
      const scroller = grid!.parentElement!;
      scroller.scrollLeft = scroller.scrollWidth;
    });
    await expect(overlay).toBeHidden();

    // Scrolling back brings it back — it hid, it did not get destroyed.
    await page.evaluate(() => {
      const grid = document.querySelector('[role="grid"]');
      grid!.parentElement!.scrollLeft = 0;
    });
    await expect(overlay).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('column virtualisation culls the DOM (Impl-Plan §10)', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/content-calendar?period=${PERIOD}`);
    await expect(page.getByRole('grid')).toBeVisible();

    const counts = await page.evaluate(() => {
      const grid = document.querySelector('[role="grid"]')!;
      return {
        totalClients: Number(grid.getAttribute('aria-colcount')) - 1,
        renderedClientColumns: grid.querySelectorAll('[role="columnheader"]').length - 1,
        renderedRows: grid.querySelectorAll('[role="row"]').length - 1, // minus header
      };
    });

    // Rows are NOT virtualised — all ≤31 days render.
    expect(counts.renderedRows).toBeLessThanOrEqual(31);
    // Columns ARE. With the perf fixture seeded (40 clients) far fewer render
    // than exist; the assertion is only meaningful when there are enough.
    if (counts.totalClients >= 30) {
      expect(counts.renderedClientColumns).toBeLessThan(counts.totalClients);
      expect(counts.renderedClientColumns).toBeLessThanOrEqual(25);
    }
  });

  test('Trigger 2 round trip: the gold dot appears, then disappears after a manual edit', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = await gotoCalendar(page);

    // A pipeline with no stages set yet, for a client that has a cell today.
    const pick = await withDb((c) =>
      c.query(
        `SELECT p.id, p.client_id, p.version FROM content_pipelines p
         JOIN content_calendar cc ON cc.client_id = p.client_id AND cc.date = $2
         JOIN clients cl ON cl.id = p.client_id
         WHERE p.period = $1 AND p.raw_received_at IS NULL AND cl.active AND NOT cl.is_internal
         LIMIT 1`,
        [PERIOD, TODAY],
      ),
    );
    test.skip(pick.rows.length === 0, 'No un-staged pipeline with a cell for today.');
    const { id, client_id: clientId } = pick.rows[0] as { id: string; client_id: string };
    touched.add(clientId);

    let version = Number((pick.rows[0] as { version: number }).version);
    for (const stage of ['raw', 'finals', 'posted']) {
      const res = await page.request.patch(`${API_BASE}/v1/content-dropper/${id}/stage`, {
        headers: { authorization: auth },
        data: { stage, version },
      });
      expect(res.status()).toBe(200);
      version = (await res.json()).data.version as number;
    }

    await gotoCalendar(page);
    // This client is arbitrary, so its column is probably culled — scroll to it.
    await scrollColumnIntoView(page, auth, clientId);
    const cell = page.getByTestId(`calendar-cell-${clientId}-${TODAY}`);
    await expect(cell).toHaveAttribute('aria-label', /Posted/);
    // The 6px marker + its tooltip (APPFLOW §8).
    const dot = page.getByTestId(`trigger-dot-${clientId}-${TODAY}`);
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', 'Auto-updated from Content Dropper');

    // A manual edit resets source to 'manual' server-side, so the dot must go.
    await cell.click();
    await page.getByTestId('cell-status').selectOption('Ready');
    await expect(dot).toBeHidden();

    // Restore the pipeline so the spec is re-runnable.
    await withDb((c) =>
      c.query(
        `UPDATE content_pipelines SET raw_received_at=NULL, finals_ready_at=NULL, posted_at=NULL, version=1 WHERE id=$1`,
        [id],
      ),
    );
  });

  test('a stale version renders the inline conflict with the updater name', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const auth = await gotoCalendar(page);
    const [client] = await calendarClients(page, auth);
    touched.add(client!.id);

    // Move the row underneath the loaded cache, exactly like a concurrent editor.
    await withDb((c) =>
      c.query(
        `UPDATE content_calendar SET version = version + 3,
           updated_by = (SELECT id FROM staff WHERE role='admin' AND active LIMIT 1)
         WHERE client_id=$1 AND date=$2`,
        [client!.id, TODAY],
      ),
    );

    await page.getByTestId(`calendar-cell-${client!.id}-${TODAY}`).click();
    await page.getByTestId('cell-status').selectOption('Pending');

    const refresh = page.getByTestId(`stale-refresh-${client!.id}-${TODAY}`);
    await expect(refresh).toBeVisible();
    await expect(refresh).toHaveText(/Refresh row/);
    await expect(page.getByText(/Updated by /)).toBeVisible();

    // The link re-reads the row and clears the conflict.
    await refresh.click();
    await expect(refresh).toBeHidden();
  });

  test('team_member sees a read-only grid and is refused by the API', async ({ page }) => {
    test.skip(!MEMBER_PASSWORD, 'Set TEST_MEMBER_* to run the read-only role test.');
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    const auth = await gotoCalendar(page);

    // The grid renders but cannot be interacted with (Impl-Plan §10). The
    // computed style is the assertion — the API gate below is the real guarantee.
    const pointerEvents = await page.evaluate(
      () => getComputedStyle(document.querySelector('[role="grid"]')!.parentElement!).pointerEvents,
    );
    expect(pointerEvents).toBe('none');
    // Comments stay outside that container, so they remain interactive later.
    await expect(page.getByText('Comments — coming soon')).toBeVisible();

    const anyCell = await withDb((c) =>
      c.query(`SELECT id, version FROM content_calendar WHERE period=$1 LIMIT 1`, [PERIOD]),
    );
    const res = await page.request.patch(`${API_BASE}/v1/content-calendar/${anyCell.rows[0].id}`, {
      headers: { authorization: auth },
      data: { status: 'Ready', version: anyCell.rows[0].version },
    });
    expect(res.status()).toBe(403);
  });

  test('freelancer is refused the calendar entirely', async ({ page }) => {
    test.skip(!FREELANCER_PASSWORD, 'Set TEST_FREELANCER_* to run the freelancer role test.');
    await login(page, FREELANCER_EMAIL, FREELANCER_PASSWORD);
    // A page a freelancer may load, purely to mint a token.
    const auth = await captureApiToken(page, () => page.goto('/tasks'));

    const res = await page.request.get(`${API_BASE}/v1/content-calendar?period=${PERIOD}`, {
      headers: { authorization: auth },
    });
    expect(res.status()).toBe(403);
  });

  test('NFR §1.1: FCP < 1.5s and TTI-proxy < 2.0s with a full period loaded', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/content-calendar?period=${PERIOD}`);
    await expect(page.getByRole('grid')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return {
        fcpMs: fcp,
        // domInteractive is the standard TTI proxy; true TTI needs a long-task
        // quiet window, which is measured in the manual DevTools pass instead.
        domInteractiveMs: nav ? nav.domInteractive : null,
        clients: Number(document.querySelector('[role="grid"]')!.getAttribute('aria-colcount')) - 1,
      };
    });

    console.log('[calendar perf]', JSON.stringify(metrics));
    // NFR §1.1 states the target shape as 31×20, so measuring below 20 clients
    // would report a number that does not mean what the gate asks for. Skip
    // rather than fail — an unseeded DB is a missing fixture, not a regression.
    test.skip(
      metrics.clients < 20,
      `Only ${metrics.clients} clients. Seed first: pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 40`,
    );
    if (metrics.fcpMs !== null) expect(metrics.fcpMs).toBeLessThan(1500);
    if (metrics.domInteractiveMs !== null) expect(metrics.domInteractiveMs).toBeLessThan(2000);
  });
});
