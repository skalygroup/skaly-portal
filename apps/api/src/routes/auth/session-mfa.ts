import {
  PasswordResetRequestSchema,
  PasswordResetConfirmSchema,
  MfaVerifySchema,
  MfaEnrollResponseSchema,
  MfaRecoveryRedeemSchema,
  MfaRecoveryRedeemResponseSchema,
  MfaRecoveryRegenerateResponseSchema,
  MfaRecoveryStatusResponseSchema,
  SessionRefreshResponseSchema,
} from '@skaly/shared/schemas/auth';
import { z } from 'zod';

import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function sendAuthError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

// Reuse the shared password policy (10+ chars, upper/lower/digit/special).
const PasswordUpdateSchema = z.object({
  newPassword: PasswordResetConfirmSchema.shape.newPassword,
});

/**
 * Read the `aal` claim from an already-verified Bearer token. verifyJwt has
 * validated the signature/issuer/audience, so decoding the payload here is safe
 * — we only need to read the assurance level, not re-verify.
 */
function readAal(authorization: string | undefined): string | undefined {
  const token = (authorization ?? '').slice('Bearer '.length).trim();
  const segment = token.split('.')[1];
  if (!segment) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof payload.aal === 'string' ? payload.aal : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session + MFA routes (Sprint 1 STEP 8).
 *
 *   POST   /v1/auth/password-reset  — public, anti-enumeration, always 200
 *   POST   /v1/auth/refresh         — public, new session or 401
 *   DELETE /v1/auth/session         — revoke the caller's session (204)
 *   POST   /v1/auth/mfa/enroll      — start TOTP enrollment (QR + recovery codes)
 *   POST   /v1/auth/mfa/verify      — confirm enrollment (204)
 *
 * Sprint 11 STEP 8 — the recovery-code half:
 *
 *   POST   /v1/auth/mfa/recovery            — spend a code (aal1 is enough)
 *   POST   /v1/auth/mfa/failure             — report a failed TOTP challenge
 *   GET    /v1/auth/mfa/recovery            — remaining count (never the codes)
 *   POST   /v1/auth/mfa/recovery/regenerate — fresh set, returned once (aal2)
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

  // ── Password update (authenticated, aal2) ───────────────────────────
  // Completes the recovery flow: after the reset link establishes a recovery
  // session and the user clears the authenticator step (aal2), the new password
  // is written with the service role. This bypasses GoTrue's "Secure password
  // change" reauthentication gate, which a client-side updateUser cannot satisfy
  // once the MFA step-up has consumed the recovery exemption. Requiring aal2
  // ensures a bare (un-stepped-up) session can't use this to change a password.
  r.post(
    '/auth/password/update',
    {
      preHandler: [app.verifyJwt],
      schema: { body: PasswordUpdateSchema, security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      if (readAal(request.headers.authorization) !== 'aal2') {
        return reply
          .status(403)
          .send({ error: { code: 'MFA_REQUIRED', message: 'Multi-factor verification required.' } });
      }
      try {
        await authService.updateOwnPassword(
          request.user.id,
          request.user.supabase_uid,
          request.body.newPassword,
        );
        return reply.status(204).send();
      } catch (err) {
        return sendAuthError(err, reply);
      }
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
  r.delete(
    '/auth/session',
    { preHandler: [app.verifyJwt], schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
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
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: MfaEnrollResponseSchema }, security: [{ bearerAuth: [] }] },
    },
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
    { preHandler: [app.verifyJwt], schema: { body: MfaVerifySchema, security: [{ bearerAuth: [] }] } },
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

  // ── Recovery-code redeem (authenticated, aal1 is enough) ────────────
  //
  // NOT aal2-gated, and that is the whole point: the caller has passed password
  // auth and cannot pass the authenticator step, which is the situation this
  // endpoint exists for. Requiring aal2 would make it reachable only by people
  // who do not need it.
  r.post(
    '/auth/mfa/recovery',
    {
      preHandler: [app.verifyJwt],
      schema: {
        body: MfaRecoveryRedeemSchema,
        response: { 200: MfaRecoveryRedeemResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.redeemRecoveryCode(
          request.user.id,
          request.user.supabase_uid,
          request.body.code,
        );
        return reply.status(200).send(result);
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Report a failed TOTP challenge (authenticated) ──────────────────
  //
  // The login challenge runs client-side against the user's own Supabase
  // session — the API never sees the TOTP code — so this is the only way a
  // failed authenticator attempt can reach the SHARED failure budget. Without
  // it the "3 attempts" in AUTH-MATRIX §10 would silently mean three per
  // credential type.
  //
  // Self-inflicted only: it is authenticated, so the worst a caller can do with
  // it is lock themselves out for 15 minutes.
  r.post(
    '/auth/mfa/failure',
    { preHandler: [app.verifyJwt], schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      await authService.recordMfaFailure(request.user.id);
      return reply.status(204).send();
    },
  );

  // ── Remaining recovery codes (authenticated) ────────────────────────
  // The COUNT only. There is no endpoint that returns the codes themselves.
  r.get(
    '/auth/mfa/recovery',
    {
      preHandler: [app.verifyJwt],
      schema: { response: { 200: MfaRecoveryStatusResponseSchema }, security: [{ bearerAuth: [] }] },
    },
    async (request) => ({
      remainingCodes: await authService.remainingRecoveryCodes(request.user.id),
    }),
  );

  // ── Regenerate recovery codes (authenticated, aal2) ─────────────────
  // aal2 HERE, unlike redeem: issuing a fresh set from a session that never
  // cleared the authenticator step would let a stolen password mint its own
  // recovery codes and invalidate the real owner's.
  r.post(
    '/auth/mfa/recovery/regenerate',
    {
      preHandler: [app.verifyJwt],
      schema: {
        response: { 200: MfaRecoveryRegenerateResponseSchema },
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        if (readAal(request.headers.authorization) !== 'aal2') {
          // Thrown rather than replied so it goes out through sendAuthError —
          // the route declares a 200 response schema, and a direct 403 reply
          // would have to satisfy it.
          throw new AuthError('MFA_REQUIRED', 403, 'Multi-factor verification required.');
        }
        const result = await authService.regenerateRecoveryCodes(request.user.id);
        return reply.status(200).send(result);
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );
}
