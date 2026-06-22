import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from './env.js';
import type { DB } from '@skaly/shared';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});
