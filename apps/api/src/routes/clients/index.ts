import { ClientCreateSchema, ClientNameSchema } from '@skaly/shared';
import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import { ClientService } from '../../services/ClientService.js';

import type { CurrentUser } from '../../services/AttendanceService.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const ClientItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  isInternal: z.boolean(),
  active: z.boolean(),
  shootSlotsPerMonth: z.number(),
  piecesPerVisit: z.number(),
  whatsappNumber: z.string().nullable(),
  createdAt: z.string(),
});

const IdParam = z.object({ id: z.string().uuid() });

/**
 * /v1/clients — mounted with the /v1 prefix in app.ts.
 *
 *   GET /clients?includeInactive=true — all roles see active clients; only
 *   admins may pass includeInactive (403 otherwise). Soft-deleted excluded.
 */
export default async function clientsRoutes(app: FastifyInstance) {
  const service = new ClientService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/clients',
    {
      preHandler: [app.verifyJwt],
      schema: {
        // A literal 'true'/'false' string, transformed to boolean. z.coerce.boolean
        // is unusable here — it maps the string 'false' to true.
        querystring: z.object({
          includeInactive: z
            .enum(['true', 'false'])
            .optional()
            .default('false')
            .transform((v) => v === 'true'),
        }),
        response: { 200: z.object({ data: z.array(ClientItemSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const includeInactive = request.query.includeInactive;
      if (includeInactive && request.user.role !== 'admin') {
        throw new AppError('PERMISSION_DENIED', 'Permission denied.');
      }
      const data = await service.list({ includeInactive }, app.db);
      return { data };
    },
  );

  // Create a client. admin/manager (Auth-Matrix §3). The service generates the
  // current period's shoot/pipeline/calendar rows in the same transaction.
  r.post(
    '/clients',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')],
      schema: {
        body: ClientCreateSchema,
        response: { 201: z.object({ data: ClientItemSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const data = await service.create(request.body, currentUser, app.db);
      return reply.status(201).send({ data });
    },
  );

  // Deactivate a client — soft-delete + active=false. admin only; history kept.
  r.delete(
    '/clients/:id',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        params: IdParam,
        response: { 200: z.object({ data: z.object({ deactivated: z.literal(true) }) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      return { data: await service.deactivate(request.params.id, currentUser, app.db) };
    },
  );

  // Reactivate a client — deactivate's undo (ADR-026 §2). admin only. The
  // service regenerates the current period's shoot/pipeline/calendar rows via
  // the same backfill create uses.
  r.put(
    '/clients/:id/reactivate',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        params: IdParam,
        response: { 200: z.object({ data: ClientItemSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      return { data: await service.reactivate(request.params.id, currentUser, app.db) };
    },
  );

  // Client name inline edit (04-APPFLOW §7). admin/manager only; clients is not
  // versioned → last-write-wins. The frontend invalidates every clientId-keyed
  // query so the rename propagates across modules.
  r.patch(
    '/clients/:id',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')],
      schema: {
        params: IdParam,
        body: ClientNameSchema,
        response: { 200: z.object({ data: ClientItemSchema }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => {
      const currentUser: CurrentUser = { staffId: request.user.id, role: request.user.role };
      const data = await service.rename(request.params.id, request.body.name, currentUser, app.db);
      return { data };
    },
  );
}