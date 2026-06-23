import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SignupApproveSchema, SignupRejectSchema } from '@skaly/shared/schemas/auth';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket, getR2DownloadUrl } from '../../lib/r2.js';

function sendAuthError(err: unknown, reply: FastifyReply): never | FastifyReply {
  if (err instanceof AuthError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

function toIso(d: unknown): string | null {
  return d ? new Date(d as string).toISOString() : null;
}

/**
 * Admin-only signup review routes: approve, reject, list, and CV download.
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
    '/v1/auth/signup-requests/:id/approve',
    {
      ...adminOnly,
      schema: { params: z.object({ id: z.string().uuid() }), body: SignupApproveSchema },
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

  // ── Reject ──────────────────────────────────────────────────────────
  r.post(
    '/v1/auth/signup-requests/:id/reject',
    {
      ...adminOnly,
      schema: { params: z.object({ id: z.string().uuid() }), body: SignupRejectSchema },
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

  // ── Admin list ──────────────────────────────────────────────────────
  // Admins CAN see rejectionNote here (their own internal note). The privacy
  // rule only bars the applicant's public poll endpoint from seeing it.
  r.get(
    '/v1/settings/signup-requests',
    {
      ...adminOnly,
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
        }),
      },
    },
    async (request) => {
      const { status } = request.query;
      let q = app.db
        .selectFrom('signup_requests as sr')
        .leftJoin('staff as rv', 'rv.id', 'sr.reviewed_by')
        .select([
          'sr.id',
          'sr.name',
          'sr.email',
          'sr.date_of_birth',
          'sr.mobile_number',
          'sr.role_requested',
          'sr.message',
          'sr.cv_file_key',
          'sr.status',
          'sr.created_at',
          'sr.reviewed_at',
          'sr.rejection_note',
          'sr.public_rejection_message',
          'rv.id as reviewer_id',
          'rv.name as reviewer_name',
        ]);
      if (status !== 'all') q = q.where('sr.status', '=', status);
      const rows = await q.orderBy('sr.created_at', 'desc').execute();

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        dateOfBirth: toIso(row.date_of_birth)?.slice(0, 10) ?? null,
        mobileNumber: row.mobile_number,
        roleRequested: row.role_requested,
        message: row.message,
        cvFileKey: row.cv_file_key,
        status: row.status,
        createdAt: toIso(row.created_at),
        reviewedAt: toIso(row.reviewed_at),
        reviewedBy: row.reviewer_id ? { id: row.reviewer_id, name: row.reviewer_name } : null,
        rejectionNote: row.rejection_note,
        publicRejectionMessage: row.public_rejection_message,
      }));
    },
  );

  // ── CV download (presigned, 1-hour TTL) ─────────────────────────────
  r.get(
    '/v1/auth/signup-requests/:id/cv',
    { ...adminOnly, schema: { params: z.object({ id: z.string().uuid() }) } },
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
