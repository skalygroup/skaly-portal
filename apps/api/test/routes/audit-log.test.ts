import { randomUUID } from 'node:crypto';

import { parse } from 'csv-parse/sync';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AppError } from '../../src/lib/errors.js';
import { requireRole } from '../../src/middleware/auth.plugin.js';
import auditLogRoutes from '../../src/routes/audit-log/index.js';

import type { AuthUser } from '../../src/lib/auth-verify.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * The audit log panel's API and the streaming export (Sprint 11 STEP 5, ADR-028).
 *
 * Two assertions here are the reason the ADR exists rather than a paginated
 * export: the response carries NO Content-Length and arrives in multiple chunks,
 * and 10k rows leave through it without the heap growing with the row count.
 * Both need a real listening server — `app.inject` buffers the body, so it cannot
 * tell a stream from an array that was JSON.stringify'd very quickly.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
// The cursor mirrors lib/db.ts — without it .stream() throws at runtime (ADR-028).
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool, cursor: Cursor }) });

const DOMAIN = '@auditq.itest';
const TABLE = 'auditq_itest';
const OTHER_TABLE = 'auditq_other';
const BULK_TABLE = 'auditq_bulk';

const adminId = randomUUID();
const managerId = randomUUID();
const memberId = randomUUID();
const actorBId = randomUUID();

let asUser: AuthUser;
let app: FastifyInstance;
let baseUrl: string;

function authUser(role: Role, id?: string): AuthUser {
  return {
    id: id ?? adminId,
    supabase_uid: randomUUID(),
    name: role,
    email: `${role}${DOMAIN}`,
    role,
    active: true,
    mfa_enrolled: false,
    avatar_url: null,
  };
}

/**
 * Insert straight into audit_log rather than through AuditService: this suite is
 * about reading, and it needs controlled `created_at` values that only a direct
 * write can set. `skaly_app` cannot UPDATE or DELETE these rows (migration 026),
 * but the test connection is the owner, so cleanup works.
 */
async function seed(rows: Array<Partial<Record<string, unknown>> & { createdAt: Date }>) {
  for (const r of rows) {
    await sql`
      INSERT INTO audit_log
        (staff_id, changed_by_source, table_name, action, record_id, old_value, new_value, ip_address, created_at)
      VALUES (
        ${(r.staffId as string) ?? adminId},
        ${(r.source as string) ?? 'user'},
        ${(r.tableName as string) ?? TABLE},
        ${(r.action as string) ?? 'UPDATE'},
        ${(r.recordId as string) ?? null}::uuid,
        ${r.oldValue ? JSON.stringify(r.oldValue) : null}::jsonb,
        ${r.newValue ? JSON.stringify(r.newValue) : null}::jsonb,
        ${(r.ip as string) ?? null}::inet,
        ${r.createdAt}
      )
    `.execute(db);
  }
}

