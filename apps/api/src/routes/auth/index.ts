import { inviteRoutes } from './invite.js';
import { sessionMfaRoutes } from './session-mfa.js';
import { signupRequestRoutes } from './signup-request.js';
import { signupReviewRoutes } from './signup-review.js';
import { signupStatusRoutes } from './signup-status.js';

import type { FastifyInstance } from 'fastify';

/**
 * Barrel for the /v1/auth/* area. Registers every sibling auth route file; the
 * /v1 prefix is applied where this barrel is mounted (app.ts), so the files
 * themselves use area-relative paths (e.g. '/auth/invite').
 */
export default async function authRoutes(app: FastifyInstance) {
  await app.register(inviteRoutes);
  await app.register(signupRequestRoutes);
  await app.register(signupReviewRoutes);
  await app.register(signupStatusRoutes);
  await app.register(sessionMfaRoutes);
}
