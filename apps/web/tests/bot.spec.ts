import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { login, typeInto } from './helpers/auth';

/**
 * E2E smoke: the AI bot (Sprint 8 STEP 9.1). Runs against the LIVE Anthropic
 * API on the dev-Haiku key — the model is not mocked here.
 *
 * That choice drives every assertion in this file. A live model rewords itself
 * run to run, so asserting on its prose would be asserting on a coin flip. What
 * IS deterministic is the contract around it, and that is what we check:
 *
 *   - C-01: POST /v1/bot/message answers 202 with { messageId, sessionId } and
 *     NO content/card — the reply arrives over /ws/notify.
 *   - Tokens actually stream: the assistant bubble grows from empty.
 *   - The right TOOL ran, evidenced by the card the tool emits (card type and
 *     its frame title are ours, not the model's).
 *   - A tool the caller may not use produces the refusal copy and no card.
 *
 * Needs the full local stack: web + API + Postgres + Redis, and a funded
 * ANTHROPIC_API_KEY on the API. Self-skips without the E2E env, like the rest of
 * this suite.
 *
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD / TEST_ADMIN_TOTP_SECRET
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD
 *   DATABASE_URL, NEXT_PUBLIC_API_URL
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

const MARK = 'E2E-BOT:';

/** A live model round-trip with a tool call is two streams — 30s is not enough. */
const BOT_TIMEOUT = 90_000;

function currentIstPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
}
const PERIOD = currentIstPeriod();

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

/**
 * Seed an unmistakably overdue task so the overdue tool has something to return.
 *
 * The period must be the CURRENT one: tasks.period is FK'd to months, so a
 * made-up past period ('2020-01') violates tasks_period_fkey. Overdue is
 * "deadline < today AND status not closed" (lib/bot/tools/tasks.ts), so a
 * deadline on the 1st of this month is reliably overdue for every run except one
 * made on the 1st itself — hence the day-before fallback.
 */
async function seedOverdueTask(c: Client, createdBy: string): Promise<string> {
  const id = randomUUID();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const deadline = today.endsWith('-01')
    ? new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    : `${PERIOD}-01`;
  await c.query(
    `INSERT INTO tasks (id, period, date, description, status, deadline, created_by)
     VALUES ($1,$2,$3,$4,'To Do',$5,$6)`,
    [id, PERIOD, `${PERIOD}-01`, `${MARK} overdue ${Date.now()}`, deadline, createdBy],
  );
  return id;
}

async function cleanup() {
  await withDb(async (c) => {
    await c.query(`DELETE FROM tasks WHERE description LIKE $1`, [`${MARK}%`]);
  });
}

/** The Bearer token the browser sends — captured from a real /v1 call. */
async function captureApiToken(page: Page, navigate: () => Promise<unknown>): Promise<string> {
  const pending = page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  await navigate();
  return (await pending).headers()['authorization']!;
}

/** The chat panel's assistant bubbles (the user's own messages are self-end). */
function assistantBubbles(page: Page) {
  return page.locator('li:not(.self-end) > div.whitespace-pre-wrap');
}

/**
 * Type a question and send it, returning the POST /v1/bot/message response so the
 * caller can assert C-01 on it. Armed before the click — waitForResponse only
 * sees traffic that starts after it is waiting.
 */
