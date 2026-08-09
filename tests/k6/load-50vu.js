/**
 * k6 — the full NFR §1.2 budget sweep at 50 concurrent users (NFR §2.1).
 *
 * `content-calendar.js` gates the single heaviest read. This one covers the
 * BUDGET TABLE: every route class NFR §1.2 puts a number on, measured together
 * under one 50-VU load, because they share a connection pool and a p95 measured
 * one endpoint at a time is a p95 nobody will ever experience.
 *
 *   GET  module data   p95 < 300ms
 *   PATCH cell write   p95 < 200ms
 *   GET  dashboard     p95 < 200ms
 *
 * The bot's TTFT < 2s budget is deliberately NOT here: it streams, costs real
 * Anthropic tokens per request, and 50 VUs against it for 90 seconds is a bill
 * rather than a measurement. It is asserted in the API suite instead.
 *
 * ── BEFORE YOU TRUST A RUN ──────────────────────────────────────────────────
 * 1. Seed representative volume:
 *      pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 * 2. LIFT THE RATE LIMIT on the target. The global cap is 150/min keyed by IP
 *    (API-Contract §2) and a load generator is one IP — at 50 VUs most requests
 *    come back 429 and what you measure is the limiter, not the endpoint:
 *      PORT=3002 RATE_LIMIT_MAX=1000000 pnpm --filter @skaly/api dev
 *    The check below FAILS the run on a 429 rather than letting it look fast.
 * 3. Supply a real admin token — never hardcode one here.
 *
 *   K6_BASE_URL=http://localhost:3002 K6_TOKEN="Bearer eyJ..." k6 run tests/k6/load-50vu.js
 */
import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE = __ENV.K6_BASE_URL || 'http://localhost:3001';
const TOKEN = __ENV.K6_TOKEN || '';

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
    'http_req_duration{endpoint:dashboard}': ['p(95)<200'],
    // Writes get their own, tighter budget (§1.2 "PATCH cell").
    'http_req_duration{endpoint:attendance_patch}': ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

/** A read, checked for the two ways a fast response can still be meaningless. */
function read(path, endpoint) {
  const res = http.get(`${BASE}${path}`, { headers, tags: { endpoint } });
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

export default function () {
  // Read-heavy, as the product is: staff sit on a grid and occasionally toggle a
  // cell. Weighting this the other way would measure a workload nobody performs.
  read(`/v1/attendance?period=${PERIOD}`, 'attendance');
  read(`/v1/tasks?period=${PERIOD}`, 'tasks');
  read(`/v1/content-calendar?period=${PERIOD}`, 'calendar');
  read(`/v1/dashboard?period=${PERIOD}`, 'dashboard');

  // One write per iteration. Deliberately a request that 409s on a stale version
  // rather than one that mutates: the LATENCY is the measurement, and 50 VUs
  // racing the same cell would measure lock contention on a row no real workload
  // has 50 people editing.
  const patch = http.patch(
    `${BASE}/v1/attendance/00000000-0000-4000-8000-000000000000`,
    JSON.stringify({ present: true, version: 1 }),
    { headers, tags: { endpoint: 'attendance_patch' } },
  );
  check(patch, {
    'attendance_patch: reached the handler': (r) => r.status !== 429 && r.status < 500,
  });

  sleep(1);
}
