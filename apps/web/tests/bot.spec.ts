import { randomUUID } from 'node:crypto';
import net from 'node:net';

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

/**
 * `DEL` straight down the Redis wire.
 *
 * The bot session lives in Redis, this suite has no Redis client, and pulling in
 * a whole one for a single teardown command is not worth it — RESP for DEL is
 * three lines. Never throws: a teardown that fails the run is worse than a key
 * that outlives it, and every test clears its own conversation on the way in.
 */
async function redisDel(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  await new Promise<void>((resolve) => {
    const socket = net.createConnection(
      { host: url.hostname || 'localhost', port: Number(url.port || 6379) },
      () => {
        const argv = ['DEL', ...keys];
        socket.write(
          `*${argv.length}\r\n${argv.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`,
        );
      },
    );
    socket.on('data', () => socket.end());
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
  });
}

async function cleanup() {
  const ids = await withDb(async (c) => {
    await c.query(`DELETE FROM tasks WHERE description LIKE $1`, [`${MARK}%`]);
    return [await staffIdByEmail(c, ADMIN_EMAIL), await staffIdByEmail(c, MEMBER_EMAIL)];
  });
  // The conversation itself, not just its writes: a session left in Redis is
  // replayed into the panel by the NEXT run, and an assertion that should wait
  // for a turn then passes instantly against history.
  await redisDel(ids.filter(Boolean).flatMap((id) => [`bot:session:${id}`, `bot:pending:${id}`]));
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
   * NOTE ON WHAT THIS ASSERTS (updated in Sprint 8.1).
   *
   * Sprint 8 shipped this asserting only "no card", because a denied tool was
   * simply absent from the model's tool list and the model improvised its own
   * refusal — prose that differs every run, so the canonical copy could not be
   * asserted honestly. Sprint 8.1 puts the denied capabilities and the exact
   * sentence into the system prompt, so the copy is now instructed.
   *
   * Model output is still probabilistic, so the split is deliberate: the strict
   * word-for-word contract is pinned in the buildSystemPrompt unit tests, and
   * here we assert loosely (a substring) plus the constraint that actually
   * protects the user — that no role is ever named (APPFLOW §9).
   */
  test('team_member: a denied tool refuses in our copy, names no role, and renders no card', async ({
    page,
  }) => {
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
      await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
      const token = await captureApiToken(page, () => page.goto('/bot'));

      // Since Sprint 8.1 there is ONE resolver, so the value the bot gates on is
      // the value /v1/staff/me reports. (Pre-8.1 this said `true` here while the
      // bot correctly refused — that divergence was Defect 1.)
      const me = await page.request.get(`${API_BASE}/v1/staff/me`, {
        headers: { authorization: token },
      });
      expect((await me.json()).permissions['bot.tool.get_attendance']).toBe(false);

      await ask(page, `What is my attendance for ${PERIOD}?`);

      const reply = assistantBubbles(page).last();
      // The bot still answers — a denied tool is a normal conversation, not an error.
      await expect(reply).toHaveText(/\S/, { timeout: BOT_TIMEOUT });
      // Our copy, matched loosely: the strict wording lives in the
      // buildSystemPrompt unit tests, where it is deterministic.
      await expect(reply).toHaveText(/ask an admin/i, { timeout: BOT_TIMEOUT });
      // APPFLOW §9's constraint — the refusal must never reveal the permission
      // model. This is the assertion that would catch a regression in the prompt.
      await expect(reply).not.toHaveText(
        /\b(admin|manager|team.?member|freelancer)\s+(role|permission|access|level)/i,
      );
      // …and no attendance data comes back, and no error code is leaked.
      await expect(page.getByText(/^Attendance · /)).toHaveCount(0);
      await expect(reply).not.toHaveText(/PERMISSION_DENIED|\b[45]\d\d\b/);

      // The carve-out, asked in the SAME turn-context so the TOOL ACCESS section
      // is definitely in play: something the portal doesn't cover at all must get
      // a plain can't-help answer, NOT the permission sentence. Without the last
      // prompt paragraph the model over-applies the refusal to everything.
      await ask(page, 'What is the weather in Mumbai today?');
      const offTopic = assistantBubbles(page).last();
      await expect(offTopic).toHaveText(/\S/, { timeout: BOT_TIMEOUT });
      await expect(offTopic).not.toHaveText(/ask an admin/i);
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

/**
 * The two-turn mutation cycle (Sprint 9 STEP 12, ADR-014), against the live model.
 *
 * What is asserted is deliberately never the model's prose:
 *   - the CARD (ours), and the exact description string the summary echoes back;
 *   - the DATABASE, before and after — "turn 1 wrote nothing" is the core claim,
 *     and absence of a write is what these tests are really for;
 *   - the turn-2 copy, which is SERVER-rendered and therefore word-for-word
 *     deterministic even though a model is in the loop.
 *
 * Turn 1 is asserted against the DB rather than by navigating to /tasks and back:
 * the session view carries text only, so leaving /bot drops the actionable card
 * and there would be nothing left to press.
 */
test.describe('bot — the two-turn mutation cycle', () => {
  test.describe.configure({ timeout: BOT_TIMEOUT });

  const TASK_DATE = `${PERIOD}-15`;

  /** A description unique per test, so two runs can never see each other's row. */
  const uniqueDescription = (what: string): string => `${MARK} ${what} ${Date.now()}`;

  /** Explicit enough that the model has nothing to ask back about. */
  const createPrompt = (description: string): string =>
    `Create a task dated ${TASK_DATE} with this exact description and nothing else: "${description}". No client, no assignees.`;

  async function taskCount(description: string): Promise<number> {
    return withDb(async (c) => {
      const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM tasks WHERE description = $1', [
        description,
      ]);
      return rows[0].n as number;
    });
  }

  const confirmButton = (page: Page) => page.getByRole('button', { name: 'Confirm', exact: true });
  const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true });

  /**
   * Open /bot on an EMPTY conversation.
   *
   * The session lives in Redis keyed by staffId, so it survives across tests and
   * across runs — the panel restores it on mount. Without this the previous
   * test's "Done — …" is already on screen when the next one looks for it, and
   * an assertion that should have waited for a turn passes instantly against
   * history. Both failures in the first run of this file were that.
   */
  async function openFreshBot(page: Page): Promise<void> {
    await page.goto('/bot');
    await expect(page.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.getByText('Ask about tasks, attendance, shoots, holidays, and more.')).toBeVisible();
  }

  /** The turn's own answer, not whatever else is on the page. */
  const lastReply = (page: Page) => assistantBubbles(page).last();

  /**
   * Turn 1: ask for the task, wait for the confirmation card, and assert the
   * write has NOT happened. Returns the description so the caller can assert on
   * the same row.
   */
  async function stageCreate(page: Page, what: string): Promise<string> {
    const description = uniqueDescription(what);
    await ask(page, createPrompt(description));

    await expect(confirmButton(page)).toBeVisible({ timeout: BOT_TIMEOUT });
    // The card echoes the server-built summary, so the description is an exact
    // string we own — not model prose.
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    // THE CLAIM: nothing was written before consent.
    expect(await taskCount(description)).toBe(0);
    return description;
  }

  test.beforeEach(async () => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the bot smoke.');
  });

  test.afterEach(async () => {
    if (FLOW_ENABLED) await cleanup();
  });

  test('confirm writes the task, and the deep link lands on the flashed row', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openFreshBot(page);
    const description = await stageCreate(page, 'confirm');

    await confirmButton(page).click();

    // Turn 2's copy is server-rendered — no model call produced this sentence.
    await expect(lastReply(page)).toHaveText(/^Done — /, { timeout: BOT_TIMEOUT });
    expect(await taskCount(description)).toBe(1);

    // The result card's deep link is /tasks?period=…&highlight={id} (APPFLOW §12).
    await page.getByRole('link', { name: 'View' }).click();
    await page.waitForURL(/\/tasks\?/);
    await expect(page.getByText(description)).toBeVisible({ timeout: 15_000 });
    // The landing row flashes gold, and the param is stripped so a refresh
    // doesn't replay it.
    await expect(page.locator('tr.sk-row-flash')).toHaveCount(1);
    // The strip is a router.replace in an effect — awaited, not sampled. Webkit
    // lands it a beat later than chromium, which is what a bare url() read caught.
    await page.waitForURL((u) => !u.searchParams.has('highlight'), { timeout: 10_000 });
  });

  test('cancel writes nothing and answers with the canonical copy', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openFreshBot(page);
    const description = await stageCreate(page, 'cancel');

    await cancelButton(page).click();

    await expect(lastReply(page)).toHaveText('Okay, no changes made.', { timeout: BOT_TIMEOUT });
    expect(await taskCount(description)).toBe(0);
    // The resolved card is disabled and reads back what happened.
    await expect(page.getByRole('button', { name: 'Cancelled', exact: true })).toBeDisabled();
  });

  test('a typed "yes" executes, exactly like the button', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openFreshBot(page);
    const description = await stageCreate(page, 'typed-yes');

    await ask(page, 'yes');

    await expect(lastReply(page)).toHaveText(/^Done — /, { timeout: BOT_TIMEOUT });
    expect(await taskCount(description)).toBe(1);
  });

  test('⭐ "yes, but make it Monday" does NOT execute', async ({ page }) => {
    // The headline safety test. A qualified yes is not consent to the summary the
    // user was shown, so the pending record is discarded and the turn re-planned.
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openFreshBot(page);
    const description = await stageCreate(page, 'qualified-yes');

    await ask(page, 'yes, but make it Monday instead');

    // Let the whole turn land before asserting absence, so this cannot pass by
    // reading the DB before a write that was going to happen. The re-planned turn
    // ends in the model's own prose or a fresh confirmation card — never the
    // server-rendered outcome line, which only an executed mutation produces.
    await expect(lastReply(page)).toHaveText(/\S/, { timeout: BOT_TIMEOUT });
    await expect(lastReply(page)).not.toHaveText(/^Done — /);
    expect(await taskCount(description)).toBe(0);
  });

  test('team_member: creating a task is refused, with no card and no role named', async ({ page }) => {
    // bot.tool.create_task is false for team_member by ROLE_DEFAULTS — no override
    // needed, this is the shipped floor.
    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    await openFreshBot(page);

    const description = uniqueDescription('denied');
    await ask(page, createPrompt(description));

    const reply = assistantBubbles(page).last();
    await expect(reply).toHaveText(/\S/, { timeout: BOT_TIMEOUT });
    await expect(reply).toHaveText(/ask an admin/i, { timeout: BOT_TIMEOUT });
    // APPFLOW §9: the refusal must never reveal the permission model.
    await expect(reply).not.toHaveText(
      /\b(admin|manager|team.?member|freelancer)\s+(role|permission|access|level)/i,
    );
    await expect(confirmButton(page)).toHaveCount(0);
    expect(await taskCount(description)).toBe(0);
  });

  test('a locked period refuses at turn 2, after the summary was already shown', async ({ page }) => {
    // The lock is re-asserted inside the write's own transaction, so it can only
    // be discovered AFTER consent — which is exactly the case the friendly copy
    // exists for.
    const prior = new Date(Date.UTC(Number(PERIOD.slice(0, 4)), Number(PERIOD.slice(5, 7)) - 2, 1))
      .toISOString()
      .slice(0, 7);
    const description = uniqueDescription('locked');

    const wasLocked = await withDb(async (c) => {
      const existing = await c.query('SELECT locked FROM months WHERE period = $1', [prior]);
      if (existing.rowCount === 0) {
        await c.query('INSERT INTO months (period, label, locked) VALUES ($1,$1,true)', [prior]);
      } else {
        await c.query('UPDATE months SET locked = true WHERE period = $1', [prior]);
      }
      await c.query(
        `INSERT INTO tasks (period, date, description, status, created_by)
         VALUES ($1,$2,$3,'To Do',$4)`,
        [prior, `${prior}-10`, description, await staffIdByEmail(c, ADMIN_EMAIL)],
      );
      return (existing.rows[0]?.locked as boolean | undefined) ?? false;
    });

    try {
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await openFreshBot(page);

      // Two tool rounds: find the task in that month, then act on it (ADR-018).
      await ask(page, `In ${prior}, mark the task "${description}" as Done.`);
      await expect(confirmButton(page)).toBeVisible({ timeout: BOT_TIMEOUT });
      await confirmButton(page).click();

      await expect(lastReply(page)).toHaveText(/is locked/i, { timeout: BOT_TIMEOUT });
      const status = await withDb(async (c) => {
        const { rows } = await c.query('SELECT status FROM tasks WHERE description = $1', [description]);
        return rows[0]?.status as string;
      });
      expect(status).toBe('To Do');
    } finally {
      await withDb(async (c) => {
        await c.query('UPDATE months SET locked = $2 WHERE period = $1', [prior, wasLocked]);
      });
    }
  });
});