async function cleanup() {
  // Every table this suite writes — audit_log.staff_id is a FK, so a row left
  // behind by a crashed run blocks the staff delete below and the failure names
  // 'staff' rather than the audit row actually holding it.
  await db.deleteFrom('audit_log').where('table_name', 'in', [TABLE, OTHER_TABLE, BULK_TABLE]).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values([
      { id: adminId, name: 'Audit Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: managerId, name: 'Audit Manager', email: `manager${DOMAIN}`, role: 'manager', active: true },
      { id: memberId, name: 'Audit Member', email: `team_member${DOMAIN}`, role: 'team_member', active: true },
      { id: actorBId, name: 'Second Actor', email: `freelancer${DOMAIN}`, role: 'freelancer', active: true },
    ])
    .execute();

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  app.decorate('db', db);
  app.decorate('verifyJwt', async (req: { user?: AuthUser }) => {
    req.user = asUser;
  });
  app.decorate('requireRole', requireRole);
  await app.register(auditLogRoutes, { prefix: '/v1' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await cleanup();
  await db.destroy();
});

const at = (iso: string) => new Date(iso);

describe('GET /v1/audit-log — access', () => {
  test.each(['manager', 'team_member', 'freelancer'] as Role[])('%s → 403 on both routes', async (role) => {
    asUser = authUser(role, role === 'manager' ? managerId : memberId);
    for (const url of ['/v1/audit-log', '/v1/audit-log/export']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
    }
  });

  test('there are no mutation routes at all', async () => {
    asUser = authUser('admin');
    // audit_log is append-only at the DB role level (migration 026 REVOKEs UPDATE
    // and DELETE). A route offering an edit could only ever fail, so the surface
    // must not have one.
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/audit-log' });
      expect(res.statusCode, method).toBe(404);
    }
  });
});

describe('filters compose, and the same predicate feeds both sinks', () => {
  beforeAll(async () => {
    await seed([
      { createdAt: at('2093-01-10T06:00:00Z'), staffId: adminId, tableName: TABLE, action: 'INSERT' },
      { createdAt: at('2093-01-11T06:00:00Z'), staffId: actorBId, tableName: TABLE, action: 'UPDATE' },
      { createdAt: at('2093-01-12T06:00:00Z'), staffId: adminId, tableName: OTHER_TABLE, action: 'UPDATE' },
      { createdAt: at('2093-02-05T06:00:00Z'), staffId: adminId, tableName: TABLE, action: 'UPDATE' },
      { createdAt: at('2093-02-06T06:00:00Z'), staffId: adminId, tableName: TABLE, action: 'DELETE', source: 'bot' },
    ]);
  });

  async function ids(qs: string) {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'GET', url: `/v1/audit-log?${qs}` });
    expect(res.statusCode, res.payload).toBe(200);
    return JSON.parse(res.payload).data as Array<{ id: string; tableName: string; createdAt: string }>;
  }

  test('date range + actor + table compose with AND', async () => {
    const rows = await ids(
      `from=2093-01-01&to=2093-02-01&staffId=${adminId}&tableName=${TABLE}`,
    );
    // Only the 10 Jan INSERT satisfies all three: 11 Jan is a different actor,
    // 12 Jan a different table, and February is outside the range.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt.startsWith('2093-01-10')).toBe(true);
  });

  test('the `to` bound includes the whole IST day', async () => {
    // 12 Jan 06:00Z is 11:30 IST. A naive `<= to` on a date would drop it.
    const rows = await ids(`from=2093-01-12&to=2093-01-13&tableName=${OTHER_TABLE}`);
    expect(rows).toHaveLength(1);
  });

  test('action and source filter independently', async () => {
    expect(await ids(`tableName=${TABLE}&action=DELETE`)).toHaveLength(1);
    expect(await ids(`tableName=${TABLE}&changedBySource=bot`)).toHaveLength(1);
    expect(await ids(`tableName=${TABLE}&changedBySource=system`)).toHaveLength(0);
  });

  test('⭐ the export returns exactly the rows the list returned', async () => {
    const qs = `from=2093-01-01&to=2093-03-01&tableName=${TABLE}`;
    const listed = await ids(qs);

    asUser = authUser('admin');
    const res = await fetch(`${baseUrl}/v1/audit-log/export?${qs}`);
    const csv = parse(await res.text(), { columns: true }) as Array<Record<string, string>>;

    // ADR-028 §3. An export that disagrees with the table it came from is worse
    // than no export, and two hand-maintained filter chains is how that happens.
    expect(csv).toHaveLength(listed.length);
    expect(csv.map((r) => r.Table)).toEqual(listed.map(() => TABLE));
  });
});

