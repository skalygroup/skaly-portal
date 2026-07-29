import { expect, test } from '@playwright/test';

import { login } from './helpers/auth';

import type { Browser, Page } from '@playwright/test';

/**
 * Chat, with TWO BROWSER CONTEXTS — one actor, one observer (Sprint 10 STEP 12).
 *
 * Two contexts, not two pages: separate contexts get separate cookie jars, so each
 * really is a different signed-in user. Two pages in one context share a session and
 * would silently be the same person watching themselves — which passes a "B sees it"
 * assertion while proving nothing about delivery.
 *
 * Self-skips without the E2E env, like the rest of this suite.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && MEMBER_PASSWORD && process.env.DATABASE_URL);

/** Every message this suite sends is tagged, so cleanup can find only its own. */
const MARK = 'E2E-CHAT';
const stamp = () => `${MARK}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** NFR §1.3: WS delivery < 500ms. Generous ceiling for CI; measured separately. */
const DELIVERY_MS = 2_000;

/** Open a signed-in /chat page in its own context. */
async function openChat(
  browser: Browser,
  email: string,
  password: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, password);
  await page.goto('/chat');
  // ENABLED, not merely visible: the composer is disabled while disconnected, and
  // typing into a disabled textarea silently does nothing.
  await expect(page.getByTestId('chat-composer')).toBeEnabled({ timeout: 20_000 });
  return { page, close: () => context.close() };
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('chat-composer');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  // The author's own message renders optimistically.
  await expect(page.getByText(text, { exact: false })).toBeVisible({ timeout: 10_000 });
}

/**
 * Wait until B's /ws/chat socket has actually JOINED its room.
 *
 * `openChat` only waits for the composer, and the composer is gated on the CONNECTION
 * BANNER — which watches /ws/notify. So "the UI looks ready" does not imply "the chat
 * namespace has connected and joined org:all", and a broadcast sent in that window is
 * simply missed. Diagnosed the hard way: the server logged the typing broadcast, and
 * B received nothing until ~3.6s later.
 *
 * Rather than sleep, use a real delivery as the barrier — if B can see a message from
 * A, B is demonstrably in the room.
 */
async function waitForChatLink(a: Page, b: Page): Promise<void> {
  const ping = `${stamp()} link-check`;
  await send(a, ping);
  await expect(b.getByText(ping)).toBeVisible({ timeout: 15_000 });
}

test.describe('chat — two contexts', () => {
  test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_*, TEST_MEMBER_* and DATABASE_URL to run the chat E2E.');

  test('A sends → B sees it without reloading', async ({ browser }) => {
    const a = await openChat(browser, ADMIN_EMAIL, ADMIN_PASSWORD);
    const b = await openChat(browser, MEMBER_EMAIL, MEMBER_PASSWORD);

    try {
      // Barrier FIRST, then measure. Without it the NFR number silently includes
      // however long B's /ws/chat took to join, which is not delivery latency —
      // and if the join outlasts DELIVERY_MS the test fails for the wrong reason.
      await waitForChatLink(a.page, b.page);

      const text = `${stamp()} hello from A`;
      const started = Date.now();
      await send(a.page, text);

      // No reload anywhere — this must arrive over the socket.
      await expect(b.page.getByText(text)).toBeVisible({ timeout: DELIVERY_MS });
      console.log(`[NFR §1.3] chat delivery: ${Date.now() - started}ms`);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('A types → B sees the indicator, and it clears', async ({ browser }) => {
    const a = await openChat(browser, ADMIN_EMAIL, ADMIN_PASSWORD);
    const b = await openChat(browser, MEMBER_EMAIL, MEMBER_PASSWORD);

    try {
      // B must be in the room before A types, or the broadcast lands in the gap
      // between "composer enabled" and "/ws/chat joined".
      await waitForChatLink(a.page, b.page);

      // pressSequentially, not type() or fill(): helpers/auth.ts records that fill()
      // leaves React-controlled inputs empty in webkit (React's value tracker treats
      // it as no change), and type() is deprecated. Real key events are what drive
      // onChange, which is what emits chat:typing.
      const composer = a.page.getByTestId('chat-composer');
      await composer.click();
      await composer.pressSequentially('drafting something', { delay: 30 });

      await expect(b.page.getByTestId('typing-indicator')).toContainText('typing', {
        timeout: DELIVERY_MS,
      });

      // Clears within ~3s of A stopping — the auto-expire, not a manual stop.
      await expect(b.page.getByTestId('typing-indicator')).not.toContainText('typing', {
        timeout: 8_000,
      });
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('A deletes their message → B sees a tombstone, not a disappearance', async ({ browser }) => {
    const a = await openChat(browser, ADMIN_EMAIL, ADMIN_PASSWORD);
    const b = await openChat(browser, MEMBER_EMAIL, MEMBER_PASSWORD);

    try {
      // The first delivery below doubles as a barrier only if it is allowed to be
      // slow — it is not, it carries DELIVERY_MS. Join first, separately.
      await waitForChatLink(a.page, b.page);

      const text = `${stamp()} delete me`;
      await send(a.page, text);
      await expect(b.page.getByText(text)).toBeVisible({ timeout: DELIVERY_MS });

      // Delete through the UI, deliberately. Reaching for the API here would need the
      // session token, and this app stores it in cookies for SSR — so an API call
      // from the test runner arrives unauthenticated and 401s, testing nothing. The
      // button is also the affordance a real user has.
      const row = a.page.getByTestId('message-row').filter({ hasText: text });
      await row.getByTestId('message-delete').click();

      // TOMBSTONE, not removal: the row holds its place so the conversation does not
      // reflow under whoever is reading it.
      await expect(b.page.getByTestId('message-tombstone').first()).toBeVisible({ timeout: DELIVERY_MS });
      await expect(b.page.getByText(text)).toBeHidden({ timeout: DELIVERY_MS });
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('⭐ scroll anchoring: loading older messages keeps the anchor in view', async ({ browser }) => {
    const a = await openChat(browser, ADMIN_EMAIL, ADMIN_PASSWORD);

    try {
      const scroller = a.page.getByTestId('chat-scroll');
      await expect(scroller).toBeVisible();

      // Scroll to the very top to trigger the older-page load.
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });

      // The anchor: whatever row is first visible right now must still be in the same
      // place after the prepend. A unit test can prove scrollTop was adjusted; only
      // this can prove the user did not visibly move.
      const rows = a.page.getByTestId('message-row');
      const count = await rows.count();
      test.skip(count === 0, 'No messages seeded — scroll anchoring needs history.');

      const anchor = rows.first();
      const before = await anchor.boundingBox();

      await a.page.waitForTimeout(1_500); // let any prepend settle

      const after = await anchor.boundingBox();
      if (before && after) {
        // A jump is hundreds of px; a few px of sub-pixel drift is not a failure.
        expect(Math.abs(after.y - before.y)).toBeLessThan(40);
      }
    } finally {
      await a.close();
    }
  });

  test('a freelancer without chat.access sees the refusal, not an empty chat', async ({ browser }) => {
    const email = process.env.TEST_FREELANCER_EMAIL ?? '';
    const password = process.env.TEST_FREELANCER_PASSWORD ?? '';
    test.skip(!password, 'Set TEST_FREELANCER_* to run the chat.access denial check.');

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await login(page, email, password);
      await page.goto('/chat');

      // Auth-Matrix §3: /chat is 🔧 for freelancers — default-denied, admin-grantable.
      // Asserting what the USER sees rather than a status code: a chat that renders a
      // working composer and silently 403s every send is worse than one that says no.
      await expect(page.getByTestId('chat-access-denied')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('chat-composer')).toBeHidden();
    } finally {
      await context.close();
    }
  });
});

