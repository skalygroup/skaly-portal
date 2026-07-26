import 'dotenv/config';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// This is the exact regex enforced by the months_period_format CHECK
// constraint in database/migrations/002_months.ts. The constraint itself
// is hard to test in isolation (it requires INSERT-time violations), so we
// probe the same pattern directly with `SELECT <value> ~ <pattern>`.
const PERIOD_REGEX = '^[0-9]{4}-[0-9]{2}$';

// Prefer an explicit test DB, fall back to the dev DATABASE_URL (the scripts
// in apps/api/scripts use the same env var).
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// If no DB is reachable in this environment, skip rather than fail the suite.
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('months_period_format regex (migration 002)', () => {
  let db: Kysely<any>;

  beforeAll(() => {
    db = new Kysely<any>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: databaseUrl, max: 1 }),
      }),
    });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  async function matches(value: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT ${value} ~ ${PERIOD_REGEX} AS ok
    `.execute(db);
    return rows[0]!.ok;
  }

  it('accepts a valid YYYY-MM period', async () => {
    expect(await matches('2026-06')).toBe(true);
  });

  it('rejects a month without a leading zero', async () => {
    expect(await matches('2026-6')).toBe(false);
  });

  it('rejects a two-digit year', async () => {
    expect(await matches('26-06')).toBe(false);
  });

  it('rejects non-numeric input', async () => {
    expect(await matches('abcd-ef')).toBe(false);
  });
});
