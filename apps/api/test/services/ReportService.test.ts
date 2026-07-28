import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { currentIstPeriod } from '../../src/services/BaseService.js';
import { ReportService } from '../../src/services/ReportService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { ReportWorkerInput, ReportWorkerResult } from '../../src/workers/report-worker.js';
import type { DB } from '@skaly/shared';
import type { Worker } from 'node:worker_threads';

/**
 * ADR-027's dispatch half. The render itself is covered in report-document.test.ts
 * (in-process, no thread) and the real thread spawn in report-worker.test.ts.
 *
 * Here the worker is FAKED, deliberately: the four exit paths — success, thrown
 * error, silent exit, timeout — are the part that decides whether a report can sit
 * `pending` forever, and driving them through a real 10-second PDF render would be
 * slow, flaky, and would test the renderer instead of the lifecycle.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const DOMAIN = '@reportsvc.itest';
const PERIOD = currentIstPeriod();
const adminId = randomUUID();
const managerId = randomUUID();
const memberId = randomUUID();

const admin: CurrentUser = { staffId: adminId, role: 'admin' };
const manager: CurrentUser = { staffId: managerId, role: 'manager' };
const member: CurrentUser = { staffId: memberId, role: 'team_member' };

/** A Worker-shaped emitter. `terminate` is a no-op that resolves, which is all
 *  ReportService asks of it. */
