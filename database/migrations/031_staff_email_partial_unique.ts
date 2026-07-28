import { Kysely, sql } from 'kysely';

/**
 * Let an offboarded employee be re-hired (audit A4, ADR-026).
 *
 * `staff_email_unique UNIQUE (email)` covered soft-deleted rows too, so
 * offboarding permanently burned the address. `AuthService.approveSignupRequest`
 * pre-checks for a staff row by email with no `deleted_at` filter, found the dead
 * row, and marked the request `rejected` with "Account already exists at approval
 * time" — a sentence that is not true. The account did not exist; it was deleted.
 * Every subsequent application from that person hit the same dead row.
 *
 * A partial unique index is the same fix migration 030 applied to `holidays`, for
 * the same reason: removing something has to actually free the slot it occupied.
 * The guarantee that matters is unchanged — at most one ACTIVE staff row per
 * email. Deleted rows stay in the table for history and audit, and no longer
 * collide.
 *
 * NON-ADDITIVE BUT NON-BREAKING (NFR §3.1). This RELAXES a constraint: the new
 * predicate matches a strict subset of the rows the old one matched, so every row
 * that satisfied the old index satisfies the new one, and no write that succeeded
 * before can fail now. No data can violate it, and no maintenance window is
 * required. §3.1's "additive changes only" is about BREAKING changes; this is the
 * opposite of one. Recorded here so nobody blocks on §3.1 later — or, worse,
 * "hardens" the weaker constraint back and re-breaks re-hiring.
 *
 * The index alone is only half of A4. It lets a NEW row be created; it does not
 * remove the false rejection, and it loses the person's history. The approval path
 * fix (ADR-026 §4 — detect and offer reinstatement) is the other half.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE staff DROP CONSTRAINT staff_email_unique`.execute(db);
  await sql`
    CREATE UNIQUE INDEX staff_email_unique
      ON staff(email)
      WHERE deleted_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Only reversible while no email carries both a live and a soft-deleted row —
  // exactly the state the old constraint forbade and this migration permits. If
  // anyone has been re-hired by then, this fails, and that is the correct
  // outcome: the old constraint cannot describe the data any more.
  await sql`DROP INDEX IF EXISTS staff_email_unique`.execute(db);
  await sql`ALTER TABLE staff ADD CONSTRAINT staff_email_unique UNIQUE (email)`.execute(db);
}
