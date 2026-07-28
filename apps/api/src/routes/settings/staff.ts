import { z } from 'zod';

import { StaffService } from '../../services/StaffService.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * The panel row. UIUX §15 renders Name · Role · Status · Joined · Actions; the
 * three optional fields are what an ADMIN additionally needs in order to act, and
 * are OMITTED (not nulled) for a manager — Auth-Matrix §3 gives them 👁 limited.
 */
const StaffSettingsItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  avatarUrl: z.string().nullable(),
  active: z.boolean(),
  joinedAt: z.string(),
  email: z.string().optional(),
  mfaEnrolled: z.boolean().optional(),
  deactivatedAt: z.string().nullable().optional(),
});

/**
 * GET /v1/settings/staff — the Settings → Staff panel's list.
 *
 * Separate from `GET /v1/staff`, which is the limited dropdown/@mention list every
 * role gets and half the product already consumes. Widening that one to carry
 * email, MFA state and tombstones would push admin-shaped data into every caller
 * that only ever wanted a name.
 *
 * Auth-Matrix §4 names no staff-LIST endpoint either way; this mirrors its sibling
 * `/v1/settings/signup-requests`, and the service does the field filtering.
 */
export async function settingsStaffRoutes(app: FastifyInstance) {
  const service = new StaffService();
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/settings/staff',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin', 'manager')],
      schema: {
        response: { 200: z.object({ data: z.array(StaffSettingsItemSchema) }) },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => ({ data: await service.listForSettings(request.user.role, app.db) }),
  );
}
