import { Client } from 'pg';

/**
 * One short-lived connection per call, closed in `finally`.
 *
 * This was four identical copies — attendance, mfa, signup-requests, and every
 * new spec that needed a row. Nothing had drifted yet, which is exactly when to
 * collapse it: the copies in this suite have a history of learning a lesson one
 * at a time (see helpers/auth.ts).
 *
 * A `Client` rather than a `Pool` on purpose. Specs run against the same
 * Postgres the API is using, and a pool left open keeps Playwright's process
 * alive past the last test.
 */
export async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The staff id behind an email — the join every spec needs before it can act. */
export async function staffIdByEmail(email: string): Promise<string> {
  const { rows } = await withDb((c) =>
    c.query<{ id: string }>('SELECT id FROM staff WHERE email = $1 AND deleted_at IS NULL', [email]),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`No active staff row for ${email}.`);
  return id;
}
