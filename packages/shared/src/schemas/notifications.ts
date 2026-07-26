import { z } from 'zod';

import { NOTIFICATION_TYPES } from '../constants/notifications';

/**
 * Notification wire schemas (07-API-CONTRACT §Notifications).
 *
 * `.strict()` throughout: an unknown field is a caller bug or a stale client, and
 * silently dropping it is how a "why didn't my filter apply" ticket is born.
 */

/**
 * The bell window. 50 by default AND by maximum — audit L-07 makes the last-50 window
 * a deliberate decision rather than a default: older notifications stay queryable in
 * the DB but are not surfaced in the panel. Revisit above ~500 users.
 *
 * No pagination cursor in MVP for the same reason. `NotificationService.list` already
 * supports keyset paging, so raising this later is a route change, not a rewrite.
 */
export const NOTIFICATION_PAGE_LIMIT = 50;

export const NotificationTypeSchema = z.enum(
  NOTIFICATION_TYPES as unknown as [string, ...string[]],
);

export const NotificationListQuerySchema = z
  .object({
    /** `?unread=true` for the badge's own list; omitted returns read + unread. */
    unread: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_LIMIT).optional(),
  })
  .strict();

export const NotificationSchema = z
  .object({
    id: z.string().uuid(),
    type: NotificationTypeSchema,
    title: z.string(),
    /** `notifications.message` — named `body` at the boundary, as producers write it. */
    body: z.string().nullable(),
    payload: z.record(z.unknown()),
    isRead: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

/**
 * `meta.unreadCount` rides the list response so the bell renders its badge and its
 * panel from ONE request. Fetching them separately is how the badge and the panel end
 * up disagreeing — the classic symptom being a count with an empty list behind it.
 */
export const NotificationListResponseSchema = z
  .object({
    data: z.array(NotificationSchema),
    meta: z
      .object({
        unreadCount: z.number().int().min(0),
        totalReturned: z.number().int().min(0),
        limit: z.number().int().min(1),
      })
      .strict(),
  })
  .strict();

export const MarkReadResponseSchema = z
  .object({ data: z.object({ read: z.literal(true) }).strict() })
  .strict();

export const MarkAllReadResponseSchema = z
  .object({ data: z.object({ updatedCount: z.number().int().min(0) }).strict() })
  .strict();

export type NotificationDTO = z.infer<typeof NotificationSchema>;
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;
