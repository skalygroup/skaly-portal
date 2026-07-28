import { z } from 'zod';

import { MonthService } from '../../services/MonthService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const MonthItemSchema = z.object({
  period: z.string(),
  label: z.string(),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  lockedByName: z.string().nullable(),
  unlockedAt: z.string().nullable(),
  unlockedBy: z.string().nullable(),
  unlockedByName: z.string().nullable(),
  unlockReason: z.string().nullable(),
  createdAt: z.string(),
});

const PeriodParam = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM') });

/**
 * /v1/months — mounted with the /v1 prefix in app.ts.
 *
 *   GET    /months               — all months, newest first (all roles)
 *   GET    /months/current       — the current IST month row (all roles)
 *   POST   /months/:period/lock  — admin only
 *   DELETE /months/:period/lock  — admin only, REASON REQUIRED
 */
export default async function monthsRoutes(app: FastifyInstance) {
  const service = new MonthService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/months',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: z.object({ data: z.array(MonthItemSchema) }) }, security: [{ bearerAuth: [] }] },
    },
    async () => ({ data: await service.list(app.db) }),
  );

  r.get(
    '/months/current',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: z.object({ data: MonthItemSchema }) }, security: [{ bearerAuth: [] }] },
    },
    async () => ({ data: await service.current(app.db) }),
  );

  const adminOnly = { preHandler: [app.verifyJwt, app.requireRole('admin')] };

  // Lock: every module goes read-only for that period.
  r.post(
    '/months/:period/lock',
    {
      ...adminOnly,
      schema: {
        params: PeriodParam,
        response: { 200: z.object({ data: MonthItemSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      return { data: await service.lock(request.params.period, currentUser, app.db) };
    },
  );

  // Unlock: DELETE the lock. The reason is not optional — reopening a closed
  // month is the only action on this screen that rewrites history, and
  // UNLOCK_REASON_REQUIRED is what the panel maps onto the reason field.
  r.delete(
    '/months/:period/lock',
    {
      ...adminOnly,
      schema: {
        // No body schema on purpose. A missing body would fail Zod as
        // VALIDATION_ERROR, and the canonical code for this is
        // UNLOCK_REASON_REQUIRED (09-ERROR-HANDLING §2) — which the panel maps
        // onto the reason field. The requirement is a business rule, so the
        // service owns it, and there is exactly one gate rather than two that
        // answer differently depending on whether you sent `{}` or nothing.
        params: PeriodParam,
        response: { 200: z.object({ data: MonthItemSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const { reason } = (request.body ?? {}) as { reason?: string };
      return { data: await service.unlock(request.params.period, reason, currentUser, app.db) };
    },
  );
}