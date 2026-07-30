import { randomUUID } from 'node:crypto';

import { renderToBuffer } from '@react-pdf/renderer';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { currentIstPeriod } from '../../src/services/BaseService.js';
import { collectReportData } from '../../src/workers/report-data.js';
import { ReportDocument } from '../../src/workers/report-document.js';

import type { DB } from '@skaly/shared';

/**
 * The render, in-process and without a worker thread.
 *
 * Splitting it out this way is what makes the PDF testable at all: ReportService's
 * lifecycle tests fake the worker, so nothing there would notice if the document
 * threw. Here the real renderer runs against real rows.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
// DATE identity-parse, matching lib/db.ts — without it a calendar date shifts a
// day east of UTC on its way into the PDF.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const PERIOD = currentIstPeriod();
const DOMAIN = '@render.itest';
const staffId = randomUUID();
let clientId: string;

async function cleanup() {
  const mine = db.selectFrom('clients').select('id').where('name', 'like', 'RENDER-ITEST%');
  await db.deleteFrom('shoot_schedules').where('client_id', 'in', mine).execute();
  await db.deleteFrom('content_calendar').where('client_id', 'in', mine).execute();
  await db.deleteFrom('content_pipelines').where('client_id', 'in', mine).execute();
  await db.deleteFrom('clients').where('name', 'like', 'RENDER-ITEST%').execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values({ id: staffId, name: 'Render Freelancer', email: `f${DOMAIN}`, role: 'freelancer', active: true })
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();

  const client = await db
    .insertInto('clients')
    .values({ name: 'RENDER-ITEST Co', shoot_slots_per_month: 2, pieces_per_visit: 3, active: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  clientId = client.id;

  await db
    .insertInto('shoot_schedules')
    .values([
      { period: PERIOD, client_id: clientId, slot_index: 1, slot_status: 'Completed', slot_date: `${PERIOD}-08`, pieces_expected: 3, freelancer_id: staffId },
      { period: PERIOD, client_id: clientId, slot_index: 2, slot_status: 'Unset', pieces_expected: 3 },
    ])
    .execute();
  await db
    .insertInto('content_pipelines')
    .values({ period: PERIOD, client_id: clientId, visit_type: 'Shoot', last_shoot_date: `${PERIOD}-08`, version: 1 })
    .execute();
  await db
    .insertInto('content_calendar')
    .values([
      { period: PERIOD, client_id: clientId, date: `${PERIOD}-08`, status: 'Posted', version: 1 },
      { period: PERIOD, client_id: clientId, date: `${PERIOD}-09`, status: 'No Activity', version: 1 },
    ])
    .execute();
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

/** %PDF-1.x at byte 0 — the only structural claim worth making about the bytes. */
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

describe('the report document renders', () => {
  test('org_monthly produces a real PDF with the vendored fonts embedded', async () => {
    const data = await collectReportData({ type: 'org_monthly', period: PERIOD }, db);
    const buffer = await renderToBuffer(ReportDocument({ data, generatedAt: new Date() }));

    expect(isPdf(buffer)).toBe(true);
    expect(buffer.byteLength, 'a document with content, not an empty page').toBeGreaterThan(5_000);

    // If Font.register silently failed, react-pdf falls back to Helvetica and the
    // brand faces are absent from the font table — a PDF that renders fine and
    // looks nothing like the portal. Asserting on the embedded name catches it.
    const text = buffer.toString('latin1');
    expect(text).toMatch(/DMSans|DM.?Sans/);
    expect(text).toMatch(/BigShoulders|Big.?Shoulders/);
  }, 60_000);

  test('client_monthly renders the seeded slots, pipeline and calendar', async () => {
    const data = await collectReportData({ type: 'client_monthly', period: PERIOD, clientId }, db);
    expect(data.kind).toBe('client_monthly');
    if (data.kind !== 'client_monthly') throw new Error('unreachable');

    expect(data.clientName).toBe('RENDER-ITEST Co');
    expect(data.slots).toHaveLength(2);
    expect(data.slots[0]).toMatchObject({ index: 1, status: 'Completed', freelancer: 'Render Freelancer' });
    // The DATE stays the exact stored string — no timezone shift into the PDF.
    expect(data.slots[0]!.date).toBe(`${PERIOD}-08`);
    expect(data.pipeline?.visitType).toBe('Shoot');
    expect(data.calendar.find((c) => c.status === 'Posted')?.count).toBe(1);

    const buffer = await renderToBuffer(ReportDocument({ data, generatedAt: new Date() }));
    expect(isPdf(buffer)).toBe(true);
  }, 60_000);

  test('a period with no data renders rather than throwing', async () => {
    // The empty case is the one that reaches production first, on a fresh month.
    await db
      .insertInto('months')
      .values({ period: '2095-09', label: 'September 2095', locked: false })
      .onConflict((oc) => oc.column('period').doNothing())
      .execute();
    try {
      const data = await collectReportData({ type: 'org_monthly', period: '2095-09' }, db);
      expect(data.kind === 'org_monthly' && data.attendancePct, 'no rows means unknown, not 0%').toBeNull();
      const buffer = await renderToBuffer(ReportDocument({ data, generatedAt: new Date() }));
      expect(isPdf(buffer)).toBe(true);
    } finally {
      await db.deleteFrom('months').where('period', '=', '2095-09').execute();
    }
  }, 60_000);

  test('an unknown period is refused before any query runs', async () => {
    await expect(collectReportData({ type: 'org_monthly', period: '1990-01' }, db)).rejects.toMatchObject({
      code: 'PERIOD_NOT_FOUND',
    });
  });
});
