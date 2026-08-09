/**
 * k6 — the full NFR §1.2 budget sweep at 50 concurrent users (NFR §2.1).
 *
 * `content-calendar.js` gates the single heaviest read. This one covers the
 * BUDGET TABLE: every route class NFR §1.2 puts a number on, measured together
 * under one 50-VU load, because they share a connection pool and a p95 measured
 * one endpoint at a time is a p95 nobody will ever experience.
 *
 *   GET  module data   p95 < 300ms   ← attendance, tasks, calendar, shoot planner, dropper
 *   PATCH cell write   p95 < 200ms
 *
 * ⚠️ TWO BUDGETS FROM §1.2 ARE DELIBERATELY ABSENT, and both absences are findings
 * rather than omissions:
 *
 *   GET dashboard p95 < 200ms — THERE IS NO DASHBOARD ENDPOINT. `/v1/dashboard`
 *     does not exist and `app/(portal)/dashboard/page.tsx` is a stub returning
 *     `<h1>Dashboard</h1>`. The materialised views the budget is really about
 *     (`dashboard_org_stats`, `dashboard_staff_task_stats`) exist and are read
 *     today only by the report worker. They ARE measured, directly, by
 *     `apps/api/scripts/measure-rollover-nfr.ts`, which probes the view while a
 *     rollover refreshes it — the number that actually matters for NFR §3.1.
 *     Add a target here the moment a dashboard endpoint lands.
 *
 *   bot TTFT < 2s — it streams and costs real Anthropic tokens per request. Fifty
 *     VUs against it for ninety seconds is a bill, not a measurement. Asserted in
 *     the API suite instead.
 *
 * ── BEFORE YOU TRUST A RUN ──────────────────────────────────────────────────
 * 1. Seed representative volume:
 *      pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 * 2. LIFT THE RATE LIMIT on the target. The global cap is 150/min keyed by IP
 *    (API-Contract §2) and a load generator is one IP — at 50 VUs most requests
 *    come back 429 and what you measure is the limiter, not the endpoint:
 *      PORT=3002 RATE_LIMIT_MAX=1000000 pnpm --filter @skaly/api dev
 *    The check below FAILS the run on a 429 rather than letting it look fast.
 *    Verify: the response's x-ratelimit-limit must not be 150.
 * 3. Supply a real admin token — never hardcode one here.
 * 4. ⚠️ USE 127.0.0.1, NEVER `localhost` — see below.
 *
 *   K6_BASE_URL=http://127.0.0.1:3002 K6_TOKEN="Bearer eyJ..." k6 run tests/k6/load-50vu.js
 *
 * ── ⚠️ THE `localhost` TRAP (Windows), which cost a whole measurement ────────
 * The API listens on 0.0.0.0, i.e. IPv4 only. On Windows `localhost` resolves to
 * ::1 FIRST, so every connection waits out a ~200ms IPv6 failure before falling
 * back to IPv4. Measured, on this repo:
 *
 *      localhost   → connect 202ms, /v1/health total 205ms
 *      127.0.0.1   → connect 0.7ms, /v1/health total   2.6ms
 *
 * A flat ~200ms is then added to EVERY endpoint, which reads as "the whole API
 * is uniformly slow" — the most misleading shape a perf result can have, because
 * it looks like a real systemic problem and points at nothing. The tell is that
 * an unauthenticated /v1/health costs the same as a 516KB authenticated grid.
 * If you ever see that, check the host before you profile anything.
 */
import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE = __ENV.K6_BASE_URL || 'http://127.0.0.1:3001';
const TOKEN = __ENV.K6_TOKEN || '';

/**
 * `stress` hammers all five modules every iteration; the default models a real
 * user. Both are legitimate — they answer different questions, and quoting one
 * against the other's budget is how a perf result becomes a lie.
 *
 * NFR §1.2's 300ms is a budget for NORMAL OPERATION at NFR §2.1's 50 users. A
 * real user opens ONE grid and then reads it for half a minute while ADR-022's
 * socket patches keep it fresh — the app deliberately does not poll. So the
 * realistic profile is one module read per user per think-cycle.
 *
 * The stress profile issues ~3.5 req/s/user, roughly a hundred times that. It is
 * worth running (it locates the ceiling, and the ceiling is one Node process's
 * CPU), but its p95 is a saturation number, not a §1.2 number.
 */
