import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  PasswordResetRequestSchema,
  MfaVerifySchema,
  MfaEnrollResponseSchema,
  SessionRefreshResponseSchema,
} from '@skaly/shared/schemas/auth';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';

function sendAuthError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

/**
 * Session + MFA routes (Sprint 1 STEP 8).
 *
 *   POST   /v1/auth/password-reset  — public, anti-enumeration, always 200
 *   POST   /v1/auth/refresh         — public, new session or 401
 *   DELETE /v1/auth/session         — revoke the caller's session (204)
 *   POST   /v1/auth/mfa/enroll      — start TOTP enrollment (QR + recovery codes)
 *   POST   /v1/auth/mfa/verify      — confirm enrollment (204)
 */
export async function sessionMfaRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Password reset request (public) ─────────────────────────────────
  // Always 200, whether or not the email exists — anti-enumeration (M-08).
  r.post(
    '/auth/password-reset',
    { schema: { body: PasswordResetRequestSchema } },
    async (request, reply) => {
      await authService.requestPasswordReset(request.body.email);
      return reply.status(200).send({ status: 'sent' });
    },
  );

  // ── Session refresh (public) ────────────────────────────────────────
  r.post(
    '/auth/refresh',
    { schema: { body: RefreshSchema, response: { 200: SessionRefreshResponseSchema } } },
    async (request, reply) => {
      try {
        const session = await authService.refreshSession(request.body.refreshToken);
        return reply.status(200).send(session);
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Sign out (authenticated) ────────────────────────────────────────
  r.delete('/auth/session', { preHandler: [app.verifyJwt] }, async (request, reply) => {
    // The bearer token is what Supabase's admin.signOut revokes; verifyJwt has
    // already validated it, so the prefix is guaranteed present here.
    const jwt = (request.headers.authorization ?? '').slice('Bearer '.length).trim();
    await authService.signOut(request.user.supabase_uid, jwt);
    return reply.status(204).send();
  });

  // ── MFA enroll (authenticated) ──────────────────────────────────────
  // Recovery codes are returned exactly once here — there is no "show again"
  // endpoint (they belong in the user's password manager / printed sheet).
  r.post(
    '/auth/mfa/enroll',
    { preHandler: [app.verifyJwt], schema: { response: { 200: MfaEnrollResponseSchema } } },
    async (request, reply) => {
      try {
        const result = await authService.enrollMfa(request.user.id, request.user.supabase_uid);
        return reply.status(200).send(result);
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── MFA verify (authenticated) ──────────────────────────────────────
  r.post(
    '/auth/mfa/verify',
    { preHandler: [app.verifyJwt], schema: { body: MfaVerifySchema } },
    async (request, reply) => {
      try {
        await authService.verifyMfa(
          request.user.id,
          request.user.supabase_uid,
          request.body.factorId,
          request.body.code,
        );
        return reply.status(204).send();
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );
}
