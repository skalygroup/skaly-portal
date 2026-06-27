import { settingsSignupRequestsRoutes } from './signup-requests.js';

import type { FastifyInstance } from 'fastify';

/**
 * Barrel for the /v1/settings/* area. Mounted with the /v1 prefix in app.ts.
 */
export default async function settingsRoutes(app: FastifyInstance) {
  await app.register(settingsSignupRequestsRoutes);
}