describe('keyset pagination', () => {
  const KEYSET_TABLE = TABLE;

  test('walks every row exactly once, with no duplicates and no gaps', async () => {
    asUser = authUser('admin');
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string = `/v1/audit-log?tableName=${KEYSET_TABLE}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, res.payload).toBe(200);
      const body = JSON.parse(res.payload) as { data: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.data.map((d) => d.id));
      cursor = body.nextCursor;
    } while (cursor);

    const total = await db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('table_name', '=', KEYSET_TABLE)
      .executeTakeFirstOrThrow();

    expect(new Set(seen).size, 'a duplicate means the cursor moved backwards').toBe(seen.length);
    expect(seen.length, 'a gap means the cursor skipped a row').toBe(Number(total.n));
  });

  test('a row inserted mid-walk cannot shift the pages (why not OFFSET)', async () => {
    asUser = authUser('admin');
    const page1 = JSON.parse(
      (await app.inject({ method: 'GET', url: `/v1/audit-log?tableName=${TABLE}&limit=2` })).payload,
    ) as { data: Array<{ id: string }>; nextCursor: string };

    // The table is written to constantly. With OFFSET this insert shifts every
    // later page by one: the reader sees a row twice and never sees another.
    await seed([{ createdAt: new Date(), tableName: TABLE, action: 'INSERT' }]);

    const page2 = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/audit-log?tableName=${TABLE}&limit=2&cursor=${page1.nextCursor}`,
        })
      ).payload,
    ) as { data: Array<{ id: string }> };

    const overlap = page2.data.filter((d) => page1.data.some((p) => p.id === d.id));
    expect(overlap).toEqual([]);
  });

  test('a malformed cursor is rejected, not silently ignored', async () => {
    asUser = authUser('admin');
    const res = await app.inject({ method: 'GET', url: '/v1/audit-log?cursor=not-a-cursor' });
    expect(res.statusCode).toBe(400);
  });
});

describe('⭐ the export streams (ADR-028)', () => {
  test('no Content-Length, and the body arrives in more than one chunk', async () => {
    await seed(
      Array.from({ length: 400 }, (_, i) => ({
        createdAt: at(`2093-04-01T00:00:00Z`),
        tableName: OTHER_TABLE,
        newValue: { padding: 'x'.repeat(200), i },
      })),
    );
    asUser = authUser('admin');

    const res = await fetch(`${baseUrl}/v1/audit-log/export?tableName=${OTHER_TABLE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="audit-log-');

    // The header that cannot exist without buffering the whole body first —
    // which is precisely what this ADR removes.
    expect(res.headers.get('content-length'), 'a length means it was buffered').toBeNull();
    expect(res.headers.get('transfer-encoding')).toBe('chunked');

    let chunks = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks += 1;
    }
    expect(chunks, 'one chunk means the whole thing was assembled first').toBeGreaterThan(1);
  });

  test('⭐ a JSONB value with a comma, a double quote AND a newline round-trips', async () => {
    const nasty = {
      note: 'Naaz, "the reel"\nsecond line',
      nested: { 'key,with,commas': 'a "quoted" value' },
    };
    const recordId = randomUUID();
    await seed([
      { createdAt: at('2093-05-01T06:00:00Z'), tableName: OTHER_TABLE, recordId, newValue: nasty },
    ]);

    asUser = authUser('admin');
    const res = await fetch(`${baseUrl}/v1/audit-log/export?tableName=${OTHER_TABLE}`);
    const rows = parse(await res.text(), { columns: true }) as Array<Record<string, string>>;
    const row = rows.find((r) => r['Record id'] === recordId)!;

    // Hand-rolled join(',') produces a file that looks fine in a text editor and
    // lands in the wrong columns in a spreadsheet. This is the assertion that
    // makes csv-stringify a dependency rather than a preference.
    expect(row).toBeDefined();
    expect(JSON.parse(row['New value']!)).toEqual(nasty);
    expect(row['IP address']).toBe('');
  });

  test('the System Actor reads as "System", not as a uuid or a blank', async () => {
    const { SYSTEM_ACTOR_UUID } = await import('@skaly/shared');
    const recordId = randomUUID();
    await seed([
      {
        createdAt: at('2093-06-01T06:00:00Z'),
        tableName: OTHER_TABLE,
        staffId: SYSTEM_ACTOR_UUID,
        source: 'system',
        recordId,
      },
    ]);

    asUser = authUser('admin');
    const res = await fetch(`${baseUrl}/v1/audit-log/export?tableName=${OTHER_TABLE}`);
    const rows = parse(await res.text(), { columns: true }) as Array<Record<string, string>>;
    expect(rows.find((r) => r['Record id'] === recordId)!.Actor).toBe('System');

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/audit-log?tableName=${OTHER_TABLE}&recordId=${recordId}`,
    });
    // Both sinks resolve it the same way — it is one function, called twice.
    expect(JSON.parse(listed.payload).data[0].actorName).toBe('System');
  });

  test('the timestamp column is IST, matching what the panel renders', async () => {
    const recordId = randomUUID();
    await seed([
      { createdAt: at('2093-07-01T18:30:00Z'), tableName: OTHER_TABLE, recordId },
    ]);
    asUser = authUser('admin');
    const res = await fetch(`${baseUrl}/v1/audit-log/export?tableName=${OTHER_TABLE}`);
    const rows = parse(await res.text(), { columns: true }) as Array<Record<string, string>>;
    // 18:30Z + 5:30 = midnight on the 2nd, IST.
    expect(rows.find((r) => r['Record id'] === recordId)!['Timestamp (IST)']).toBe(
      '2093-07-02 00:00:00',
    );
  });
});

