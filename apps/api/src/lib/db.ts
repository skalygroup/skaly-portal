import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { env } from './env.js';

import type { DB } from '@skaly/shared';

// Identity-parse DATE (OID 1082) so a calendar date stays the exact 'YYYY-MM-DD'
// string Postgres stored. node-postgres otherwise builds a JS Date at LOCAL
// midnight, and toISOString() then shifts it one day backwards east of UTC. This
// replaces the scattered per-column to_char / local-getter workarounds (Sprints
// 5-7) with the root-cause fix, and matters for Sprint 8: the bot hands these
// dates to an LLM that states them as fact. The 10 affected columns are typed as
// `string` in @skaly/shared/db.types.ts (enforced on regen by .kysely-codegenrc.json).
// Leave TIMESTAMPTZ (1184) alone — those are absolute instants and Date is right.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});
