import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Role } from '@skaly/shared/schemas/auth';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';

/**
 * Authenticated staff identity attached to every protected request.
 *
 * This is exactly the column set verifyJwt selects/caches — NOT the full
 * `Staff` DB row. Typing it as the precise subset keeps handlers honest:
 * accessing a column we never load (e.g. date_of_birth) is a compile error,
 * not a runtime `undefined`. Per audit C-04, `id` is guaranteed non-null on
 * protected routes because the middleware refuses requests without a row.
 */
export interface AuthUser {
  id: string;
  supabase_uid: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mfa_enrolled: boolean;
  avatar_url: string | null;
}

// Redis key for a cached staff lookup, keyed by Supabase user UUID.
const cacheKey = (supabaseUid: string) => `staff_lookup:${supabaseUid}`;

// 5-minute TTL per BACKEND-SCHEMA §Redis schema (line 576).
const STAFF_CACHE_TTL_SECONDS = 300;

function unauthorized(reply: FastifyReply, code: string, message: string) {
  return reply.status(401).send({ error: { code, message } });
}

function forbidden(reply: FastifyReply, code: string, message: string) {
  return reply.status(403).send({ error: { code, message } });
}

/**
 * Fetch the staff row for a Supabase user. Returns undefined when the
 * Supabase account exists but has no matching (non-deleted) staff record.
 */
async function fetchStaffByUid(supabaseUid: string): Promise<AuthUser | undefined> {
  const row = await db
    .selectFrom('staff')
    .select([
      'id',
      'supabase_uid',
      'name',
      'email',
      'role',
      'active',
      'mfa_enrolled',
      'avatar_url',
    ])
    .where('supabase_uid', '=', supabaseUid)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!row) return undefined;

  // supabase_uid is non-null here — we just filtered on it. role is one of the
  // four CHECK-constrained values; narrow the DB `string` to our Role union.
  return {
    id: row.id,
    supabase_uid: supabaseUid,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    active: row.active,
    mfa_enrolled: row.mfa_enrolled,
    avatar_url: row.avatar_url,
  };
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
  // One JWKS instance per process. jose caches keys and auto-refreshes on
  // unknown `kid` / cooldown, so a single shared set is correct and cheapest.
  const jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));

  const verifyJwt: preHandlerHookHandler = async (request, reply) => {
    // a. Bearer token from the Authorization header.
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return unauthorized(reply, 'NO_TOKEN', 'Missing or malformed Authorization header');
    }
    const token = header.slice('Bearer '.length).trim();

    // b. Verify RS256 signature + issuer/audience. Never log the token body.
    let supabaseUid: string;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        audience: 'authenticated',
      });
      if (!payload.sub) {
        return unauthorized(reply, 'INVALID_TOKEN', 'Invalid or expired token');
      }
      supabaseUid = payload.sub; // c. `sub` is the Supabase user UUID.
    } catch {
      return unauthorized(reply, 'INVALID_TOKEN', 'Invalid or expired token');
    }

    // d. Resolve the staff row — Redis first, DB on miss.
    let staff: AuthUser | undefined;

    try {
      const cached = await redis.get(cacheKey(supabaseUid));
      if (cached) staff = JSON.parse(cached) as AuthUser;
    } catch (err) {
      // Redis is a cache, not a source of truth: log and fall through to DB.
      logger.warn({ err, supabaseUid }, 'verifyJwt: redis get failed, falling back to DB');
    }

    if (!staff) {
      staff = await fetchStaffByUid(supabaseUid);
      if (!staff) {
        // Supabase user exists but no staff record (e.g. backfill failed mid-signup).
        return unauthorized(reply, 'NO_STAFF_ROW', 'No staff record for this account');
      }

      try {
        await redis.set(cacheKey(supabaseUid), JSON.stringify(staff), 'EX', STAFF_CACHE_TTL_SECONDS);
      } catch (err) {
        // A failed write just means the next request also hits the DB.
        logger.warn({ err, supabaseUid }, 'verifyJwt: redis set failed');
      }
    }

    // e. Deactivated accounts are rejected (frontend shows "Account deactivated…").
    if (staff.active === false) {
      return forbidden(reply, 'ACCOUNT_DEACTIVATED', 'Account deactivated.');
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
