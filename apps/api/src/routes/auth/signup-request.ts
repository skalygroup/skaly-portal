import { SignupRequestSchema } from '@skaly/shared/schemas/auth';
import { ZodError } from 'zod';

import { logger } from '../../lib/logger.js';
import { getR2Client, getR2Bucket } from '../../lib/r2.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { AuthService, AuthError } from '../../services/AuthService.js';

import type { FastifyInstance } from 'fastify';

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

  // The body is consumed as a stream via request.parts() (the CV flows straight
  // to R2), so we deliberately do NOT attach a Zod `body` schema — that would
  // make the validator try to parse an already-streamed multipart body. We
  // document the contract for Swagger instead: consumes + field list + the
  // happy-path 201 shape.
  app.post(
    '/auth/signup/request',
    {
      // API-Contract §2: IP, 3 requests / 24 hours. Found missing by Sprint 13's
      // STEP 8 sweep — it had been inheriting the global 150/min, which is 72,000
      // uploads a day into an admin queue from one address. This is the only fully
      // public, unauthenticated WRITE in the product, and it accepts a file.
      config: { rateLimit: { max: 3, timeWindow: '24 hours' } },
      schema: {
        description:
          'Public self-signup (multipart/form-data). Text fields: name, email, ' +
          'dateOfBirth (YYYY-MM-DD), mobileNumber, roleRequested, message (optional), ' +
          'googleUid (optional); plus an optional CV file part (≤5MB). Text fields ' +
          'must precede the file part. Returns 201 { requestId, status: "pending" }.',
        consumes: ['multipart/form-data'],
      },
    },
    async (request, reply) => {
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
