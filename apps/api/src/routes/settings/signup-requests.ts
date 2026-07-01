import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toIso(d: unknown): string | null {
  return d ? new Date(d as string).toISOString() : null;
}

// Response shape for one admin-facing signup request. Nullability mirrors the
// signup_requests table (db.types.ts): message/cv/rejection fields and the
// reviewer are optional; name/email/status/role/createdAt are always present.
const SignupRequestAdminItem = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  dateOfBirth: z.string().nullable(),
  mobileNumber: z.string(),
  roleRequested: z.string(),
  message: z.string().nullable(),
  cvFileKey: z.string().nullable(),
  status: z.string(),
  createdAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  rejectionNote: z.string().nullable(),
  publicRejectionMessage: z.string().nullable(),
});

/**
 * GET /v1/settings/signup-requests — admin list of signup requests.
 *
 * Admins CAN see rejectionNote here (their own internal note). The privacy rule
 * only bars the applicant's public poll endpoint (auth/signup-status) from it.
 * Path is area-relative ('/settings/...'); the /v1 prefix is applied by the
 * settings barrel in app.ts.
 */
export async function settingsSignupRequestsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/settings/signup-requests',
    {
      preHandler: [app.verifyJwt, app.requireRole('admin')],
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
        }),
        response: { 200: z.array(SignupRequestAdminItem) },
        security: [{ bearerAuth: [] }],
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
}
