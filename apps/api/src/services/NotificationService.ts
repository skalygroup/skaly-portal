/**
 * NotificationService — writes a notifications row and pushes it live to the
 * recipient over Socket.io (02-TRD §10.2, 07-API-CONTRACT §6).
 *
 * Delivery contract:
 *   1. DB write FIRST — the row is the durable record; an offline recipient
 *      fetches it later via GET /v1/notifications.
 *   2. Emit SECOND — io.of('/ws/notify').to('user:{id}').emit('notify:new', row).
 *      Fire-and-forget: a socket failure (or sockets not yet initialised) is
 *      logged and swallowed, NEVER rolled back onto the DB write.
 */
import { sql, type Selectable } from 'kysely';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getIo } from '../sockets/index.js';

import type { Executor } from './BaseService.js';
import type { Notifications } from '@skaly/shared';

/**
 * The notifications.type CHECK enum (05-BACKEND-SCHEMA §; migration 021 is the
 * source of truth). Membership is validated with .includes — the DB CHECK is the
 * ultimate guard, so drift surfaces as a write error, never silent corruption.
 * (We never assert a hardcoded count.)
 */
export const NOTIFICATION_TYPES = [
  'month_ready',
  'task_assigned',
  'task_overdue',
  'dependency_resolved',
  'shoot_confirmed',
  'holiday_added',
  'holiday_removed',
  'rollover_failed',
  'rollover_success',
  'rollover_view_refresh_failed',
  'new_comment',
  'mention',
  'signup_request',
  'signup_approved',
  'signup_rejected',
  'client_updated',
  'report_ready',
  'account_reactivated',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

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
  /** The caller's transaction so the write is atomic with the originating op. */
  trx: Executor;
}

const NOTIFY_NAMESPACE = '/ws/notify';

export class NotificationService {
  /**
   * Persist a notification and push it live. Returns the inserted row. Runs
   * inside the caller's transaction — never opens its own.
   */
  async create(input: NotificationCreateInput): Promise<Selectable<Notifications>> {
    const { recipientId, type, title, body, data, trx } = input;

    if (!NOTIFICATION_TYPES.includes(type)) {
      throw new AppError('VALIDATION_ERROR', `Unknown notification type: ${String(type)}`, {
        allowed: NOTIFICATION_TYPES,
      });
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

    // 2. Emit second — fire-and-forget; a socket failure must not lose the row.
    try {
      getIo().of(NOTIFY_NAMESPACE).to(`user:${recipientId}`).emit('notify:new', row);
    } catch (err) {
      logger.warn({ err, recipientId, notificationId: row.id }, 'notify:new emit failed');
    }

    return row;
  }
}