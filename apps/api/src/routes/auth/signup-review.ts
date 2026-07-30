import { SignupApproveSchema, SignupRejectSchema } from '@skaly/shared/schemas/auth';
import { z } from 'zod';

import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket, getR2DownloadUrl } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function sendAuthError(err: unknown, reply: FastifyReply): never | FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

/**
 * Admin-only signup review routes: approve, reject, and CV download. (The admin
 * LIST view lives in routes/settings/signup-requests.ts.) Paths are area-
 * relative; the /v1 prefix is applied by the auth barrel in app.ts.
 */
export async function signupReviewRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );
  const r = app.withTypeProvider<ZodTypeProvider>();
  const adminOnly = { preHandler: [app.verifyJwt, app.requireRole('admin')] };

  // ── Approve ─────────────────────────────────────────────────────────
  r.post(
    '/auth/signup-requests/:id/approve',
    {
      ...adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: SignupApproveSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.approveSignupRequest(
          request.params.id,
          request.body.roleAssigned,
          request.user.id,
        );
        return reply
          .status(200)
          .send({ staffId: result.staffId, attendanceRowsCreated: result.attendanceRowsCreated });
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Approve BY REINSTATING (ADR-026 §4, the other half of A4) ───────
  // The admin's answer to the question `approve` asks when it finds a tombstone.
  // No body: the role comes from the old staff row, not from the request — this
  // reinstates a person, it does not decide what they are.
  r.post(
    '/auth/signup-requests/:id/reinstate',
    {
      ...adminOnly,
      schema: { params: z.object({ id: z.string().uuid() }), security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      try {
        const result = await authService.reinstateFromSignupRequest(
          request.params.id,
          request.user.id,
        );
        return reply.status(200).send(result);
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── Reject ──────────────────────────────────────────────────────────
  r.post(
    '/auth/signup-requests/:id/reject',
    {
      ...adminOnly,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: SignupRejectSchema,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.rejectSignupRequest(
          request.params.id,
          request.body.rejectionNote,
          request.body.publicRejectionMessage,
          request.user.id,
        );
        // Note: rejectionNote is intentionally NOT echoed back.
        return reply.status(200).send({ status: result.status });
      } catch (err) {
        return sendAuthError(err, reply);
      }
    },
  );

  // ── CV download (presigned, 1-hour TTL) ─────────────────────────────
  r.get(
    '/auth/signup-requests/:id/cv',
    {
      ...adminOnly,
      schema: { params: z.object({ id: z.string().uuid() }), security: [{ bearerAuth: [] }] },
    },
    async (request, reply) => {
      const row = await app.db
        .selectFrom('signup_requests')
        .select('cv_file_key')
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!row) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
      }
      if (!row.cv_file_key) {
        return reply.status(404).send({ error: { code: 'NO_CV', message: 'No CV on this request.' } });
      }
      const url = await getR2DownloadUrl(row.cv_file_key, 3600);
      return reply.status(200).send({ url });
    },
  );
}