class FakeWorker extends EventEmitter {
  terminated = false;
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

function serviceWith(behaviour: (w: FakeWorker, input: ReportWorkerInput) => void) {
  const svc = new ReportService();
  const spawned: FakeWorker[] = [];
  svc.spawn = (input) => {
    const w = new FakeWorker();
    spawned.push(w);
    // Asynchronously, like a real thread — a synchronous emit would fire before
    // the listeners are attached and the promise would never settle.
    setImmediate(() => behaviour(w, input));
    return w as unknown as Worker;
  };
  return { svc, spawned };
}

const reply = (result: ReportWorkerResult) => (w: FakeWorker) => w.emit('message', result);

async function reportRow(id: string) {
  return db
    .selectFrom('reports')
    .select(['status', 'file_key', 'error_message', 'completed_at'])
    .where('id', '=', id)
    .executeTakeFirst();
}

/** The settle path runs detached from generate(), so tests wait for the row to
 *  reach a terminal state rather than guessing at a sleep. */
async function settled(id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await reportRow(id);
    if (row && row.status !== 'pending') return row;
    if (Date.now() > deadline) throw new Error(`report ${id} never settled (still ${row?.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function cleanup() {
  const mine = db.selectFrom('staff').select('id').where('email', 'like', `%${DOMAIN}`);
  await db.deleteFrom('notifications').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('reports').where('generated_by', 'in', mine).execute();
  await db.deleteFrom('audit_log').where('staff_id', 'in', mine).execute();
  await db.deleteFrom('staff').where('email', 'like', `%${DOMAIN}`).execute();
}

beforeAll(async () => {
  await cleanup();
  await db
    .insertInto('staff')
    .values([
      { id: adminId, name: 'Rep Admin', email: `admin${DOMAIN}`, role: 'admin', active: true },
      { id: managerId, name: 'Rep Manager', email: `manager${DOMAIN}`, role: 'manager', active: true },
      { id: memberId, name: 'Rep Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
    ])
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doNothing())
    .execute();
});

afterAll(async () => {
  await cleanup();
  await db.destroy();
});

afterEach(async () => {
  vi.useRealTimers();
});

describe('POST /v1/reports/generate — the 202 contract', () => {
  test('persists a pending row and returns immediately, with no PDF in the answer', async () => {
    // The worker never replies. generate() must still return — the whole point of
    // 202 is that the caller does not wait for the render.
    const { svc } = serviceWith(() => {});
    const started = Date.now();
    const out = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    expect(out.status).toBe('pending');
    expect(Date.now() - started, 'generate must not wait on the render').toBeLessThan(500);
    expect(Object.keys(out).sort(), 'no buffer, no link').toEqual(['reportId', 'status']);
    expect((await reportRow(out.reportId))?.status).toBe('pending');
  });

  test('a bad period is a 404 BEFORE a row exists, not a failed row later', async () => {
    const { svc, spawned } = serviceWith(reply({ ok: true, r2Key: 'k' }));
    await expect(
      svc.generate({ type: 'org_monthly', period: '1999-01' }, admin, db),
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' });

    expect(spawned, 'nothing should have been dispatched').toHaveLength(0);
    const orphan = await db
      .selectFrom('reports')
      .select('id')
      .where('period', '=', '1999-01')
      .executeTakeFirst();
    expect(orphan).toBeUndefined();
  });

  test('client_monthly without a clientId is refused', async () => {
    const { svc } = serviceWith(reply({ ok: true, r2Key: 'k' }));
    await expect(
      svc.generate({ type: 'client_monthly', period: PERIOD }, admin, db),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('a team_member is refused (Auth-Matrix §4: admin + manager)', async () => {
    const { svc } = serviceWith(reply({ ok: true, r2Key: 'k' }));
    await expect(
      svc.generate({ type: 'org_monthly', period: PERIOD }, member, db),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('⭐ the four exit paths all mark the row — none leaves it pending', () => {
  test('success → ready + file_key + report_ready', async () => {
    const key = `reports/${PERIOD}/ok.pdf`;
    const { svc } = serviceWith(reply({ ok: true, r2Key: key }));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    expect(row.status).toBe('ready');
    expect(row.file_key).toBe(key);
    expect(row.completed_at).not.toBeNull();

    const notif = await db
      .selectFrom('notifications')
      .select(['type', 'payload'])
      .where('staff_id', '=', adminId)
      .where('type', '=', 'report_ready')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    // ⭐ Audit M-08: the payload carries the reportId, never a presigned URL — the
    // link expires in 24h and the notification row does not.
    expect(notif.payload).toMatchObject({ reportId, status: 'ready' });
    expect(JSON.stringify(notif.payload)).not.toContain('http');
  });

  test('a reported failure → failed + error_message, and a notification anyway', async () => {
    const { svc } = serviceWith(reply({ ok: false, error: 'Render blew up' }));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('Render blew up');

    // A failed request is a visible row, never a silent nothing (ADR-027 §8).
    const notif = await db
      .selectFrom('notifications')
      .select('payload')
      .where('staff_id', '=', adminId)
      .where('type', '=', 'report_ready')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(notif.payload).toMatchObject({ status: 'failed' });
  });

  test("a thrown 'error' event → failed", async () => {
    const { svc } = serviceWith((w) => w.emit('error', new Error('worker threw')));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('worker threw');
  });

  test("⭐ an 'exit' with NO message → failed, not pending forever", async () => {
    // The path a message-only handler misses entirely: an OOM kill or a native
    // crash posts nothing at all. Without the exit handler this row stays pending
    // and the user waits for a notification that can never arrive.
    const { svc } = serviceWith((w) => w.emit('exit', 1));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('exited with code 1');
  });

  test('⭐ a worker that never answers is TERMINATED and marked failed', async () => {
    // Past NFR §1.2's p99 ceiling a render is not slow, it is stuck — and a stuck
    // worker holds one of the two slots forever, so the next report never starts.
    const { svc, spawned } = serviceWith(() => {});
    svc.timeoutMs = 300;
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('exceeded');
    // Marking the row is not enough — the thread has to actually go away, or the
    // cap leaks a slot per timeout until nothing can render at all.
    expect(spawned[0]!.terminated, 'a timed-out worker must be terminated').toBe(true);
  });

  test("'error' followed by 'exit' settles once, not twice", async () => {
    const { svc } = serviceWith((w) => {
      w.emit('error', new Error('first'));
      w.emit('exit', 1);
    });
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);

    const row = await settled(reportId);
    // The first outcome wins; the second must not overwrite it.
    expect(row.error_message).toContain('first');

    const notifs = await db
      .selectFrom('notifications')
      .select('id')
      .where('staff_id', '=', adminId)
      // notifications has no record_id COLUMN — the id lives in the JSONB payload,
      // which is also what NotificationService's dedup guard matches on.
      .where(sql<boolean>`payload->>'reportId' = ${reportId}`)
      .execute();
    expect(notifs, 'one report, one notification').toHaveLength(1);
  });
});

describe('the concurrency cap', () => {
  test('⭐ five simultaneous requests never run more than two renders at once', async () => {
    let live = 0;
    let peak = 0;
    const finish: Array<() => void> = [];

    const svc = new ReportService();
    svc.spawn = (input) => {
      const w = new FakeWorker();
      live += 1;
      peak = Math.max(peak, live);
      finish.push(() => {
        live -= 1;
        w.emit('message', { ok: true, r2Key: `reports/${input.period}/${input.reportId}.pdf` });
      });
      return w as unknown as Worker;
    };

    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db).then((r) => r.reportId),
      ),
    );

    // Release them one at a time; each release frees a slot for a queued job.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      finish.shift()?.();
    }
    await Promise.all(ids.map((id) => settled(id)));

    // Five month-end requests must not become five CPU-bound threads on one
    // small instance (ADR-027 §4).
    expect(peak, `peak concurrency was ${peak}`).toBeLessThanOrEqual(2);
    for (const id of ids) expect((await reportRow(id))?.status).toBe('ready');
  }, 30_000);
});

describe('GET /v1/reports/:id — links are regenerated, never stored', () => {
  test('a ready report presigns fresh on every read, with no re-render', async () => {
    const { svc, spawned } = serviceWith(reply({ ok: true, r2Key: `reports/${PERIOD}/link.pdf` }));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);
    await settled(reportId);
    expect(spawned).toHaveLength(1);

    const first = await svc.get(reportId, admin, db);
    const second = await svc.get(reportId, admin, db);

    expect(first.status).toBe('ready');
    expect(first.downloadUrl).toContain('X-Amz-Signature');
    // Nothing spawned a second time: the persisted key is what makes a return
    // visit cheap (ADR-027 §7).
    expect(spawned, 'a second read must not re-render').toHaveLength(1);
    expect(second.downloadUrl).toBeTruthy();

    const stored = await db
      .selectFrom('reports')
      .select('file_key')
      .where('id', '=', reportId)
      .executeTakeFirstOrThrow();
    // A stored URL is a URL that expires in the database.
    expect(stored.file_key).not.toContain('http');
  });

  test('a pending report has no link yet', async () => {
    const { svc } = serviceWith(() => {});
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);
    const got = await svc.get(reportId, admin, db);
    expect(got.status).toBe('pending');
    expect(got.downloadUrl).toBeNull();
  });

  test('past R2 retention the answer is an error, not a link that 404s', async () => {
    const { svc } = serviceWith(reply({ ok: true, r2Key: `reports/${PERIOD}/old.pdf` }));
    const { reportId } = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);
    await settled(reportId);

    await db
      .updateTable('reports')
      .set({ completed_at: new Date(Date.now() - 31 * 86_400_000) })
      .where('id', '=', reportId)
      .execute();

    // 410, NOT 404 — the distinction is the whole point. The row exists and the
    // panel can still read its status; only R2's object is gone. A 404 reads as
    // "no such report", and the panel then cannot offer the [Regenerate] CTA the
    // API contract promises for exactly this case.
    await expect(svc.get(reportId, admin, db)).rejects.toMatchObject({
      code: 'RESOURCE_EXPIRED',
      statusCode: 410,
      message: expect.stringContaining('30 days'),
    });
  });

  test('an unknown id is still a 404 — the two must not collapse into one code', async () => {
    const { svc } = serviceWith(() => {});
    await expect(svc.get(randomUUID(), admin, db)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      statusCode: 404,
    });
  });

  test("a manager sees their own reports; an admin sees everyone's", async () => {
    const { svc } = serviceWith(reply({ ok: true, r2Key: 'k.pdf' }));
    const mine = await svc.generate({ type: 'org_monthly', period: PERIOD }, manager, db);
    await settled(mine.reportId);
    const theirs = await svc.generate({ type: 'org_monthly', period: PERIOD }, admin, db);
    await settled(theirs.reportId);

    const managerList = (await svc.list({}, manager, db)).map((r) => r.id);
    expect(managerList).toContain(mine.reportId);
    expect(managerList).not.toContain(theirs.reportId);

    const adminList = (await svc.list({}, admin, db)).map((r) => r.id);
    expect(adminList).toEqual(expect.arrayContaining([mine.reportId, theirs.reportId]));

    await expect(svc.get(theirs.reportId, manager, db)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  test('a team_member cannot list', async () => {
    const { svc } = serviceWith(reply({ ok: true, r2Key: 'k' }));
    await expect(svc.list({}, member, db)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
