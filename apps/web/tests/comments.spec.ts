import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { authHeaders, login } from './helpers/auth';
import { withDb } from './helpers/db';
import { currentIstPeriod } from './helpers/period-dates';

/**
 * E2E: comments (Sprint 12 STEP 11).
 *
 * Three claims that only a real browser against a real server can make:
 *
 *   1. The write path works through the UI — post from the panel, and it is in
 *      the thread the server returns.
 *   2. ⭐ A comment posted in one session reaches ANOTHER open session without a
 *      reload. That is `new_comment` riding `notify:new` (ADR-006/032). There is
 *      no `comment:new` event, so a spec that faked one would prove nothing.
 *   3. The visibility predicate is the same one search uses (ADR-015/032) — the
 *      author's own comment comes back from `/v1/search`, and a freelancer with
 *      no slot on that row gets neither the comment nor the search hit.
 *
 * Plus the cron surface: `/v1/internal/*` must be unreachable without the shared
 * secret, from a browser session that is otherwise fully authenticated.
 *
 * A = the MEMBER, B = the ADMIN, deliberately. `new_comment` fans out to every
 * admin/manager and never to the author (ADR-006), so admin→admin would be a
 * test of nothing and admin→member would expect a notification the server is
 * right not to send.
 *
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD
 *   TEST_FREELANCER_EMAIL / TEST_FREELANCER_PASSWORD
 *   DATABASE_URL, NEXT_PUBLIC_API_URL
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FREELANCER_EMAIL = process.env.TEST_FREELANCER_EMAIL ?? '';
const FREELANCER_PASSWORD = process.env.TEST_FREELANCER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const FLOW_ENABLED = Boolean(
  ADMIN_PASSWORD && MEMBER_PASSWORD && FREELANCER_PASSWORD && process.env.DATABASE_URL,
);

/** Period-derived, never a pinned date (A6). */
const PERIOD = currentIstPeriod();

const MARK = 'E2E-COMMENT:';
/** A word that exists nowhere else in the database, so a search hit is unambiguous. */
const TOKEN = 'quillfeather';

let clientId = '';
let clientName = '';

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
 * Open the row's panel, post `body`, and assert the write was ACCEPTED.
 *
 * Asserting the 201 rather than only the rendered text: a refused post (a locked
 * period, a record the role cannot reach) leaves the thread unchanged, and
 * waiting on the text alone turns that into a 60s timeout that names nothing.
 */
async function postComment(page: Page, body: string): Promise<void> {
  await page.getByTestId(`comments-open-${clientId}`).click();
  const composer = page.getByTestId('comment-composer');
  await expect(composer).toBeVisible();

  const posted = page.waitForResponse(
    (r) => r.url().includes('/v1/comments') && r.request().method() === 'POST',
  );
  await composer.fill(body);
  await composer.press('Enter');
  const res = await posted;
  expect(res.status(), `POST /v1/comments refused: ${await res.text()}`).toBe(201);
}

test.beforeAll(async () => {
  if (!FLOW_ENABLED) return;
  await withDb(async (c) => {
    // A client that actually holds a shoot row this period — commenting on a
    // module record the row does not exist for is a 404 by design (H-06).
    const row = await c.query(
      `SELECT cl.id, cl.name
         FROM clients cl
         JOIN shoot_schedules s ON s.client_id = cl.id AND s.period = $1
        WHERE cl.active AND NOT cl.is_internal AND cl.deleted_at IS NULL
        ORDER BY cl.name
        LIMIT 1`,
      [PERIOD],
    );
    clientId = (row.rows[0]?.id as string) ?? '';
    clientName = (row.rows[0]?.name as string) ?? '';
  });
});

test.afterAll(async () => {
  if (!FLOW_ENABLED) return;
  await withDb((c) => c.query('DELETE FROM comments WHERE content LIKE $1', [`${MARK}%`]));
});