describe('⭐ 10k rows export without the heap growing with the row count', () => {
  const BULK = BULK_TABLE;

  beforeAll(async () => {
    // One statement — 10k round trips would dominate the test's runtime and
    // measure nothing useful.
    await sql`
      INSERT INTO audit_log (staff_id, changed_by_source, table_name, action, new_value, created_at)
      SELECT ${adminId}::uuid, 'user', ${BULK}, 'UPDATE',
             jsonb_build_object('i', g, 'padding', repeat('x', 300)),
             NOW() - (g || ' seconds')::interval
      FROM generate_series(1, 10000) AS g
    `.execute(db);
  }, 60_000);

  afterAll(async () => {
    await db.deleteFrom('audit_log').where('table_name', '=', BULK).execute();
  });

  /**
   * ⭐ The assertion ADR-028 exists for — but NOT measured as a heap delta.
   *
   * A `process.memoryUsage().heapUsed` delta was tried first and is not a valid
   * measurement here: the server and the HTTP client share one process, so the
   * number includes the client's own read and whatever V8 has not collected
   * (`global.gc` is undefined without --expose-gc, so the usual `gc()` calls are
   * silent no-ops). It passed when the file ran whole and failed when the test
   * ran alone — a threshold that moves with warm-up is not evidence of anything.
   *
   * TIME TO FIRST BYTE is the direct observation instead, and it discriminates
   * exactly: a buffered response cannot emit its first byte until it has fetched
   * and serialised the LAST row, so TTFB and total duration converge. A streamed
   * one emits the header row while Postgres is still reading, so TTFB is a small
   * fraction of the total. Nothing about it depends on GC timing.
   */
  test('first byte arrives long before the last row is read', async () => {
    asUser = authUser('admin');

    const started = performance.now();
    const res = await fetch(`${baseUrl}/v1/audit-log/export?tableName=${BULK}`);
    const reader = res.body!.getReader();

    let bytes = 0;
    let rows = 0;
    let ttfb = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes === 0) ttfb = performance.now() - started;
      bytes += value!.byteLength;
      // Count newlines rather than accumulating the body — accumulating it here
      // would reintroduce on the CLIENT the exact ceiling the server removed.
      for (const b of value!) if (b === 0x0a) rows += 1;
    }
    const total = performance.now() - started;

    expect(rows, 'header + 10k data rows').toBeGreaterThanOrEqual(10_000);
    expect(bytes, 'a payload big enough for buffering to be visible').toBeGreaterThan(3_000_000);
    expect(res.headers.get('content-length'), 'a length means it was buffered').toBeNull();
    expect(
      ttfb,
      `TTFB ${ttfb.toFixed(0)}ms of ${total.toFixed(0)}ms total — converging means it buffered`,
    ).toBeLessThan(total * 0.5);
  }, 120_000);
});
