import { z } from 'zod';

import { ReportService } from '../../services/ReportService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const ReportItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  period: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  status: z.string(),
  errorMessage: z.string().nullable(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  requestedBy: z.string().nullable(),
});

/**
 * /v1/reports — admin + manager (Auth-Matrix §4).
 *
 *   POST /reports/generate — 202 + { reportId }. No PDF, no link.
 *   GET  /reports/:id      — status; a FRESH presigned link once ready.
 *   GET  /reports          — the panel's recent list.
 *
 * ⚠️ 07-API-CONTRACT §Reports still documents the SYNCHRONOUS contract: a 200
 * carrying `downloadUrl` straight from the generate call. ADR-027 supersedes it —
 * that shape requires the render to finish inside the request, which is the exact
 * thing that takes the instance down at month end. The async contract is the ADR's
 * whole subject; the 202 is its signature.
 *
 * The contract's separate `GET /reports/:id/download` is folded into `GET
 * /reports/:id`, which now has to exist anyway for status. It returned a fresh
 * presigned URL and nothing else; a poll that already answers "ready" may as well
 * answer with the link, and one endpoint cannot disagree with itself about whether
 * a report is downloadable.
 */
export default async function reportsRoutes(app: FastifyInstance) {
  const service = new ReportService();
  const r = app.withTypeProvider<ZodTypeProvider>();
  const staffOnly = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] };

  r.post(
    '/reports/generate',
    {
      ...staffOnly,
      schema: {
        body: z.object({
          type: z.enum(['client_monthly', 'org_monthly']),
          period: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'),
          clientId: z.string().uuid().optional(),
        }),
        response: {
          202: z.object({
            data: z.object({ reportId: z.string(), status: z.literal('pending') }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const data = await service.generate(request.body, currentUser, app.db);
      // 202, not 200: the work is accepted, not done. The UI says so too — a user
      // who thinks the tab must stay open will keep it open.
      return reply.status(202).send({ data });
    },
  );

  r.get(
    '/reports/:id',
    {
      ...staffOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            data: ReportItemSchema.extend({ downloadUrl: z.string().nullable() }),
          }),
        },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      return { data: await service.get(request.params.id, currentUser, app.db) };
    },
  );

  r.get(
    '/reports',
    {
      ...staffOnly,
      schema: {
        querystring: z.object({
          period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: { 200: z.object({ data: z.array(ReportItemSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      return { data: await service.list(request.query, currentUser, app.db) };
    },
  );
}
