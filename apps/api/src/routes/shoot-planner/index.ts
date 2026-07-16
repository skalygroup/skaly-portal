/**
 * /v1/shoot-planner — Shoot Planner HTTP surface (07-API-CONTRACT §8,
 * 08-AUTH-MATRIX §4). Mounted with the /v1 prefix in app.ts.
 *
 * GET is open to all four roles at the route — freelancer isolation is the
 * SERVICE's job (query-level predicate, ADR-011), so the route must not
 * accidentally block freelancers. PATCH/reset are admin/manager (layer 2) AND
 * asserted in the service (layer 3). The slot-count adjust is admin-only.
 *
 * The service opens its own transactions (Trigger-1 emits fire after COMMIT),
 * so routes pass app.db straight through — no route-level transaction.
 */
import { ShootQuerySchema, SlotUpdateSchema, SlotResetSchema, SlotCountSchema } from '@skaly/shared';
import { z } from 'zod';

import { ShootPlannerService } from '../../services/ShootPlannerService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// ─── Response schemas (for Swagger; the DTOs are typed in the service) ────────

const SlotSchema = z.object({
  id: z.string(),
  period: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  slotIndex: z.number(),
  slotStatus: z.string(),
  slotDate: z.string().nullable(),
  piecesExpected: z.number(),
  freelancerId: z.string().nullable(),
  freelancerName: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const GridSchema = z.object({
  slots: z.array(SlotSchema),
  clients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      shootSlotsPerMonth: z.number(),
      piecesPerVisit: z.number(),
    }),
  ),
});

const IdParam = z.object({ id: z.string().uuid() });
const bearer = { security: [{ bearerAuth: [] }] };

function currentUser(request: FastifyRequest): CurrentUser {
  return { staffId: request.user.id, role: request.user.role };
}

export default async function shootPlannerRoutes(app: FastifyInstance) {
  const service = new ShootPlannerService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  // All four roles read; the service applies the freelancer predicate (ADR-011).
  const readRoles = {
    preHandler: [app.verifyJwt, app.requireRole('admin', 'manager', 'team_member', 'freelancer')],
  };
  // Writes: admin/manager only — team_member and freelancer → 403.
  const writeRoles = { preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')] };
  const adminOnly = { preHandler: [app.verifyJwt, app.requireRole('admin')] };

  r.get(
    '/shoot-planner',
    { ...readRoles, schema: { querystring: ShootQuerySchema, response: { 200: z.object({ data: GridSchema }) }, ...bearer } },
    async (request) => ({ data: await service.getGrid(request.query.period, currentUser(request), app.db) }),
  );

  // Single slot — the freelancer non-owned → 404 surface (ADR-011, tested in E2E).
  r.get(
    '/shoot-planner/:id',
    { ...readRoles, schema: { params: IdParam, response: { 200: z.object({ data: SlotSchema }) }, ...bearer } },
    async (request) => ({ data: await service.getSlot(request.params.id, currentUser(request), app.db) }),
  );

  r.patch(
    '/shoot-planner/:id',
    { ...writeRoles, schema: { params: IdParam, body: SlotUpdateSchema, response: { 200: z.object({ data: SlotSchema }) }, ...bearer } },
    async (request) => ({ data: await service.update(request.params.id, request.body, currentUser(request), app.db) }),
  );

  r.post(
    '/shoot-planner/:id/reset',
    {
      ...writeRoles,
      schema: { params: IdParam, body: SlotResetSchema, response: { 200: z.object({ data: z.object({ reset: z.literal(true) }) }) }, ...bearer },
    },
    // The service returns 400 SHOOT_RESET_CONFIRMATION_REQUIRED on a missing/false confirm.
    async (request) => ({
      data: await service.reset(request.params.id, currentUser(request), request.body.confirm, app.db),
    }),
  );

  r.patch(
    '/clients/:id/shoot-slots',
    {
      ...adminOnly,
      schema: {
        params: IdParam,
        body: SlotCountSchema,
        response: {
          200: z.object({
            data: z.object({
              clientId: z.string(),
              shootSlotsPerMonth: z.number(),
              slotsAdded: z.number(),
              slotsRemoved: z.number(),
            }),
          }),
        },
        ...bearer,
      },
    },
    async (request) => ({
      data: await service.adjustSlotCount(request.params.id, request.body.slotsPerMonth, currentUser(request), app.db),
    }),
  );
}
