import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, test, expect } from 'vitest';

/**
 * Every form that carries a credential must declare method="post".
 *
 * A <form> with no method defaults to GET. If it is submitted before React hydrates
 * — slow network, a chunk that 404s, JS disabled — the browser performs a NATIVE
 * submit and serialises every field into the query string. This is not theoretical:
 * a broken production build during the Sprint 10 close-out produced
 *
 *   GET /login?email=e2e-admin%40test.skaly.in&password=E2eAdmin%212026-Skaly
 *
 * i.e. a live password written into browser history, the server access log, and any
 * Referer sent to a third party. POST keeps it in a body that simply 405s.
 *
 * Read from source rather than rendered, on purpose: the failure only happens when
 * React is NOT running, so no render-based test can observe it. This is the same
 * reason the notification and realtime census tests read source — a behavioural test
 * cannot see a property that only matters when the behaviour is absent.
 */
const CREDENTIAL_PAGES = [
  'login/page.tsx',
  'signup/page.tsx',
  'reset-password/page.tsx',
] as const;

describe('credential forms never default to GET', () => {
  test.each(CREDENTIAL_PAGES)('%s declares method="post"', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8');
    const forms = src.match(/<form[^>]*>/g) ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form, `${rel}: ${form}`).toMatch(/method="post"/);
    }
  });
});
