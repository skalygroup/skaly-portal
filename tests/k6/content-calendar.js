/**
 * k6 load test — GET /v1/content-calendar (12-TESTING-STRATEGY, NFR §1.2).
 *
 * Target: p95 < 300ms at 50 VUs for "GET module data". The calendar is the
 * heaviest of these reads — a full period is 31 days × N clients (the NFR states
 * the shape as 31×20), so it is the one worth gating on.
 *
 * Run against staging, or locally with the perf fixture seeded:
 *   pnpm --filter @skaly/api exec tsx scripts/seed-perf-clients.ts 20
 *
 *   K6_BASE_URL=http://localhost:3001 \
 *   K6_TOKEN="Bearer eyJ..." \
 *   k6 run tests/k6/content-calendar.js
 *
 * The token is a real Supabase access token for an admin/manager/team_member.
 * Grab one from a logged-in browser (Application → Local Storage) or from an
 * API call's Authorization header — never hardcode it here.
 *
 * k6 is not a repo dependency; install it separately (https://k6.io/docs).
 */
import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE = __ENV.K6_BASE_URL || 'http://localhost:3001';
const TOKEN = __ENV.K6_TOKEN || '';
const PERIOD =
  __ENV.K6_PERIOD ||
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(
    new Date(),
  );

export const options = {
  scenarios: {
    module_read: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 50 }, // ramp to the NFR's 50 VUs
        { duration: '1m', target: 50 }, // hold — this is the measured window
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // The gate. NFR §1.2 "GET module data" p95 < 300ms.
    'http_req_duration{endpoint:calendar}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE}/v1/content-calendar?period=${PERIOD}`, {
    headers: { Authorization: TOKEN },
    tags: { endpoint: 'calendar' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    // A 200 with an empty grid would pass a naive status check while measuring
    // nothing — assert the payload is actually the full period.
    'grid has cells': (r) => {
      if (r.status !== 200) return false;
      try {
        return (JSON.parse(r.body).data.cells || []).length > 0;
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
