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

import type { FastifyInstance, FastifyRequest } from 'fastify';
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
      // API-Contract §2: staffId, 5 / hour. Keyed off the JWT rather than the IP —
      // ADR-024's rule, and here it also means one admin cannot burn the office's
      // budget for the other admins. Found missing by the STEP 8 sweep.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req: FastifyRequest) => req.headers.authorization ?? req.ip,
        },
      },
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
    {
      // ⭐ API-Contract §2: 10 attempts / 15 minutes, keyed by IDENTITY + IP.
      // The largest gap the STEP 8 sweep found — the invite-REDEMPTION path, the
      // one that turns a token into an account, had no route-level limit at all
      // and was inheriting the global 150/min.
      //
      // The identity here is the TOKEN, not the email §2's snippet uses. That
      // snippet was written against a login body; this body carries no email at
      // all (SignupViaInviteSchema is token/password/name/dob/mobile — the email is
      // bound to the token server-side). Reading `body.email` would have yielded
      // `undefined` on every request and quietly collapsed the key to the bare IP,
      // which is the one outcome §2's key-design note exists to forbid: Skaly's
      // staff share an office address, so several people redeeming invites the same
      // morning would 429 each other.
      //
      // What the token key does NOT bound is enumeration — a fresh guess is a fresh
      // bucket. That is deliberately left to the global 150/min per IP and to the
      // tokens being ≥32 random chars; this limit's job is the per-invite retry
      // budget, not the search space.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (req: FastifyRequest) =>
            `${(req.body as { token?: string } | undefined)?.token ?? 'unknown'}:${req.ip}`,
        },
      },
      schema: { body: SignupViaInviteSchema },
    },
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