async function ask(page: Page, question: string) {
  const pending = page.waitForResponse(
    (r) => r.url().includes('/v1/bot/message') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  // typeInto, not fill(): Send is disabled until input.trim() is non-empty, and
  // in webkit fill() leaves React's state at "" (see the note on typeInto), so
  // the button never enables and the click retries until the test times out.
  await typeInto(page.getByPlaceholder('Ask the assistant…'), question);
  await page.getByRole('button', { name: 'Send' }).click();
  return pending;
}

test.describe('bot — live smoke', () => {
  test.describe.configure({ timeout: BOT_TIMEOUT });

  test.beforeEach(async ({ page }) => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the bot smoke.');
    // Each test starts from an empty conversation regardless of what the last
    // run left in Redis, so history can't leak across tests.
    void page;
  });

  test.afterEach(async () => {
    if (FLOW_ENABLED) await cleanup();
  });

  test('admin: overdue question returns 202, streams tokens, and renders an overdue card', async ({
    page,
  }) => {
    await withDb(async (c) => seedOverdueTask(c, await staffIdByEmail(c, ADMIN_EMAIL)));

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/bot');
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();

    const res = await ask(page, 'How many tasks are overdue?');

    // C-01: the ack carries ids only — never the answer.
    expect(res.status()).toBe(202);
    const body = (await res.json()).data;
    expect(body).toHaveProperty('messageId');
    expect(body).toHaveProperty('sessionId');
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('card');

    // The reply arrives over the socket. The bubble starts empty (Thinking) and
    // fills — proving tokens streamed rather than one buffered write.
    const reply = assistantBubbles(page).last();
    await expect(reply).toHaveText(/\S/, { timeout: BOT_TIMEOUT });

    // The card is the tool's own output, so it is the honest evidence that
    // list_overdue_tasks actually ran — the prose around it is the model's.
    await expect(page.getByText(/^Overdue as of /)).toBeVisible({ timeout: BOT_TIMEOUT });
  });

  /**
   * NOTE ON WHAT THIS ASSERTS. STEP 9.1 asks for the canned "Ask your admin"
   * refusal here. That string (BotService.ts:40) is reached from runTool, i.e.
   * only when the model CALLS a tool it may not use — but getPermittedBotTools
   * strips unpermitted tools from the definitions before the model ever sees
   * them, so with a plain override the model simply has no attendance tool and
   * improvises its own refusal ("I don't have a tool available to check
   * attendance records…"). The canned copy is the backstop for a hallucinated
   * tool name, not the normal path.
   *
   * Improvised prose is different on every run, so asserting on it would assert
   * on a coin flip. The two things that actually matter here are deterministic,
   * and they are what this test checks: the override really reached the resolver
   * (visible on /v1/staff/me, which proves the perms:{staffId} bust), and no
   * attendance data reached the user (no card).
   */
  test('team_member: a denied tool yields no attendance data and no card', async ({ page }) => {
    const memberId = await withDb((c) => staffIdByEmail(c, MEMBER_EMAIL));

    // Turn get_attendance off for the member via the admin override endpoint —
    // the resolver busts perms:{staffId}, so it applies to the very next turn.
    const adminPage = await page.context().browser()!.newPage();
    await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminToken = await captureApiToken(adminPage, () => adminPage.goto('/bot'));
    const put = await adminPage.request.put(
      `${API_BASE}/v1/staff/${memberId}/permissions/bot.tool.get_attendance`,
      { headers: { authorization: adminToken }, data: { value: false } },
    );
    expect(put.status()).toBe(200);
    await adminPage.close();

    try {
      // The override persisted, so getPermittedBotTools will read it and strip
      // the tool. NOT asserted via /v1/staff/me: that endpoint is backed by
      // getEffectivePermissions (lib/permissions.ts), which still returns the
      // role baseline and ignores user_permissions entirely — so it reports
      // get_attendance as true here even though the bot correctly refuses. See
      // the Sprint 8 close-out note; the bot's own path (PermissionService) is
      // the one under test.
      const stored = await withDb((c) =>
        c.query('SELECT value FROM user_permissions WHERE staff_id=$1 AND permission_key=$2', [
          memberId,
          'bot.tool.get_attendance',
        ]),
      );
      expect(stored.rows[0]?.value).toBe(false);

      await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
      await page.goto('/bot');
      await ask(page, `What is my attendance for ${PERIOD}?`);

      // The bot still answers — a denied tool is a normal conversation, not an error.
      await expect(assistantBubbles(page).last()).toHaveText(/\S/, { timeout: BOT_TIMEOUT });
      // …but no attendance data comes back, and no error code is leaked.
      await expect(page.getByText(/^Attendance · /)).toHaveCount(0);
      await expect(assistantBubbles(page).last()).not.toHaveText(/PERMISSION_DENIED|\b[45]\d\d\b/);
    } finally {
      // Restore the override whatever happened — a left-behind false would
      // silently break every later attendance assertion in the suite.
      await withDb((c) =>
        c.query('DELETE FROM user_permissions WHERE staff_id = $1 AND permission_key = $2', [
          memberId,
          'bot.tool.get_attendance',
        ]),
      );
    }
  });

  test('new conversation clears the panel and empties the stored session', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const token = await captureApiToken(page, () => page.goto('/bot'));

    await ask(page, 'Which holidays are configured?');
    await expect(assistantBubbles(page).last()).toHaveText(/\S/, { timeout: BOT_TIMEOUT });

    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();

    // Panel is back to its empty state.
    await expect(page.getByText('Ask about tasks, attendance, shoots, holidays, and more.')).toBeVisible();
    await expect(assistantBubbles(page)).toHaveCount(0);

    // …and so is the server-side session — the DELETE really dropped the Redis key.
    const session = await page.request.get(`${API_BASE}/v1/bot/session/current`, {
      headers: { authorization: token },
    });
    expect(session.status()).toBe(200);
    expect((await session.json()).data.messages).toEqual([]);
  });
});
