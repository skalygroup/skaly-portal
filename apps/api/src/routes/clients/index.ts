import { z } from 'zod';

import { AppError } from '../../lib/errors.js';
import { ClientService } from '../../services/ClientService.js';

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
}