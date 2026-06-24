import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { InviteCreateSchema, SignupViaInviteSchema } from '@skaly/shared/schemas/auth';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';

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
      schema: { body: InviteCreateSchema },
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
