import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SignupStatusResponseSchema } from '@skaly/shared/schemas/auth';

/**
 * GET /v1/auth/signup-requests/me/status — PUBLIC poll endpoint for the
 * /signup/pending page. Returns only the applicant-safe fields; the response
 * is gated by SignupStatusResponseSchema, which makes the internal
 * rejection_note impossible to leak (z.never()).
 *
 * Deliberately import-clean (no Supabase/R2/env) so it can be mounted and
 * tested in isolation.
 *
 * Aggressively rate-limited (10/min/IP) to deter scraping — the frontend polls
 * every 10–60s, so a legitimate poller is never close to the cap.
 */
export async function signupStatusRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/auth/signup-requests/me/status',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        querystring: z.object({ email: z.string().email() }),
        response: {
          200: SignupStatusResponseSchema,
          404: z.object({
            error: z.object({ code: z.string(), message: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      const { email } = request.query;
      const row = await app.db
        .selectFrom('signup_requests')
        .select(['status', 'public_rejection_message', 'created_at'])
        .where('email', '=', email)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No request found for this email.' } });
      }

      // Only applicant-safe fields. rejection_note is never even selected.
      return {
        status: row.status as 'pending' | 'approved' | 'rejected',
        publicRejectionMessage: row.public_rejection_message ?? null,
        submittedAt: new Date(row.created_at as unknown as string).toISOString(),
      };
    },
  );
}
