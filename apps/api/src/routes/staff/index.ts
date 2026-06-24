import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { StaffMeResponseSchema } from '@skaly/shared/schemas/auth';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { getEffectivePermissions } from '../../lib/permissions.js';

function sendAuthError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

/**
 * Barrel + handlers for the /v1/staff/* area (mounted with /v1 in app.ts).
 *
 *   GET /staff/me            — the authenticated user's profile + permissions (C-04)
 *   PUT /staff/:id/mfa/reset — admin clears a user's MFA so they re-enroll
 */
export default async function staffRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Current user (C-04 reference handler) ───────────────────────────
  r.get(
    '/staff/me',
    { preHandler: [app.verifyJwt], schema: { response: { 200: StaffMeResponseSchema } } },
    async (request) => {
      const u = request.user;
      const permissions = await getEffectivePermissions(app.db, u.id);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
        mfaEnrolled: u.mfa_enrolled,
        avatarUrl: u.avatar_url,
        permissions,
      };
    },
  );

  // ── Admin: reset a user's MFA ───────────────────────────────────────
  r.put(
    '/staff/:id/mfa/reset',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      try {
        await authService.resetMfa(request.params.id, request.user.id);
        return reply.status(204).send();
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );
}