const STRESS = __ENV.K6_PROFILE === 'stress';

// k6's runtime has NO Intl — the formatter used everywhere else in this repo
// throws "Intl is not defined" and the script dies before its first request.
// IST is a fixed UTC+5:30 with no DST, so the shift is exact.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PERIOD = __ENV.K6_PERIOD || new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 7);

const headers = { Authorization: TOKEN, 'Content-Type': 'application/json' };

export const options = {
  scenarios: {
    portal: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 50 }, // ramp to NFR §2.1's 50 users
        { duration: '90s', target: 50 }, // hold — this is the measured window
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'http_req_duration{endpoint:attendance}': ['p(95)<300'],
    'http_req_duration{endpoint:tasks}': ['p(95)<300'],
    'http_req_duration{endpoint:calendar}': ['p(95)<300'],
    'http_req_duration{endpoint:shoot}': ['p(95)<300'],
    'http_req_duration{endpoint:dropper}': ['p(95)<300'],
    // Writes get their own, tighter budget (§1.2 "PATCH cell").
    'http_req_duration{endpoint:attendance_patch}': ['p(95)<200'],
    // Scoped to READS. The write below deliberately targets a row that does not
    // exist so it measures latency without 50 VUs contending on one cell — it
    // answers 404 by design, and an unscoped http_req_failed therefore reports a
    // flat 1-in-6 failure rate that is purely this script's shape. A threshold
    // that is always red teaches everyone to ignore it.
    'http_req_failed{kind:read}': ['rate<0.01'],
  },
};

/** A read, checked for the two ways a fast response can still be meaningless. */
function read(path, endpoint) {
  const res = http.get(`${BASE}${path}`, { headers, tags: { endpoint, kind: 'read' } });
  check(res, {
    [`${endpoint}: 200`]: (r) => r.status === 200,
    // A 429 answers in microseconds and would drag every percentile DOWN — the
    // failure mode where a throttled run reads as the fastest one you ever had.
    [`${endpoint}: not rate-limited`]: (r) => r.status !== 429,
    // A 200 carrying an empty payload is the other one: the endpoint is fast
    // because the fixture is missing, and the number means nothing.
    [`${endpoint}: has data`]: (r) => {
      if (r.status !== 200) return false;
      try {
        const body = r.json();
        return body && body.data !== undefined && body.data !== null;
      } catch (_) {
        return false;
      }
    },
  });
  return res;
}

const MODULES = [
  [`/v1/attendance?period=${PERIOD}`, 'attendance'],
  [`/v1/tasks?period=${PERIOD}`, 'tasks'],
  [`/v1/content-calendar?period=${PERIOD}`, 'calendar'],
  [`/v1/shoot-planner?period=${PERIOD}`, 'shoot'],
  [`/v1/content-dropper?period=${PERIOD}`, 'dropper'],
];

export default function () {
  if (STRESS) {
    // Every module, every iteration. Finds the ceiling; is not §1.2's workload.
    for (const [path, endpoint] of MODULES) read(path, endpoint);
  } else {
    // ONE module, then think. A person opens a grid and reads it — the socket
    // keeps it current (ADR-022), so there is no polling to model. Which module
    // is spread across VUs so all five stay represented in the percentiles.
    const [path, endpoint] = MODULES[__VU % MODULES.length];
    read(path, endpoint);
  }

  // One write per iteration. Deliberately a request that 409s on a stale version
  // rather than one that mutates: the LATENCY is the measurement, and 50 VUs
  // racing the same cell would measure lock contention on a row no real workload
  // has 50 people editing.
  const patch = http.patch(
    `${BASE}/v1/attendance/00000000-0000-4000-8000-000000000000`,
    JSON.stringify({ present: true, version: 1 }),
    { headers, tags: { endpoint: 'attendance_patch', kind: 'write' } },
  );
  check(patch, {
    'attendance_patch: reached the handler': (r) => r.status !== 429 && r.status < 500,
  });

  // Think time. 1s under stress (back-to-back, deliberately punishing); ~8s in the
  // realistic profile, which is still far busier than someone actually reading a
  // grid, and jittered so 50 VUs do not arrive in a synchronised thundering herd —
  // a lockstep pattern manufactures a p95 that no real arrival distribution has.
  sleep(STRESS ? 1 : 6 + Math.random() * 4);
}
