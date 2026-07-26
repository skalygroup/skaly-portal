import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { describe, test, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';

import {
  emitAfterCommit,
  isDeferringEmits,
  resetEmitter,
  setEmitter,
  transactionWithEmits,
} from '../../src/lib/emit-after-commit.js';
import { NotificationService } from '../../src/services/NotificationService.js';

import type { DB } from '@skaly/shared';

/**
 * The ordering invariant, asserted directly rather than inferred from an outcome.
 *
 * Sprint 9's persist-then-emit test passed for nine sprints by luck: BotService
 * happened to await a database write AFTER the emit, and that await gave the async
 * assertion time to observe an already-persisted session. Remove the incidental await
 * — as ADR-021 did, correctly — and the test failed with no product regression.
 *
 * An outcome test cannot distinguish ordered from luckily ordered. These assert on
 * invocation order and on rollback, which can only pass if the seam actually holds.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const STAFF = 'e5000000-0000-4000-8000-00000000ea01';
const DOMAIN = '@emitseam.itest';

beforeAll(async () => {
  await db
    .insertInto('staff')
    .values({ id: STAFF, name: 'Emit Seam', email: `seam${DOMAIN}`, role: 'admin', active: true })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db.deleteFrom('notifications').where('staff_id', '=', STAFF).execute();
});

afterEach(async () => {
  resetEmitter();
  vi.restoreAllMocks();
  await db.deleteFrom('notifications').where('staff_id', '=', STAFF).execute();
});

afterAll(async () => {
  await db.deleteFrom('notifications').where('staff_id', '=', STAFF).execute();
  await db.deleteFrom('staff').where('id', '=', STAFF).execute();
  await db.destroy();
});

describe('emit AFTER COMMIT, not after write', () => {
  test('a notification written inside a transaction does not emit until it commits', async () => {
    const sent: string[] = [];
    let emittedBeforeCommit = false;
    setEmitter((_ns, _room, event) => sent.push(event));

    const notifications = new NotificationService();

    await transactionWithEmits(db, async (trx) => {
      await notifications.create({
        recipientId: STAFF,
        type: 'task_assigned',
        title: 'Inside the transaction',
        trx,
      });
      // The row is written but NOT durable. Nothing may have gone out yet.
      emittedBeforeCommit = sent.length > 0;
    });

    expect(emittedBeforeCommit).toBe(false);
    expect(sent).toEqual(['notify:new']);
  });

  test('⭐ the persist call precedes the emit call — asserted on invocation order', async () => {
    const emitSpy = vi.fn();
    setEmitter(emitSpy);

    const notifications = new NotificationService();
    const persistSpy = vi.fn();

    await transactionWithEmits(db, async (trx) => {
      // Wrap the insert so its invocation order is observable alongside the emit's.
      const row = await notifications.create({
        recipientId: STAFF,
        type: 'task_assigned',
        title: 'Ordering',
        trx,
      });
      persistSpy(row!.id);
    });

    expect(persistSpy).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalled();
    expect(persistSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      emitSpy.mock.invocationCallOrder[0]!,
    );
  });

  test('⭐ a throwing transaction emits NOTHING, and leaves no row', async () => {
    const emitSpy = vi.fn();
    setEmitter(emitSpy);

    const notifications = new NotificationService();

    await expect(
      transactionWithEmits(db, async (trx) => {
        await notifications.create({
          recipientId: STAFF,
          type: 'task_assigned',
          title: 'This one never happened',
          trx,
        });
        throw new Error('the caller rolled back');
      }),
    ).rejects.toThrow('the caller rolled back');

    // Under ADR-022 subscribers PATCH from this payload, so a spurious emit would
    // leave clients holding a notification that never existed in the database.
    expect(emitSpy).not.toHaveBeenCalled();

    const rows = await db
      .selectFrom('notifications')
      .selectAll()
      .where('staff_id', '=', STAFF)
      .execute();
    expect(rows).toHaveLength(0);
  });

  test('every queued emit in one transaction flushes, in order, once', async () => {
    const sent: string[] = [];
    setEmitter((_ns, _room, event) => sent.push(event));

    await transactionWithEmits(db, async () => {
      emitAfterCommit('/ws/notify', 'org:all', 'first', {});
      emitAfterCommit('/ws/notify', 'org:all', 'second', {});
      emitAfterCommit('/ws/notify', 'org:all', 'third', {});
      expect(sent).toHaveLength(0);
    });

    expect(sent).toEqual(['first', 'second', 'third']);
  });
});

describe('outside a transaction the seam is a pass-through', () => {
  test('a non-transactional emit is delivered immediately', () => {
    const sent: string[] = [];
    setEmitter((_ns, _room, event) => sent.push(event));

    expect(isDeferringEmits()).toBe(false);
    emitAfterCommit('/ws/notify', 'org:all', 'immediate', {});
    expect(sent).toEqual(['immediate']);
  });

  test('isDeferringEmits is true only inside a transaction window', async () => {
    setEmitter(() => undefined);
    expect(isDeferringEmits()).toBe(false);
    await transactionWithEmits(db, async () => {
      expect(isDeferringEmits()).toBe(true);
    });
    expect(isDeferringEmits()).toBe(false);
  });

  test('a throwing sender never propagates onto a committed transaction', async () => {
    setEmitter(() => {
      throw new Error('socket is gone');
    });

    // The transaction has already committed; a socket failure must not surface.
    await expect(
      transactionWithEmits(db, async () => {
        emitAfterCommit('/ws/notify', 'org:all', 'boom', {});
      }),
    ).resolves.toBeUndefined();
  });

  test('with no sender registered nothing throws — the unit-test case', async () => {
    resetEmitter();
    await expect(
      transactionWithEmits(db, async () => {
        emitAfterCommit('/ws/notify', 'org:all', 'nowhere', {});
      }),
    ).resolves.toBeUndefined();
  });
});
