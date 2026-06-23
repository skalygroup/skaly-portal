import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { DB } from '@skaly/shared';

declare module 'fastify' {
  interface FastifyRequest {
    // Populated by verifyJwt (auth.plugin.ts) on protected routes. Non-optional
    // by contract: the middleware guarantees it before any protected handler
    // runs (audit C-04). Reading it on an unauthenticated route is a bug.
    user: import('../middleware/auth.plugin.js').AuthUser;
  }
  interface FastifyInstance {
    verifyJwt: import('fastify').preHandlerHookHandler; // auth.plugin.ts
    requireRole: (
      ...roles: import('@skaly/shared/schemas/auth').Role[]
    ) => import('fastify').preHandlerHookHandler; // auth.plugin.ts
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
