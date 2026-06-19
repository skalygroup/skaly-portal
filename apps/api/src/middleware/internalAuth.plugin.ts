import crypto from 'crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Internal route authentication via X-Internal-Secret header.
 *
 * Used ONLY for /v1/internal/* routes (rollover, etc.) — NOT for user routes.
 * The secret is shared between Railway Cron service and the API; never sent
 * to or stored in the browser.
 *
 * Comparison uses crypto.timingSafeEqual to prevent timing-based recovery
 * of the secret byte-by-byte (B-03).
 */

const INTERNAL_HEADER = 'x-internal-secret';

async function internalAuthPlugin(fastify: FastifyInstance) {
  const expectedSecret = env.CRON_SECRET;

  const verifyInternalSecret = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const provided = request.headers[INTERNAL_HEADER];

    if (typeof provided !== 'string') {
      logger.warn(
        { ip: request.ip, url: request.url, hasHeader: false },
        'Internal auth: missing header',
      );
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid internal secret' },
      });
    }

    // Length pre-check: if lengths differ, timingSafeEqual would throw.
    // Wait 50ms to prevent timing-based length discovery, then reject.
    if (provided.length !== expectedSecret.length) {
      await new Promise((r) => setTimeout(r, 50));
      logger.warn(
        { ip: request.ip, url: request.url, hasHeader: true },
        'Internal auth: length mismatch',
      );
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid internal secret' },
      });
    }

    // Constant-time comparison — prevents byte-by-byte timing attack
    const isValid = crypto.timingSafeEqual(
      Buffer.from(provided, 'utf8'),
      Buffer.from(expectedSecret, 'utf8'),
    );

    if (!isValid) {
      logger.warn(
        { ip: request.ip, url: request.url, hasHeader: true },
        'Internal auth: invalid secret',
      );
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid internal secret' },
      });
    }

    // Valid — continue to route handler
  };

  fastify.decorate('verifyInternalSecret', verifyInternalSecret);
}

// Wrapped with fastify-plugin so the `verifyInternalSecret` decorator is
// exposed on the parent instance (not encapsulated in the plugin's scope),
// making it available to route preHandlers across the app.
export default fp(internalAuthPlugin, { name: 'internal-auth' });
