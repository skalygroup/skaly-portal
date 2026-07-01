import fp from 'fastify-plugin';

import { cacheKey, TokenVerificationError, verifySupabaseToken } from '../lib/auth-verify.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

import type { AuthUser } from '../lib/auth-verify.js';
import type { Role } from '@skaly/shared/schemas/auth';
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';

// Re-exported so existing importers (types/fastify.d.ts, tests) keep resolving
// AuthUser from the auth plugin. Its canonical home is lib/auth-verify.ts.
export type { AuthUser } from '../lib/auth-verify.js';

function unauthorized(reply: FastifyReply, code: string, message: string) {
  return reply.status(401).send({ error: { code, message } });
}

function forbidden(reply: FastifyReply, code: string, message: string) {
  return reply.status(403).send({ error: { code, message } });
}

/**
 * preHandler factory: gate a route to one of the given roles. Runs AFTER
 * verifyJwt (which populates request.user).
 *
 * M-08: never reveal which role was required — no role leakage, even in the
 * error. The message is always the literal "Permission denied."
 */
export function requireRole(...roles: Role[]): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user;
    if (!user || !roles.includes(user.role)) {
      return forbidden(reply, 'PERMISSION_DENIED', 'Permission denied.');
    }
  };
}

/**
 * Drop the cached staff lookup for a Supabase user. Call after approval,
 * deactivation, or role change (STEP 7) so the next request re-reads the DB
 * instead of serving a stale role/active flag.
 */
export async function invalidateStaffCache(supabaseUid: string): Promise<void> {
  try {
    await redis.del(cacheKey(supabaseUid));
  } catch (err) {
    // Cache is best-effort; a failed delete must not break the caller. The
    // 5-minute TTL bounds how long any staleness can persist.
    logger.warn({ err, supabaseUid }, 'invalidateStaffCache: redis del failed');
  }
}

async function authPlugin(fastify: FastifyInstance) {
  const verifyJwt: preHandlerHookHandler = async (request, reply) => {
    // a. Bearer token from the Authorization header.
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return unauthorized(reply, 'NO_TOKEN', 'Missing or malformed Authorization header');
    }
    const token = header.slice('Bearer '.length).trim();

    // b–d. Verify signature + resolve staff (shared with the socket handshake).
    let staff: AuthUser;
    try {
      staff = await verifySupabaseToken(token);
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        // INVALID_TOKEN (bad signature / no sub) or NO_STAFF_ROW.
        return unauthorized(reply, err.code, err.message);
      }
      return unauthorized(reply, 'INVALID_TOKEN', 'Invalid or expired token');
    }

    // e. Deactivated accounts are rejected with 401 (session invalidated) so
    // client middleware auto-clears the session — see 04-APPFLOW §2.8,
    // 08-AUTH-MATRIX §2, 09-ERROR-HANDLING §2. Frontend routes on the code, not
    // the status. (frontend shows "Account deactivated…")
    if (staff.active === false) {
      return unauthorized(reply, 'ACCOUNT_DEACTIVATED', 'Account deactivated.');
    }

    // f. Attach and proceed.
    request.user = staff;
  };

  fastify.decorate('verifyJwt', verifyJwt);
  fastify.decorate('requireRole', requireRole);
}

// fastify-plugin so `verifyJwt` / `requireRole` escape this plugin's
// encapsulation and are reachable from route preHandlers across the app.
export default fp(authPlugin, { name: 'auth' });
