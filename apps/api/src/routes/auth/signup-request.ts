import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { SignupRequestSchema } from '@skaly/shared/schemas/auth';
import { AuthService, AuthError } from '../../services/AuthService.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';

/**
 * POST /v1/auth/signup/request — public self-signup (APPFLOW §2.6).
 *
 * multipart/form-data: text fields + an optional CV file. We iterate parts so
 * the CV streams straight to R2 (via the service) and is never buffered. Text
 * fields are expected before the file part, which the signup form guarantees.
 */
export async function signupRequestRoutes(app: FastifyInstance) {
  const authService = new AuthService(
    app.db,
    app.redis,
    supabaseAdmin,
    logger,
    getR2Client(),
    getR2Bucket(),
  );

  app.post('/auth/signup/request', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(415).send({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected multipart/form-data.' },
      });
    }

    const fields: Record<string, string> = {};
    let result: { requestId: string; status: 'pending' } | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          // Validate the fields gathered so far, then hand the live stream to
          // the service, which consumes it inline. `finally` drains the stream
          // if the service rejected before reading it (bad MIME / validation).
          try {
            const parsed = SignupRequestSchema.parse(fields);
            result = await authService.signupRequest(parsed, {
              stream: part.file,
              mimetype: part.mimetype,
            });
          } finally {
            part.file.resume();
          }
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }

      // No file was sent — validate and submit text-only.
      if (!result) {
        const parsed = SignupRequestSchema.parse(fields);
        result = await authService.signupRequest(parsed);
      }

      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Invalid form data.', issues: err.issues },
        });
      }
      if (err instanceof AuthError) {
        return reply
          .status(err.statusCode)
          .send({ error: { code: err.code, message: err.message } });
      }
      // Multipart limit errors (file > 5MB, >1 file) carry statusCode 413 —
      // let Fastify's default handler surface them.
      throw err;
    }
  });
}
