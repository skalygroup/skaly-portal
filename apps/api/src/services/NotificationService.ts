/**
 * NotificationService — writes a notifications row and pushes it live to the
 * recipient over Socket.io (02-TRD §10.2, 07-API-CONTRACT §6).
 *
 * Delivery contract:
 *   1. DB write FIRST — the row is the durable record; an offline recipient
 *      fetches it later via GET /v1/notifications.
 *   2. Emit SECOND, and after COMMIT — via lib/emit-after-commit.ts. This method
 *      writes through the caller's `trx`, so "after the write" is not yet durable;
 *      the seam holds the emit until the caller's transaction commits and drops it
 *      if that transaction rolls back.
 *      Fire-and-forget: a socket failure (or sockets not yet initialised) is
 *      logged and swallowed, NEVER rolled back onto the DB write.
 */
import { NOTIFICATION_TYPES, isNotificationType } from '@skaly/shared';
import { sql, type Selectable } from 'kysely';


import { emitAfterCommit } from '../lib/emit-after-commit.js';
import { AppError } from '../lib/errors.js';

import type { Executor } from './BaseService.js';
import type { Notifications, NotificationType } from '@skaly/shared';

/**
 * The type list now comes from the shared registry (ADR-020), which mirrors the
 * `notifications_type_check` enum in both directions with a set-equality test as the
 * drift guard. It used to be a second hardcoded copy here — two lists that had to
 * agree by discipline rather than by construction.
 */
export type { NotificationType };
export { NOTIFICATION_TYPES };

export interface NotificationCreateInput {
  /** → staff_id (the recipient). */
  recipientId: string;
  /** → type. Must be one of NOTIFICATION_TYPES. */
  type: NotificationType;
  /** → title. */
  title: string;
  /** → message (nullable). */
  body?: string | null;
  /** → payload (JSONB); defaults to {}. */
  data?: Record<string, unknown>;
  /**
   * The record this notification is ABOUT — the third part of the dedup key.
   * Without it a repeating producer (the overdue sweep) re-notifies the same task
   * every run, forever. Omit for genuinely one-off events.
   */
  recordId?: string | null;
  /** The caller's transaction so the write is atomic with the originating op. */
  trx: Executor;
}

/** A repeat of (recipient, type, record) inside this window is suppressed. */
export const DEDUP_WINDOW_HOURS = 24;

/** NFR §5.2 — messages are retained for 12 months. */
export const RETENTION_MONTHS = 12;

const NOTIFY_NAMESPACE = '/ws/notify';

