/**
 * /v1/content-dropper — Content Dropper HTTP surface (07-API-CONTRACT §9,
 * 08-AUTH-MATRIX §3–§4). Mounted with the /v1 prefix in app.ts.
 *
 * admin/manager only — BOTH read and write (team_member + freelancer → 403).
 * That's layer 2; ContentDropperService also asserts (layer 3). The service
 * opens its own transaction (Trigger-2 emits after COMMIT), so routes pass
 * app.db straight through — no route-level transaction.
 */
import { DropperQuerySchema, StageUpdateSchema } from '@skaly/shared';
import { z } from 'zod';

import { ContentDropperService } from '../../services/ContentDropperService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ─── Response schema (for Swagger; the DTO is typed in the service) ───────────
const PipelineSchema = z.object({
  id: z.string(),
  period: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  visitType: z.string().nullable(),
  lastShootDate: z.string().nullable(),
  rawReceivedAt: z.string().nullable(),
  finalsReadyAt: z.string().nullable(),
  postedAt: z.string().nullable(),
  comingShootDate: z.string().nullable(),
  comingShootSource: z.string().nullable(),
  version: z.number(),
  updatedBy: z
    .object({ staffId: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })
    .nullable(),
  status: z.enum(['Awaiting', 'Editing', 'Review', 'Posted']),
  stagesComplete: z.number(),
});

const IdParam = z.object({ id: z.string().uuid() });
const bearer = { security: [{ bearerAuth: [] }] };

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function contentDropperRoutes(app: FastifyInstance) {
  const service = new ContentDropperService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // admin/manager only for read AND write (Auth-Matrix §3–§4).
  const adminManager = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] };

  r.get(
    '/content-dropper',
    {
      ...adminManager,
      schema: {
        querystring: DropperQuerySchema,
        response: { 200: z.object({ data: z.array(PipelineSchema) }) },
        ...bearer,
      },
    },
    async (request) => ({ data: await service.getGrid(request.query.period, currentUser(request), app.db) }),
  );

  // Surfaces 400 STAGE_SEQUENCE_VIOLATION, 409 STALE_DATA, 423 PERIOD_LOCKED
  // (all thrown by the service, rendered by the global error handler).
  r.patch(
    '/content-dropper/:id/stage',
    {
      ...adminManager,
      schema: {
        params: IdParam,
        body: StageUpdateSchema,
        response: { 200: z.object({ data: PipelineSchema }) },
        ...bearer,
      },
    },
    async (request) => ({
      data: await service.updateStage(
        request.params.id,
        request.body.stage,
        currentUser(request),
        request.body.version,
        app.db,
      ),
    }),
  );
}
