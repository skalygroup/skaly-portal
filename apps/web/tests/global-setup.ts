/**
 * Refuse to run against an API that will lie to us. (Sprint 10.1 STEP 1 — audit A3)
 *
 * The Sprint 10 close-out produced a full-suite number taken against an API whose
 * rate limit had silently reverted to the 150/min default. That run's failures could
 * not afterwards be separated from CPU load, because both were present — so a
 * plausible-looking result had to be thrown away.
 *
 * The reversion is easy and invisible. `reuseExistingServer: !process.env.CI` means
 * Playwright applies its `env` block ONLY to a server it starts itself; any API
 * already listening on :3001 keeps whatever limit it booted with, while
 * playwright.config.ts still reads as correct.
 *
 * ⚠️ THIS THROWS. A warning in a long Playwright preamble is invisible, and the goal
 * is to make a misconfigured run impossible rather than merely discouraged. A suite
 * that refuses to start costs a minute; a suite that produces a confident wrong
 * number costs an afternoon — that is the trade this file exists to make.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * "Raised", not "equal to 100000".
 *
 * Asserting the exact value would couple this to one config line and fail the moment
 * anyone tunes it. What matters is that the suite is not sharing the production-shaped
 * 150/min bucket across every request it makes.
 */
const MIN_RATE_LIMIT = 10_000;

interface HealthPayload {
  status?: string;
  services?: {
    database?: { ok?: boolean };
    redis?: { ok?: boolean };
  };
}

export default async function globalSetup(): Promise<void> {
  const url = `${API_BASE}/v1/health`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(
      `[e2e] The API is not reachable at ${url}.\n` +
        `        Start it, or let Playwright start it, before running the suite.\n` +
        `        Cause: ${(cause as Error).message}`,
    );
  }

  // ── The rate limit ────────────────────────────────────────────────────────
  const header = res.headers.get('x-ratelimit-limit');
  const limit = header === null ? null : Number(header);

  if (limit === null || Number.isNaN(limit)) {
    throw new Error(
      `[e2e] ${url} returned no x-ratelimit-limit header.\n` +
        `        The suite cannot confirm it is running against a raised rate limit,\n` +
        `        and audit A1 showed a 429 reaches tests as "Could not load your\n` +
        `        profile" or a login timeout — never as a rate-limit error.\n` +
        `        Fix: ensure @fastify/rate-limit is registered with addHeaders.`,
    );
  }

  if (limit < MIN_RATE_LIMIT) {
    throw new Error(
      `[e2e] The API's rate limit is ${limit}, below the required ${MIN_RATE_LIMIT}.\n` +
        `        Likely cause: an API started OUTSIDE Playwright is being reused.\n` +
        `        \`reuseExistingServer\` means the env block in playwright.config.ts\n` +
        `        never reached it, so it booted with the default limit.\n` +
        `        Fix: kill anything listening on :3001 and re-run.\n` +
        `             PowerShell: Get-NetTCPConnection -LocalPort 3001 -State Listen |\n` +
        `                         Select -Expand OwningProcess | ForEach { Stop-Process -Id $_ -Force }\n` +
        `        Why this throws: a suite-wide 429 does not look like a 429. It looks\n` +
        `        like broken auth, and it already cost two wrong diagnoses.`,
    );
  }

  // ── The dependencies ──────────────────────────────────────────────────────
  // Ruled out by hand mid-run during the audit; doing it here means the suite
  // never again spends a 15-minute run proving Redis was up.
  const health = (await res.json().catch(() => ({}))) as HealthPayload;
  const dbOk = health.services?.database?.ok === true;
  const redisOk = health.services?.redis?.ok === true;

  if (!dbOk || !redisOk) {
    throw new Error(
      `[e2e] The API is up but a dependency is not.\n` +
        `        Postgres: ${dbOk ? 'ok' : 'DOWN'}   Redis: ${redisOk ? 'ok' : 'DOWN'}\n` +
        `        Socket delivery needs Redis; every grid needs Postgres. Running now\n` +
        `        would produce failures that look like product bugs.\n` +
        `        Fix: docker compose up -d`,
    );
  }

  // Recorded on every run, so any archived output says what it actually ran against.
  console.log(
    `[e2e] API ${API_BASE} · rate limit ${limit} · postgres ok · redis ok · ` +
      `status ${health.status ?? 'unknown'}`,
  );

  await assertPerUserBuckets();
}

/**
 * The per-user key is LIVE, not merely configured (ADR-024).
 *
 * Two anonymous callers from addresses the API can tell apart must not share a
 * bucket. If the limiter ever regresses to a single shared key — the exact shape of
 * audit A1 — these two counters move together, and this throws before a single spec
 * runs.
 *
 * Deliberately unauthenticated: minting two real Supabase sessions here would make
 * every run depend on the auth backend just to check a limiter. The API-side
 * `rate-limit-keying.test.ts` covers the authenticated half against `buildApp()`,
 * where it can mock the verifier; this is the end-to-end smoke that the deployed
 * process is keying per caller at all.
 */
async function assertPerUserBuckets(): Promise<void> {
  const remainingFor = async (forwardedFor: string): Promise<number | null> => {
    const res = await fetch(`${API_BASE}/v1/health`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });
    const v = res.headers.get('x-ratelimit-remaining');
    return v === null ? null : Number(v);
  };

  const a1 = await remainingFor('203.0.113.10');
  const a2 = await remainingFor('203.0.113.10');
  const b1 = await remainingFor('203.0.113.20');

  if (a1 === null || a2 === null || b1 === null) return; // headers already asserted above

  // A's own bucket counts down, and B's is untouched by A's two calls.
  if (a2 < a1 && b1 <= a2) {
    throw new Error(
      `[e2e] The rate limiter appears to share ONE bucket across callers.\n` +
        `        caller A: ${a1} → ${a2}   caller B: ${b1} (expected > ${a2})\n` +
        `        This is audit A1: with a single shared bucket the whole org throttles\n` +
        `        together, and a 429 reaches the UI as "Could not load your profile".\n` +
        `        Check ADR-024 — most likely the limiter is back on the default\n` +
        `        onRequest hook, where request.user is unset and the key falls back to IP.`,
    );
  }
}