export class NotificationService {
  /**
   * Persist a notification and push it live. Returns the inserted row. Runs
   * inside the caller's transaction — never opens its own.
   */
  async create(input: NotificationCreateInput): Promise<Selectable<Notifications> | null> {
    const { recipientId, type, title, body, data, recordId, trx } = input;

    if (!isNotificationType(type)) {
      throw new AppError('VALIDATION_ERROR', `Unknown notification type: ${String(type)}`, {
        allowed: NOTIFICATION_TYPES,
      });
    }

    // 0. Dedup, HERE rather than in the producer, so every future repeating type
    //    inherits it. task_overdue runs on a sweep: without this guard the same task
    //    notifies its assignee every run, forever, and the bell becomes noise the
    //    user learns to ignore — which costs you the notifications that matter.
    if (recordId && (await this.isDuplicate(recipientId, type, recordId, trx))) {
      return null;
    }

    // 1. DB write first — the durable record (offline delivery).
    const row = await trx
      .insertInto('notifications')
      .values({
        staff_id: recipientId,
        type,
        title,
        message: body ?? null,
        payload: sql`${JSON.stringify(data ?? {})}::jsonb`,
        is_read: false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 2. Emit second — and, inside a transactionWithEmits window, only once that
    //    transaction COMMITS. This method writes through the CALLER's trx, so the row
    //    above is written but not durable; emitting here used to send a notification
    //    the caller could still roll back. Under ADR-022 the bell patches its cache
    //    from this payload, so a rolled-back emit leaves a client showing a
    //    notification that does not exist, with no refetch coming to correct it.
    emitAfterCommit(NOTIFY_NAMESPACE, `user:${recipientId}`, 'notify:new', row);

    return row;
  }

  /**
   * Fan out one notification per recipient, never combined (ADR-006), and NEVER to
   * the actor — the same non-actor rule task assignment established, applied
   * generally. "You added a holiday" is noise in your own bell.
   *
   * `roles` narrows the audience; omitted means every active staff member. Soft-
   * deleted and deactivated staff are excluded by the query, not by the caller.
   */
  async createForStaff(
    input: Omit<NotificationCreateInput, 'recipientId'> & {
      actorId: string;
      roles?: readonly string[];
    },
  ): Promise<number> {
    const { actorId, roles, trx, ...rest } = input;

    let q = trx
      .selectFrom('staff')
      .select('id')
      .where('active', '=', true)
      .where('deleted_at', 'is', null)
      .where('id', '!=', actorId);
    if (roles && roles.length > 0) q = q.where('role', 'in', roles);

    const recipients = await q.execute();

    let created = 0;
    for (const r of recipients) {
      const row = await this.create({ ...rest, recipientId: r.id, trx });
      if (row) created += 1;
    }
    return created;
  }

  /**
   * Has this exact (recipient, type, record) already fired inside the dedup window?
   *
   * Matched on `payload->>'recordId'` rather than a column: the payload already
   * carries the addressed record for the deep link, and adding a column would be a
   * migration for something the JSONB answers. The index on (staff_id, is_read,
   * created_at) carries the selective part; the scan left over is one staff member's
   * last day of notifications.
   */
  private async isDuplicate(
    recipientId: string,
    type: NotificationType,
    recordId: string,
    trx: Executor,
  ): Promise<boolean> {
    const existing = await trx
      .selectFrom('notifications')
      .select('id')
      .where('staff_id', '=', recipientId)
      .where('type', '=', type)
      .where(sql<boolean>`payload->>'recordId' = ${recordId}`)
      .where('created_at', '>', sql<Date>`now() - interval '${sql.raw(String(DEDUP_WINDOW_HOURS))} hours'`)
      .executeTakeFirst();
    return existing !== undefined;
  }

  /**
   * A page of the caller's notifications, newest first. Keyset on created_at — the
   * bell's index is (staff_id, is_read, created_at DESC), so this reads straight off
   * it in either mode.
   */
  async list(
    recipientId: string,
    opts: { unreadOnly?: boolean; limit: number; cursor?: string | null },
    trx: Executor,
  ): Promise<{ items: Selectable<Notifications>[]; nextCursor: string | null }> {
    let q = trx
      .selectFrom('notifications')
      .selectAll()
      .where('staff_id', '=', recipientId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.limit + 1);

    if (opts.unreadOnly) q = q.where('is_read', '=', false);
    if (opts.cursor) q = q.where('created_at', '<', new Date(opts.cursor));

    const rows = await q.execute();
    const items = rows.slice(0, opts.limit);
    // The extra row is the existence proof for a next page — cheaper and more honest
    // than a count, which would be wrong the moment anything else writes.
    const nextCursor =
      rows.length > opts.limit ? (items.at(-1)?.created_at.toISOString() ?? null) : null;
    return { items, nextCursor };
  }

  /**
   * Unread count for the badge. The UI caps the DISPLAY at 99+; the query is not
   * capped, because "how many are actually unread" is also what mark-all-read has to
   * clear and what a second tab has to agree with.
   */
  async unreadCount(recipientId: string, trx: Executor): Promise<number> {
    const row = await trx
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('staff_id', '=', recipientId)
      .where('is_read', '=', false)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Mark one notification read. Scoped to the caller inside the service — a route
   * that forgot to check would otherwise let anyone read anyone's bell away.
   */
  async markRead(id: string, recipientId: string, trx: Executor): Promise<void> {
    const updated = await trx
      .updateTable('notifications')
      .set({ is_read: true })
      .where('id', '=', id)
      .where('staff_id', '=', recipientId)
      .returning('id')
      .executeTakeFirst();

    if (!updated) {
      // Not found, or not theirs — same answer either way, so ownership is not
      // discoverable by probing ids.
      throw new AppError('RESOURCE_NOT_FOUND', `Notification ${id} does not exist.`);
    }

    this.emitRead(recipientId, [id]);
  }

  /** Mark every unread notification read. Returns how many changed. */
  async markAllRead(recipientId: string, trx: Executor): Promise<number> {
    const rows = await trx
      .updateTable('notifications')
      .set({ is_read: true })
      .where('staff_id', '=', recipientId)
      .where('is_read', '=', false)
      .returning('id')
      .execute();

    if (rows.length > 0) this.emitRead(recipientId, rows.map((r) => r.id));
    return rows.length;
  }

  /**
   * `notify:read` carries the ids, not just a signal, so a second open tab can patch
   * the exact rows rather than refetching the list (ADR-022's patch principle).
   */
  private emitRead(recipientId: string, ids: string[]): void {
    emitAfterCommit(NOTIFY_NAMESPACE, `user:${recipientId}`, 'notify:read', { ids });
  }

  /**
   * Messages past the NFR §5.2 retention horizon.
   *
   * Built and tested now so Sprint 12's cron is a one-liner rather than a design
   * session at 02:00 IST.
   *
   * ONE STATEMENT, and that is load-bearing (ADR-021 addendum):
   * `messages_parent_id_fkey` is NO ACTION, which Postgres checks at STATEMENT END —
   * so a single DELETE removing a parent and its children together succeeds, while two
   * statements or parent-first ordering raise the constraint. Sprint 10's teardowns hit
   * that wall three times.
   *
   * ONE RULE FOR BOTH CHANNELS: delete a message past the cutoff unless it still has a
   * reply inside the window.
   *
   * The ADR's first draft scoped bot rows by `bot_sessions.last_activity_at`. That is
   * not expressible: `messages` carries no session reference — ADR-021 deliberately
   * gave parent_id the message graph and bot_sessions the session lifecycle, and never
   * linked a row to a session. Joining bot_sessions on staff_id instead, as the first
   * implementation did, means ONE expired session deletes that person's ENTIRE bot
   * history including live conversations. A test caught it; the ADR addendum is
   * corrected to match.
   *
   * The turn-pair guarantee the session scoping was meant to provide is what parent_id
   * already gives: a bot reply is a child of its question, so the question cannot be
   * deleted while the answer is inside the window, and both are written seconds apart
   * so they cross the cutoff together.
   */
  async deleteExpiredMessages(trx: Executor): Promise<number> {
    const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_MONTHS))} months'`;

    const result = await sql<{ id: string }>`
      DELETE FROM messages m
      WHERE m.created_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM messages r
          WHERE r.parent_id = m.id AND r.created_at >= ${cutoff}
        )
      RETURNING m.id
    `.execute(trx);

    return result.rows.length;
  }
}