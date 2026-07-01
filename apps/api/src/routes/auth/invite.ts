import {
  InviteCreateSchema,
  InviteCheckResponseSchema,
  SignupViaInviteSchema,
} from '@skaly/shared/schemas/auth';
import { z } from 'zod';

import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * Invite-based onboarding routes.
 *
 *   POST /v1/auth/invite          — admin creates an invite + sends the email
 *   POST /v1/auth/signup/invite   — public: redeem a token to provision an account
 */
export async function inviteRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Admin only — create an invite link and trigger the Supabase invite email.
  r.post(
    '/auth/invite',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: { body: InviteCreateSchema, security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      const { email, role } = request.body;
      const invite = await authService.createInvite({
        email,
        role,
        createdBy: request.user.id,
      });
      return reply.status(201).send({
        id: invite.id,
        token: invite.token,
        expiresAt: invite.expiresAt,
        email: invite.email,
        role: invite.role,
      });
    },
  );

  // Public — pre-validate a token so the redemption page can show the scoped
  // email/role and auto-login after redeem. Rate-limited to deter enumeration.
  r.get(
    '/auth/invite/:token/check',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        params: z.object({ token: z.string().min(1) }),
        response: {
          200: InviteCheckResponseSchema,
          404: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
          409: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
          410: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
        },
      },
    },
    async (request, reply) => {
      try {
        const { email, role } = await authService.checkInvite(request.params.token);
        return reply.status(200).send({ email, role: role as never });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply
            .status(err.statusCode as 404 | 409 | 410)
            .send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // Public — redeem an invite token. The frontend follows with a password
  // grant against Supabase to obtain a session.
  r.post(
    '/auth/signup/invite',
    { schema: { body: SignupViaInviteSchema } },
    async (request, reply) => {
      try {
        const { staffId } = await authService.consumeInviteSignup(request.body);
        return reply.status(201).send({ staffId });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply
            .status(err.statusCode)
            .send({ error: { code: err.code, message: err.message } });
        }
        throw err; // unexpected → Fastify default 500
      }
    },
  );
}
