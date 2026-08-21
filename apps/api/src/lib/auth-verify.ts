/**
 * Single source of truth for "is this Supabase JWT valid, and who is it?".
 *
 * Both the HTTP auth plugin (middleware/auth.plugin.ts) and the Socket.io
 * handshake (sockets/index.ts) call verifySupabaseToken — the token is verified
 * and the staff row resolved in exactly one place, never reimplemented.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

import { db } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { redis } from './redis.js';

import type { Role } from '@skaly/shared/schemas/auth';

/**
 * Authenticated staff identity. Exactly the column set we select/cache — NOT the
 * full Staff DB row — so accessing a column we never load is a compile error.
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

/**
 * Reasons verification fails, mapped by callers onto their transport's errors.
 *
 * AUTH_UNAVAILABLE is NOT an authorisation outcome. It means we never got to
 * judge the token because the auth server was unreachable — callers must answer
 * 503, never 401. See isAuthUnreachable() for why the distinction is load-bearing.
 */
export type TokenVerificationCode = 'INVALID_TOKEN' | 'NO_STAFF_ROW' | 'AUTH_UNAVAILABLE';

export class TokenVerificationError extends Error {
  constructor(
    public readonly code: TokenVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
    Object.setPrototypeOf(this, TokenVerificationError.prototype);
  }
}

// Redis key for a cached staff lookup, keyed by Supabase user UUID.
export const cacheKey = (supabaseUid: string) => `staff_lookup:${supabaseUid}`;

// 5-minute TTL per BACKEND-SCHEMA §Redis schema.
const STAFF_CACHE_TTL_SECONDS = 300;

// One JWKS instance per process. jose caches keys and auto-refreshes on unknown
// `kid` / cooldown, so a single shared set is correct and cheapest.
const jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));

/**
 * Fetch the staff row for a Supabase user. Returns undefined when the Supabase
 * account exists but has no matching (non-deleted) staff record.
 */
async function fetchStaffByUid(supabaseUid: string): Promise<AuthUser | undefined> {
  const row = await db
    .selectFrom('staff')
    .select(['id', 'supabase_uid', 'name', 'email', 'role', 'active', 'mfa_enrolled', 'avatar_url'])
    .where('supabase_uid', '=', supabaseUid)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (!row) return undefined;

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
 * Did verification fail because the token is BAD, or because we never got to
 * CHECK it?
 *
 * Collapsing the two cost us a real incident. jose fetches the JWKS over the
 * network, so when the Supabase host was unreachable every request failed here
 * and was reported as INVALID_TOKEN — a 401. The web middleware treats a 401 as
 * an authorisation decision: it calls signOut() and redirects to
 * /login?error=deactivated. So a third-party blip DESTROYED valid sessions and
 * told people their account was deactivated. Users who had just cleared the TOTP
 * challenge were bounced straight back to the login page.
 *
 * "I could not reach the authority" is not "the authority said no". Fail closed
 * on the request (503, no data served) without ever revoking the session.
 *
 * The discriminator: jose raises JOSEError subclasses only once it actually has
 * the key material and evaluates the token. An unreachable JWKS surfaces as a
 * plain TypeError('fetch failed'), and a slow one as JWKSTimeout — neither is a
 * verdict on the token.
 */
function isAuthUnreachable(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSTimeout) return true;
  // A real verification verdict — bad signature, expired, no matching key.
  if (err instanceof joseErrors.JOSEError) return false;
  // Anything else in this block came from the network, not from the token.
  return true;
}

/**
 * Verify a Supabase JWT (RS256 via JWKS) and resolve its staff row (Redis-first,
 * DB on miss). Throws TokenVerificationError on a bad signature or a missing
 * staff row. Does NOT enforce `active` — each caller decides how to reject a
 * deactivated account (the HTTP plugin returns ACCOUNT_DEACTIVATED, the socket
 * handshake refuses the connection).
 */
export async function verifySupabaseToken(token: string): Promise<AuthUser> {
  let supabaseUid: string;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
    if (!payload.sub) {
      throw new TokenVerificationError('INVALID_TOKEN', 'Invalid or expired token');
    }
    supabaseUid = payload.sub;
  } catch (err) {
    if (err instanceof TokenVerificationError) throw err;
    if (isAuthUnreachable(err)) {
      throw new TokenVerificationError(
        'AUTH_UNAVAILABLE',
        'Could not reach the auth server to verify this token',
      );
    }
    throw new TokenVerificationError('INVALID_TOKEN', 'Invalid or expired token');
  }

  // Resolve the staff row — Redis first, DB on miss.
  let staff: AuthUser | undefined;
  try {
    const cached = await redis.get(cacheKey(supabaseUid));
    if (cached) staff = JSON.parse(cached) as AuthUser;
  } catch (err) {
    logger.warn({ err, supabaseUid }, 'verifySupabaseToken: redis get failed, falling back to DB');
  }

  if (!staff) {
    staff = await fetchStaffByUid(supabaseUid);
    if (!staff) {
      throw new TokenVerificationError('NO_STAFF_ROW', 'No staff record for this account');
    }
    try {
      await redis.set(cacheKey(supabaseUid), JSON.stringify(staff), 'EX', STAFF_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, supabaseUid }, 'verifySupabaseToken: redis set failed');
    }
  }

  return staff;
}