import { z } from 'zod';

import { HolidayService } from '../../services/HolidayService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM');
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const HolidaySchema = z.object({
  id: z.string(),
  period: z.string(),
  date: z.string(),
  name: z.string(),
});

/**
 * /v1/holidays — mounted with the /v1 prefix in app.ts. admin + manager only
 * (AUTH-MATRIX §4 / FR-ATT-09) — team_member and freelancer 403.
 *
 *   GET    /holidays?period=YYYY-MM  — active holidays for the period
 *   POST   /holidays                 — add a holiday (flips working → holiday)
 *   DELETE /holidays/:id             — SOFT remove + revert holiday → working (H-01)
 */
export default async function holidaysRoutes(app: FastifyInstance) {
  const service = new HolidayService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  const adminManager = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] };

  r.get(
    '/holidays',
    {
      ...adminManager,
      schema: {
        querystring: z.object({ period: PeriodSchema }),
        response: { 200: z.object({ data: z.array(HolidaySchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({ data: await service.list(request.query.period, app.db) }),
  );

  r.post(
    '/holidays',
    {
      ...adminManager,
      schema: {
        body: z.object({ period: PeriodSchema, date: DateSchema, name: z.string().min(1).max(100) }),
        response: { 201: z.object({ data: HolidaySchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const { period, date, name } = request.body;

      const holiday = await app.db
        .transaction()
        .execute((trx) => service.create({ period, date, name, currentUser, trx }));

      return reply.status(201).send({ data: { id: holiday.id, period, date, name } });
    },
  );

  r.delete(
    '/holidays/:id',
    {
      ...adminManager,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ data: z.object({ removed: z.literal(true) }) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const result = await app.db
        .transaction()
        .execute((trx) => service.remove(request.params.id, currentUser, trx));
      return { data: result };
    },
  );
}