test.describe('comments', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_*, TEST_FREELANCER_* and DATABASE_URL.');
    test.skip(!clientId, 'No client with a shoot row this period — nothing to comment on.');
  });

  test('an admin posts from the grid panel and sees it in the thread', async ({ browser }) => {
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/shoot-planner?period=${PERIOD}`);
    const body = `${MARK} posted from the panel`;

    try {
      await postComment(a.page, body);

      await expect(a.page.getByText(body)).toBeVisible();
      // The composer clearing is the signal the write was accepted, not queued.
      await expect(a.page.getByTestId('comment-composer')).toHaveValue('');
    } finally {
      await a.close();
    }
  });

  test("⭐ a member's comment reaches an admin's open thread with no reload", async ({ browser }) => {
    const a = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, `/shoot-planner?period=${PERIOD}`);
    const b = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/shoot-planner?period=${PERIOD}`);
    const body = `${MARK} ${TOKEN} live`;

    try {
      // B has the same row's thread open BEFORE the comment exists.
      await b.page.getByTestId(`comments-open-${clientId}`).click();
      await expect(b.page.getByTestId('comment-composer')).toBeVisible();

      await postComment(a.page, body);

      // No reload, no navigation: `new_comment` arrives on notify:new and the
      // panel invalidates its own query.
      await expect(b.page.getByText(body)).toBeVisible({ timeout: 15_000 });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test('⭐ the comment is searchable by its author and invisible to an unrelated freelancer', async ({
    browser,
  }) => {
    const a = await openAs(browser, MEMBER_EMAIL, MEMBER_PASSWORD, `/shoot-planner?period=${PERIOD}`);
    const f = await openAs(browser, FREELANCER_EMAIL, FREELANCER_PASSWORD, '/');
    const body = `${MARK} ${TOKEN} searchable`;

    try {
      await postComment(a.page, body);
      await expect(a.page.getByText(body)).toBeVisible();

      // Sprint 9 shipped this category returning empty for three sprints. It is
      // live now because it runs the SAME predicate the panel does.
      const authorHeaders = await authHeaders(a.context);
      const mine = await a.page.request.get(
        `${API_BASE}/v1/search?q=${TOKEN}&period=${PERIOD}`,
        { headers: authorHeaders },
      );
      expect(mine.status()).toBe(200);
      expect(JSON.stringify((await mine.json()).data)).toContain(TOKEN);

      // The freelancer holds no slot on this row, so the predicate excludes it —
      // asserted at the API, because a UI that merely hides rows the server sent
      // is not isolation.
      const theirs = await f.page.request.get(
        `${API_BASE}/v1/search?q=${TOKEN}&period=${PERIOD}`,
        { headers: await authHeaders(f.context) },
      );
      expect(theirs.status()).toBe(200);
      expect(JSON.stringify((await theirs.json()).data)).not.toContain(TOKEN);

      const list = await f.page.request.get(
        `${API_BASE}/v1/comments?module=shoot_planner&recordId=${clientId}&period=${PERIOD}`,
        { headers: await authHeaders(f.context) },
      );
      // 200-with-nothing or 403 are both correct; a body carrying the text is not.
      expect(JSON.stringify(await list.text())).not.toContain(TOKEN);
    } finally {
      await Promise.all([a.close(), f.close()]);
    }
  });

  test('the deep link from a new_comment notification opens that row’s thread', async ({
    browser,
  }) => {
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, `/shoot-planner?period=${PERIOD}`);
    try {
      // Exactly the URL CommentService.fanOut builds.
      await a.page.goto(`/shoot-planner?period=${PERIOD}&comments=${clientId}`);
      await expect(a.page.getByRole('dialog', { name: new RegExp(clientName) })).toBeVisible();
    } finally {
      await a.close();
    }
  });
});

test.describe('the cron surface', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_* and DATABASE_URL.');
  });

  test('⭐ /v1/internal/* refuses a fully authenticated browser session', async ({ browser }) => {
    const a = await openAs(browser, ADMIN_EMAIL, ADMIN_PASSWORD, '/');
    try {
      const headers = await authHeaders(a.context);
      for (const path of [
        '/v1/internal/attachment-sweep',
        '/v1/internal/message-retention',
        '/v1/internal/recompute-shoot-dates',
      ]) {
        const res = await a.page.request.post(`${API_BASE}${path}`, { headers });
        // An admin's JWT is not a cron secret. These jobs delete R2 objects and
        // year-old messages; the only key that opens them is X-Internal-Secret.
        expect(res.status(), `${path} must not accept a Bearer token`).toBe(401);
      }
    } finally {
      await a.close();
    }
  });

  test('the recompute endpoint returns a summary when the secret is right', async ({ request }) => {
    const secret = process.env.CRON_SECRET ?? '';
    test.skip(!secret, 'Set CRON_SECRET to exercise the authenticated cron path.');

    const res = await request.post(`${API_BASE}/v1/internal/recompute-shoot-dates?period=${PERIOD}`, {
      headers: { 'x-internal-secret': secret },
    });
    expect(res.status()).toBe(200);
    // A job that reports nothing is one nobody can tell has stopped working.
    expect((await res.json()).data).toMatchObject({ period: PERIOD, failed: 0 });
  });
});
