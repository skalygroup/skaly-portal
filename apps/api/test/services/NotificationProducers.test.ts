import { NOTIFICATION_REGISTRY } from '@skaly/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';


import { transactionWithEmits } from '../../src/lib/emit-after-commit.js';
import { AuthService } from '../../src/services/AuthService.js';
import { ClientService } from '../../src/services/ClientService.js';
import { HolidayService } from '../../src/services/HolidayService.js';
import { NotificationService } from '../../src/services/NotificationService.js';
import { TaskService } from '../../src/services/TaskService.js';

import type { CurrentUser } from '../../src/services/AttendanceService.js';
import type { DB } from '@skaly/shared';

/**
 * ADR-020 — the six types whose owning sprints had shipped without wiring a producer.
 *
 * Five are closed here. `account_reactivated` is NOT, and deliberately: there is no
 * staff reactivate path anywhere in the codebase (StaffService is read-only — three
 * getters, no mutations), so a producer would mean building staff lifecycle
 * management, which is Sprint 11's Settings → Staff. Inventing an emitter to satisfy
 * a coverage test is exactly what ADR-020 forbids.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const ACTOR = 'e6000000-0000-4000-8000-00000000f001';
const OTHER = 'e6000000-0000-4000-8000-00000000f002';
const MEMBER = 'e6000000-0000-4000-8000-00000000f003';
const INACTIVE = 'e6000000-0000-4000-8000-00000000f004';
const CLIENT = 'e6000000-0000-4000-8000-00000000fc01';
const PERIOD = '2094-04';
const DOMAIN = '@notifproducers.itest';

const asAdmin = (staffId = ACTOR): CurrentUser => ({ staffId, role: 'admin' });

const notifications = new NotificationService();
const holidays = new HolidayService();
const clients = new ClientService();
const tasks = new TaskService();

const staffIds = [ACTOR, OTHER, MEMBER, INACTIVE];

async function notifsOf(type: string): Promise<{ staff_id: string; title: string; payload: unknown }[]> {
  return db
    .selectFrom('notifications')
    .select(['staff_id', 'title', 'payload'])
    .where('type', '=', type)
    .where('staff_id', 'in', staffIds)
    .execute();
}

async function clearNotifications(): Promise<void> {
  await db.deleteFrom('notifications').where('staff_id', 'in', staffIds).execute();
}

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values([
      // TWO admins, deliberately. signup_rejected routes to the NON-ACTOR admins, so
      // with a single admin the recipient set is empty and the type produces zero
      // rows — an assertion written against one admin would pass vacuously and prove
      // nothing. ACTOR rejects; OTHER is the recipient the test needs to exist.
      // (See the single-admin test below: zero rows is the CORRECT behaviour, and
      // it is likely the real one at MVP, where Skaly may run with one admin.)
      { id: ACTOR, name: 'Producer Actor', email: `actor${DOMAIN}`, role: 'admin', active: true },
      { id: OTHER, name: 'Producer Other', email: `other${DOMAIN}`, role: 'admin', active: true },
      { id: MEMBER, name: 'Producer Member', email: `member${DOMAIN}`, role: 'team_member', active: true },
      { id: INACTIVE, name: 'Producer Gone', email: `gone${DOMAIN}`, role: 'team_member', active: false },
    ])
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('months')
    .values({ period: PERIOD, label: PERIOD, locked: false })
    .onConflict((oc) => oc.column('period').doUpdateSet({ locked: false }))
    .execute();
  await db
    .insertInto('clients')
    .values({ id: CLIENT, name: 'Producer Client', shoot_slots_per_month: 2, pieces_per_visit: 1, active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

beforeEach(async () => {
  await clearNotifications();
  await db.deleteFrom('task_assignees').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('tasks').where('period', '=', PERIOD).execute();
  await db.deleteFrom('holidays').where('period', '=', PERIOD).execute();
});

afterAll(async () => {
  await clearNotifications();
  await db.deleteFrom('task_assignees').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('tasks').where('period', '=', PERIOD).execute();
  await db.deleteFrom('holidays').where('period', '=', PERIOD).execute();
  await db.deleteFrom('clients').where('id', '=', CLIENT).execute();
  // Drop what REFERENCES staff before staff itself. These producers write audit rows,
  // and audit_log.staff_id is a non-null FK — leaving them behind makes the NEXT
  // run's cleanup fail on the constraint rather than on anything to do with the test.
  await db.deleteFrom('audit_log').where('staff_id', 'in', staffIds).execute();
  await db.deleteFrom('staff').where('id', 'in', staffIds).execute();
  await db.destroy();
});

describe('holiday_added / holiday_removed — the gap Sprint 3 left', () => {
  test('adding a holiday notifies everyone but the actor', async () => {
    await transactionWithEmits(db, (trx) =>
      holidays.create({
        period: PERIOD,
        date: `${PERIOD}-14`,
        name: 'Producer Day',
        currentUser: asAdmin(),
        trx,
      }),
    );

    const rows = await notifsOf('holiday_added');
    const recipients = rows.map((r) => r.staff_id).sort();

    // Everyone active except the actor. The socket broadcast this service already
    // did was NOT a notification — having one was never having the other.
    expect(recipients).toEqual([MEMBER, OTHER].sort());
    expect(recipients).not.toContain(ACTOR);
    // Deactivated staff are excluded by the query, not by the caller.
    expect(recipients).not.toContain(INACTIVE);
  });

  test('removing a holiday notifies everyone but the actor', async () => {
    const holiday = await transactionWithEmits(db, (trx) =>
      holidays.create({
        period: PERIOD,
        date: `${PERIOD}-15`,
        name: 'Removable Day',
        currentUser: asAdmin(),
        trx,
      }),
    );
    await clearNotifications();

    await transactionWithEmits(db, (trx) => holidays.remove(holiday.id, asAdmin(), trx));

    const rows = await notifsOf('holiday_removed');
    expect(rows.map((r) => r.staff_id).sort()).toEqual([MEMBER, OTHER].sort());
  });
});

describe('client_updated — the gap Sprint 6 left', () => {
  test('renaming a client notifies everyone but the actor, with both names', async () => {
    await clients.rename(CLIENT, 'Producer Client Renamed', asAdmin(), db);

    const rows = await notifsOf('client_updated');
    expect(rows.map((r) => r.staff_id).sort()).toEqual([MEMBER, OTHER].sort());

    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.previousName).toBe('Producer Client');
    expect(payload.name).toBe('Producer Client Renamed');

    // Restore for suite independence.
    await clients.rename(CLIENT, 'Producer Client', asAdmin(), db);
  });
});

describe('signup_rejected — the gap Sprint 2 left', () => {
  test('goes to the OTHER admins, never the applicant, and never leaks rejection_note', async () => {
    // rejectSignupRequest touches only db + audit + notifications; the Supabase, S3
    // and Redis collaborators are not on this path.
    const auth = new AuthService(
      db,
      {} as never,
      {} as never,
      { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
      {} as never,
      'test-bucket',
    );

    const request = await db
      .insertInto('signup_requests')
      .values({
        name: 'Rejected Applicant',
        email: `applicant${DOMAIN}`,
        date_of_birth: '1995-01-01',
        mobile_number: '9000000000',
        role_requested: 'team_member',
        status: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await auth.rejectSignupRequest(
      request.id,
      'INTERNAL: failed the reference check',
      'Thanks for applying.',
      ACTOR,
    );

    const rows = await notifsOf('signup_rejected');

    // OTHER is the only other admin; MEMBER is a team_member and must not see it.
    expect(rows.map((r) => r.staff_id)).toEqual([OTHER]);

    const serialised = JSON.stringify(rows[0]!.payload);
    expect(serialised).toContain('Thanks for applying.');
    // The internal note stays in the audit trail. A payload is the least-guarded
    // thing we send, so it must never carry it.
    expect(serialised).not.toContain('failed the reference check');
    expect(serialised).not.toContain('rejection_note');

    await db.deleteFrom('signup_requests').where('id', '=', request.id).execute();
  });

  test('with a SINGLE admin the type produces nothing — correct, and likely the MVP reality', async () => {
    // The non-actor rule means a lone admin rejecting a request notifies nobody.
    // That is right (telling you what you just did is noise), but it means this type
    // may genuinely never fire in production if Skaly runs one admin. Asserted so the
    // behaviour is a recorded decision rather than something discovered as a "bug".
    await db.updateTable('staff').set({ role: 'manager' }).where('id', '=', OTHER).execute();

    const auth = new AuthService(
      db,
      {} as never,
      {} as never,
      { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
      {} as never,
      'test-bucket',
    );

    const request = await db
      .insertInto('signup_requests')
      .values({
        name: 'Lone Admin Applicant',
        email: `lone${DOMAIN}`,
        date_of_birth: '1995-01-01',
        mobile_number: '9000000001',
        role_requested: 'team_member',
        status: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await auth.rejectSignupRequest(request.id, 'INTERNAL', 'Thanks for applying.', ACTOR);

    expect(await notifsOf('signup_rejected')).toHaveLength(0);

    await db.deleteFrom('signup_requests').where('id', '=', request.id).execute();
    await db.updateTable('staff').set({ role: 'admin' }).where('id', '=', OTHER).execute();
  });

  test('the deep link carries the filter AND the target, not just the page', () => {
    // The queue defaults to pending; a rejected request is by definition not there.
    const link = NOTIFICATION_REGISTRY.signup_rejected.linkBuilder({ requestId: 'req-9' });
    expect(link).toBe('/settings/signup-requests?status=rejected&highlight=req-9');
  });
});

describe('task_overdue — the gap Sprint 4 left, plus the dedup guard', () => {
  async function seedOverdueTask(): Promise<string> {
    const task = await db
      .insertInto('tasks')
      .values({
        period: PERIOD,
        date: `${PERIOD}-01`,
        description: 'An overdue task',
        status: 'In Progress',
        deadline: sql<string>`current_date - interval '3 days'`,
        created_by: ACTOR,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('task_assignees')
      .values({ task_id: task.id, staff_id: MEMBER, assigned_by: ACTOR })
      .execute();
    return task.id;
  }

  test('the sweep notifies each assignee of a task past its deadline', async () => {
    const taskId = await seedOverdueTask();

    const sent = await tasks.notifyOverdue(db);

    expect(sent).toBe(1);
    const rows = await notifsOf('task_overdue');
    expect(rows.map((r) => r.staff_id)).toEqual([MEMBER]);
    expect((rows[0]!.payload as Record<string, unknown>).taskId).toBe(taskId);
  });

  test('⭐ a second sweep inside 24h sends NOTHING — the dedup guard', async () => {
    await seedOverdueTask();

    await tasks.notifyOverdue(db);
    const second = await tasks.notifyOverdue(db);
    const third = await tasks.notifyOverdue(db);

    // Without this the sweep re-notifies the same task every run, forever, and the
    // bell becomes noise the user learns to ignore.
    expect(second).toBe(0);
    expect(third).toBe(0);
    expect(await notifsOf('task_overdue')).toHaveLength(1);
  });

  test('dedup allows again once the window has passed', async () => {
    const taskId = await seedOverdueTask();
    await tasks.notifyOverdue(db);

    // Age the existing notification past the 24h window.
    await db
      .updateTable('notifications')
      .set({ created_at: sql`now() - interval '25 hours'` })
      .where('staff_id', '=', MEMBER)
      .where('type', '=', 'task_overdue')
      .execute();

    expect(await tasks.notifyOverdue(db)).toBe(1);
    const rows = await notifsOf('task_overdue');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.payload as Record<string, unknown>).taskId === taskId)).toBe(true);
  });

  test('a Done or Cancelled task is never overdue', async () => {
    const task = await db
      .insertInto('tasks')
      .values({
        period: PERIOD,
        date: `${PERIOD}-01`,
        description: 'A finished task',
        status: 'Done',
        deadline: sql<string>`current_date - interval '3 days'`,
        created_by: ACTOR,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('task_assignees')
      .values({ task_id: task.id, staff_id: MEMBER, assigned_by: ACTOR })
      .execute();

    expect(await tasks.notifyOverdue(db)).toBe(0);
  });

  test('a task with no deadline is never overdue — date is the plan, deadline is the commitment', async () => {
    const task = await db
      .insertInto('tasks')
      .values({
        period: PERIOD,
        date: `${PERIOD}-01`,
        description: 'No deadline set',
        status: 'To Do',
        created_by: ACTOR,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('task_assignees')
      .values({ task_id: task.id, staff_id: MEMBER, assigned_by: ACTOR })
      .execute();

    expect(await tasks.notifyOverdue(db)).toBe(0);
  });
});

describe('the dedup guard lives in the service, so every future type inherits it', () => {
  test('a create WITHOUT a recordId is never deduped — one-off events still repeat', async () => {
    for (let i = 0; i < 3; i++) {
      await transactionWithEmits(db, (trx) =>
        notifications.create({ recipientId: MEMBER, type: 'signup_approved', title: `Run ${i}`, trx }),
      );
    }
    const rows = await db
      .selectFrom('notifications')
      .selectAll()
      .where('staff_id', '=', MEMBER)
      .where('type', '=', 'signup_approved')
      .execute();
    expect(rows).toHaveLength(3);
  });

  test('dedup is keyed on all three of (recipient, type, record)', async () => {
    const run = (recipientId: string, type: 'task_overdue' | 'dependency_resolved', recordId: string) =>
      transactionWithEmits(db, (trx) =>
        notifications.create({ recipientId, type, title: 'k', recordId, data: { recordId }, trx }),
      );

    expect(await run(MEMBER, 'task_overdue', 'rec-1')).not.toBeNull();
    // Same three → suppressed.
    expect(await run(MEMBER, 'task_overdue', 'rec-1')).toBeNull();
    // Any one differing → allowed.
    expect(await run(OTHER, 'task_overdue', 'rec-1')).not.toBeNull();
    expect(await run(MEMBER, 'dependency_resolved', 'rec-1')).not.toBeNull();
    expect(await run(MEMBER, 'task_overdue', 'rec-2')).not.toBeNull();
  });
});

describe('account_reactivated — NOT built, and why', () => {
  test('no staff reactivate path exists, so the producer is Sprint 11 work', async () => {
    // ADR-020 forbids inventing an emitter to satisfy a coverage test. StaffService
    // is read-only and there is no deactivate/reactivate anywhere, so this type's
    // producer arrives with Settings → Staff. Asserted so the gap is recorded rather
    // than quietly forgotten.
    const staffService = await import('../../src/services/StaffService.js');
    const methods = Object.getOwnPropertyNames(staffService.StaffService.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methods.sort()).toEqual(['getFullProfile', 'getPublicProfile', 'listLimited']);
  });
});
