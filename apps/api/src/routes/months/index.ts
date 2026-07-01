import { z } from 'zod';

import { MonthService } from '../../services/MonthService.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const MonthItemSchema = z.object({
  period: z.string(),
  label: z.string(),
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  unlockedAt: z.string().nullable(),
  unlockedBy: z.string().nullable(),
  unlockReason: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * /v1/months — mounted with the /v1 prefix in app.ts. Reads for all
 * authenticated roles (the lock/unlock mutations are Sprint 12, admin-only).
 *
 *   GET /months          — all months, newest first
 *   GET /months/current  — the current IST month row
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
}