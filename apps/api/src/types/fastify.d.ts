import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { DB } from '@skaly/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      staffId: string;
      supabaseUid: string;
      role: 'admin' | 'manager' | 'team_member' | 'freelancer';
      email: string;
      mfaEnrolled: boolean;
    };
  }
  interface FastifyInstance {
    verifyJwt: any; // populated by auth.plugin.ts in Sprint 1
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
