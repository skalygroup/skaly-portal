import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';

import { login } from './helpers/auth';

/**
 * E2E smoke: Content Dropper (Sprint 6 STEP 8) — stage sequence (RAW → Finals →
 * Posted + Trigger-2 toast), the client-side sequence violation (shake, no
 * request) + the server 400, and admin/manager-only access (team_member 403).
 *
 * NOTE: the guide names this tests/e2e/content-dropper.spec.ts, but the
 * Playwright config's testDir is ./tests (Sprint 1 convention), so it lives here
 * — same as tests/shoot-planner.spec.ts. Runs on chromium and webkit.
 *
 * NOTE: this repo has no portal sidebar nav yet (the (portal) layout renders
 * children directly), so "absent from the sidebar" is verified via the frontend
 * access-denied state a team_member sees on /content-dropper, plus the real 403
 * API gate.
 *
 * Needs a live web app + API + Supabase test project. Configure via env:
 *   E2E_BASE_URL          web origin (default http://localhost:3000)
 *   NEXT_PUBLIC_API_URL   API origin (default http://localhost:3001)
 *   DATABASE_URL          API Postgres — picks/restores pipelines
 *   TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD    an admin
 *   TEST_MEMBER_EMAIL / TEST_MEMBER_PASSWORD  a team_member (the access test)
 *
 * Without the admin creds + DATABASE_URL the describe self-skips; the access
 * test additionally skips without the member creds (same pattern as the other
 * live specs). Re-runnable: touched pipelines are reset (stages cleared, version
 * back to 1) in afterEach.
 */
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? '';
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? '';
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? '';
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const FLOW_ENABLED = Boolean(ADMIN_PASSWORD && process.env.DATABASE_URL);

function currentIstPeriod(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date());
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

// login() comes from tests/helpers/auth — this spec's own copy used fill(),
// which leaves the inputs empty in webkit and failed all three cases there.

/** The Bearer token the browser sends — captured from the first /v1 API call. */
async function captureApiToken(page: Page): Promise<string> {
  const req = await page.waitForRequest(
    (r) => r.url().includes('/v1/') && Boolean(r.headers()['authorization']),
    { timeout: 15_000 },
  );
  return req.headers()['authorization']!;
}

interface PipelineRef {
  id: string;
  clientId: string;
  clientName: string;
}

/** Fresh (no stage set) pipelines for the current period, active non-internal, by client name. */
async function pickFreshPipelines(c: Client, count: number): Promise<PipelineRef[]> {
  const { rows } = await c.query(
    `SELECT p.id, p.client_id AS "clientId", cl.name AS "clientName"
     FROM content_pipelines p
     JOIN clients cl ON cl.id = p.client_id
     WHERE p.period = $1
       AND p.raw_received_at IS NULL AND p.finals_ready_at IS NULL AND p.posted_at IS NULL
       AND cl.active AND NOT cl.is_internal AND cl.deleted_at IS NULL
     ORDER BY cl.name`,
    [PERIOD],
  );
  return (rows as PipelineRef[]).slice(0, count);
}

// Pipelines this run mutated — reset in afterEach.
const touched: string[] = [];

async function cleanup() {
  await withDb(async (c) => {
    if (touched.length > 0) {
      await c.query(
        `UPDATE content_pipelines
         SET raw_received_at = NULL, finals_ready_at = NULL, posted_at = NULL, updated_by = NULL, version = 1
         WHERE id = ANY($1::uuid[])`,
        [touched],
      );
      touched.length = 0;
    }
  });
}

