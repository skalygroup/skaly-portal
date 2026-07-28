import {
  MarkAllReadResponseSchema,
  MarkReadResponseSchema,
  NOTIFICATION_PAGE_LIMIT,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
} from '@skaly/shared';
import { z } from 'zod';

import { transactionWithEmits } from '../../lib/emit-after-commit.js';
import { NotificationService } from '../../services/NotificationService.js';

import type { Notifications } from '@skaly/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Selectable } from 'kysely';

/**
 * /v1/notifications — mounted with the /v1 prefix in app.ts.
 *
 * Every authenticated role. The routes do NOT filter by recipient: the service scopes
 * every read and write to `currentUser.staffId`, so a route that forgot the check
 * cannot leak or mutate someone else's bell. Same discipline as the other modules —
 * the service is the security boundary.
 *
 *   GET /notifications?unread=&limit=   — the last 50, newest first, + unreadCount
 *   PUT /notifications/:id/read         — mark one read
 *   PUT /notifications/read-all         — mark every unread read
 *
 * METHOD NOTE: PUT, not PATCH/POST. 07-API-CONTRACT §Notifications and
 * 06-IMPLEMENTATION-PLAN §13 both specify PUT; the Sprint 10 guide's PATCH/POST is the
 * outlier and the numbered specs win on precedence.
 */
const toDTO = (row: Selectable<Notifications>) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  // `message` in the column, `body` at the boundary — the name producers use.
  body: row.message,
  payload: (row.payload ?? {}) as Record<string, unknown>,
  isRead: row.is_read,
  createdAt: row.created_at.toISOString(),
});

export default async function notificationsRoutes(app: FastifyInstance) {
  const service = new NotificationService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  const authed = { preHandler: [app.verifyJwt] };
  const staffIdOf = (request: FastifyRequest): string => request.user!.id;

  r.get(
    '/notifications',
    {
      ...authed,
      schema: {
        querystring: NotificationListQuerySchema,
        response: { 200: NotificationListResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const staffId = staffIdOf(request);
      const limit = request.query.limit ?? NOTIFICATION_PAGE_LIMIT;

      // Both in one request, deliberately. The badge and the panel must never be able
      // to disagree — fetching the count separately is how you get a "3" over an empty
      // list, which reads as a broken bell and is really two sources of truth.
      const [page, unreadCount] = await Promise.all([
        service.list(staffId, { unreadOnly: request.query.unread, limit }, app.db),
        service.unreadCount(staffId, app.db),
      ]);

      return {
        data: page.items.map(toDTO),
        meta: { unreadCount, totalReturned: page.items.length, limit },
      };
    },
  );

  r.put(
    '/notifications/:id/read',
    {
      ...authed,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: MarkReadResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      // Wrapped so notify:read reaches the caller's other tabs only after the write
      // commits — a rolled-back mark-read that already cleared the badge elsewhere
      // leaves those tabs permanently out of step with the database.
      await transactionWithEmits(app.db, (trx) =>
        service.markRead(request.params.id, staffIdOf(request), trx),
      );
      return { data: { read: true as const } };
    },
  );

  r.put(
    '/notifications/read-all',
    {
      ...authed,
      schema: {
        response: { 200: MarkAllReadResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const updatedCount = await transactionWithEmits(app.db, (trx) =>
        service.markAllRead(staffIdOf(request), trx),
      );
      return { data: { updatedCount } };
    },
  );
}
