import type { AuthUser } from '../middleware/auth.plugin.js';
import type { DB } from '@skaly/shared';
import type { Role } from '@skaly/shared/schemas/auth';
import type { preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyRequest {
    // Populated by verifyJwt (auth.plugin.ts) on protected routes. Non-optional
    // by contract: the middleware guarantees it before any protected handler
    // runs (audit C-04). Reading it on an unauthenticated route is a bug.
    user: AuthUser;
  }
  interface FastifyInstance {
    verifyJwt: preHandlerHookHandler; // auth.plugin.ts
    requireRole: (...roles: Role[]) => preHandlerHookHandler; // auth.plugin.ts
    verifyInternalSecret: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>; // populated by internalAuth.plugin.ts
    // Shared resources decorated in src/app.ts (buildApp).
    db: Kysely<DB>;
    pool: Pool;
    redis: Redis;
  }
}
export {};