test.describe('content dropper — live smoke', () => {
  test.beforeEach(() => {
    test.skip(!FLOW_ENABLED, 'Set TEST_ADMIN_* and DATABASE_URL to run the content-dropper smoke.');
  });
  test.afterEach(async () => {
    if (FLOW_ENABLED) await cleanup();
  });

  test('sequence: mark RAW → Finals → Posted (progress + Trigger-2 toast)', async ({ page }) => {
    const [p] = await withDb((c) => pickFreshPipelines(c, 1));
    if (!p) return test.skip(); // no fresh pipeline in the current period
    touched.push(p.id);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/content-dropper?period=${PERIOD}`);

    const row = page.getByTestId(`pipeline-row-${p.clientId}`);
    const fill = row.getByTestId('progress-fill');

    /**
     * Mark one stage and WAIT FOR THE SERVER, not just the optimistic paint.
     *
     * Each PATCH carries the row's `version`, and only onSuccess writes the returned
     * row back into the cache — so the next stage cannot be sent until this one has
     * answered. Asserting the filled cell in between is not enough: onMutate paints it
     * immediately, so every assertion here passes while the request is still in
     * flight. Clicking on that basis sent a stale version, the API replied 409, the
     * optimistic write was reverted, and the run ended with only RAW marked and no
     * toast — reported as "the Trigger-2 toast is missing", which is the one thing
     * that was not actually broken.
     */
    const clientId = p.clientId;
    const markStage = async (stage: 'raw' | 'finals' | 'posted') => {
      const settled = page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && /\/content-dropper\/.+\/stage/.test(r.url()),
      );
      await page.getByTestId(`stage-${stage}-${clientId}-mark`).click();
      expect((await settled).status()).toBe(200);
    };

    // RAW → filled + status Editing + progress ~33%.
    await markStage('raw');
    await expect(page.getByTestId(`stage-raw-${p.clientId}-filled`)).toBeVisible();
    await expect(row.getByText('Editing')).toBeVisible();
    await expect(fill).toHaveAttribute('style', /width:\s*33/);

    // Finals → advances to ~66% + status Review.
    await markStage('finals');
    await expect(page.getByTestId(`stage-finals-${p.clientId}-filled`)).toBeVisible();
    await expect(row.getByText('Review')).toBeVisible();
    await expect(fill).toHaveAttribute('style', /width:\s*66/);

    // Posted → 100% + Posted chip + the Trigger-2 toast.
    await markStage('posted');
    // The toast is asserted FIRST because it is the only assertion here with an
    // expiry: sonner dismisses it after a few seconds, while the cell, the chip and
    // the progress bar are permanent. Asserting it last meant three slower checks ran
    // first and the toast had already gone — a pass that depended on the app being
    // slow, which stopped being true once the suite served a production build.
    await expect(page.getByText(/Content Calendar updated/i)).toBeVisible();
    await expect(page.getByTestId(`stage-posted-${p.clientId}-filled`)).toBeVisible();
    await expect(row.getByText('Posted')).toBeVisible();
    await expect(fill).toHaveAttribute('style', /width:\s*100%/);
  });

  test('violation: Finals with no RAW shakes with no request; server 400s the direct skip', async ({ page }) => {
    const picked = await withDb(async (c) => {
      const [fresh, rawOnly] = await pickFreshPipelines(c, 2);
      if (!fresh || !rawOnly) return null;
      // Seed the 2nd pipeline RAW-only (server-side) for the direct-PATCH check.
      await c.query(`UPDATE content_pipelines SET raw_received_at = now() WHERE id = $1`, [rawOnly.id]);
      return { fresh, rawOnly };
    });
    if (!picked) return test.skip(); // need 2 fresh pipelines
    touched.push(picked.fresh.id, picked.rawOnly.id);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const tokenPromise = captureApiToken(page);
    await page.goto(`/content-dropper?period=${PERIOD}`);
    const token = await tokenPromise;

    // Client-side pre-check: clicking Finals with no RAW → toast + NO stage PATCH.
    const patches: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/content-dropper\/.+\/stage/.test(r.url())) patches.push(r.url());
    });
    await page.getByTestId(`stage-finals-${picked.fresh.clientId}-mark`).click();
    await expect(page.getByText('Mark RAW first')).toBeVisible();
    await page.waitForTimeout(500);
    expect(patches).toHaveLength(0);
    // The cell was NOT filled.
    await expect(page.getByTestId(`stage-finals-${picked.fresh.clientId}-mark`)).toBeVisible();

    // Server is the real gate: a direct skip (posted on a raw-only pipeline) → 400.
    const res = await page.request.patch(`${API_BASE}/v1/content-dropper/${picked.rawOnly.id}/stage`, {
      headers: { authorization: token },
      data: { stage: 'posted', version: 1 },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STAGE_SEQUENCE_VIOLATION');
  });

  test('access: team_member GET → 403 and sees the access-denied state (no nav entry)', async ({ page }) => {
    test.skip(!MEMBER_PASSWORD, 'Set TEST_MEMBER_* to run the team_member access check.');

    await login(page, MEMBER_EMAIL, MEMBER_PASSWORD);
    const tokenPromise = captureApiToken(page);
    await page.goto(`/content-dropper?period=${PERIOD}`);
    const token = await tokenPromise;

    // The real gate: direct GET with a team_member token → 403.
    const res = await page.request.get(`${API_BASE}/v1/content-dropper?period=${PERIOD}`, {
      headers: { authorization: token },
    });
    expect(res.status()).toBe(403);

    // Frontend: no pipeline grid; the access-denied message is shown.
    await expect(page.getByText('You do not have access to the Content Dropper.')).toBeVisible();
    await expect(page.getByRole('grid')).toHaveCount(0);
  });
});
