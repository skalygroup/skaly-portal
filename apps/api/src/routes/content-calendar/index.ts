/**
 * /v1/content-calendar — Content Calendar HTTP surface (07-API-CONTRACT
 * §Content Calendar, 08-AUTH-MATRIX §3–§4). Mounted with the /v1 prefix in app.ts.
 *
 * The two verbs have DIFFERENT role sets — this is the whole of the read-only
 * team_member rule:
 *   GET   — admin, manager, team_member (👁 read)   · freelancer → 403
 *   PATCH — admin, manager                          · team_member → 403
 * That's layer 2; ContentCalendarService asserts again (layer 3). The frontend's
 * `pointer-events: none` for team_member is UX only — this is the boundary.
 *
 * updateCell opens its own transaction, so routes pass app.db straight through.
 */
import { CalendarQuerySchema, CellUpdateSchema } from '@skaly/shared';
import { z } from 'zod';

import { ContentCalendarService } from '../../services/ContentCalendarService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ─── Response schemas (for Swagger; the DTOs are typed in the service) ────────
const CellSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  date: z.string(),
  status: z.string(),
  note: z.string().nullable(),
  source: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ staffId: z.string(), name: z.string().nullable() }).nullable(),
});

const GridSchema = z.object({
  cells: z.array(CellSchema),
  clients: z.array(z.object({ id: z.string(), name: z.string() })),
});

const IdParam = z.object({ id: z.string().uuid() });
const bearer = { security: [{ bearerAuth: [] }] };

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function contentCalendarRoutes(app: FastifyInstance) {
  const service = new ContentCalendarService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/content-calendar',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin', 'manager', 'team_member')],
      schema: {
        querystring: CalendarQuerySchema,
        response: { 200: z.object({ data: GridSchema }) },
        ...bearer,
      },
    },
    async (request) => ({ data: await service.getGrid(request.query.period, currentUser(request), app.db) }),
  );

  // Surfaces 400 VALIDATION_ERROR (bad status, over-long note, or a `source`
  // field — CellUpdateSchema is .strict()), 409 STALE_DATA with currentVersion +
  // updatedBy, and 423 PERIOD_LOCKED. All thrown by the service / validator and
  // rendered by the global error handler.
  r.patch(
    '/content-calendar/:id',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')],
      schema: {
        params: IdParam,
        body: CellUpdateSchema,
        response: { 200: z.object({ data: CellSchema }) },
        ...bearer,
      },
    },
    async (request) => {
      const { version, ...patch } = request.body;
      return {
        data: await service.updateCell(request.params.id, patch, currentUser(request), version, app.db),
      };
    },
  );
}
