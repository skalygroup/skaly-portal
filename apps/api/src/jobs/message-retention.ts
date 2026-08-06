/**
 * ADR-030 (+ its Sprint 12 amendment) — the NFR §5.2 12-month message purge.
 *
 * Sprint 10 already wrote and tested the PREDICATE
 * (`NotificationService.deleteExpiredMessages`): one rule for both channels —
 * delete a message past the cutoff unless it still has a reply inside the
 * window. This job does not reimplement it and does not widen it. What Sprint 12
 * adds is the bound.
 *
 * ── WHY NOT SESSION-SCOPED ───────────────────────────────────────────────────
 * ADR-030 §4 says to scope the bot channel by `bot_sessions.last_activity_at`.
 * ADR-021's own correction supersedes that: `messages` carries no session
 * reference, so the only available join is on `staff_id`, and that means one
 * expired session deletes that person's entire bot history — live conversations
 * included. A test caught it. `parent_id` already provides the turn-pair
 * guarantee the session scoping was reaching for.
 *
 * ── WHY BATCHED, AND WHY THE CLOSURE ─────────────────────────────────────────
 * `messages_parent_id_fkey` is NO ACTION, which Postgres checks at STATEMENT
 * END — so one DELETE removing a parent and its children together succeeds,
 * while two statements or parent-first ordering raise the constraint. That
 * property is load-bearing and is preserved here.
 *
 * But one statement for the WHOLE purge would hold locks on `messages` for the
 * length of a 15k-row delete, during live chat. So each batch is bounded by a
 * LIMIT — and then closed over children (`OR parent_id IN batch`), so a parent
 * that made the cut takes all its replies with it even if they fell outside the
 * LIMIT. Those replies are necessarily past the cutoff already: a parent with a
 * reply inside the window is excluded by the NOT EXISTS.
 *
 * Bounded and whole, in one statement. Between batches, other traffic proceeds.
 */
import { sql } from 'kysely';

import { AuditService } from '../services/AuditService.js';
import { RETENTION_MONTHS } from '../services/NotificationService.js';

import type { JobLogger } from './job-logger.js';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';

/** Messages per batch. Small enough that no single statement holds locks long. */
export const RETENTION_BATCH_SIZE = 500;

/**
 * Stops a bug from looping forever. At the default batch size this permits ~500k
 * messages in one run — far past NFR §2.2's ~15k at twelve months, so hitting it
 * means something is wrong, not that the data grew.
 */
const MAX_BATCHES = 1000;

export interface RetentionSummary {
  messagesDeleted: number;
  sessionsDeleted: number;
  batches: number;
  hitBatchCap: boolean;
}

export async function messageRetentionSweep(
  db: Kysely<DB>,
  opts: { batchSize?: number; logger?: JobLogger } = {},
): Promise<RetentionSummary> {
  const batchSize = opts.batchSize ?? RETENTION_BATCH_SIZE;
  const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_MONTHS))} months'`;

  const summary: RetentionSummary = {
    messagesDeleted: 0,
    sessionsDeleted: 0,
    batches: 0,
    hitBatchCap: false,
  };

  for (;;) {
    if (summary.batches >= MAX_BATCHES) {
      summary.hitBatchCap = true;
      opts.logger?.error({ ...summary }, 'message retention hit its batch cap — stopping');
      break;
    }

    const result = await sql<{ id: string }>`
      WITH batch AS (
        SELECT m.id
        FROM messages m
        WHERE m.created_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM messages r
            WHERE r.parent_id = m.id AND r.created_at >= ${cutoff}
          )
        ORDER BY m.created_at
        LIMIT ${sql.lit(batchSize)}
      )
      DELETE FROM messages d
      WHERE d.id IN (SELECT id FROM batch)
         OR d.parent_id IN (SELECT id FROM batch)
      RETURNING d.id
    `.execute(db);

    if (result.rows.length === 0) break;
    summary.messagesDeleted += result.rows.length;
    summary.batches += 1;
  }

  // The session envelopes. No FK ties them to `messages` — ADR-021 §4 gave
  // parent_id the message graph and bot_sessions the session lifecycle, on
  // purpose — so this is an independent delete on the same horizon, not a
  // cascade and not a join.
  const sessions = await db
    .deleteFrom('bot_sessions')
    .where('last_activity_at', '<', sql<Date>`now() - interval '${sql.raw(String(RETENTION_MONTHS))} months'`)
    .returning('id')
    .execute();
  summary.sessionsDeleted = sessions.length;

  // ONE summary row, not one per message: a run can clear ~15k messages
  // (NFR §2.2), and 15k audit rows describing one scheduled cleanup is how the
  // audit log stops being readable.
  if (summary.messagesDeleted > 0 || summary.sessionsDeleted > 0) {
    await new AuditService().log({
      actorId: null, // System Actor (C-04)
      action: 'DELETE',
      entity: 'messages',
      entityId: null,
      after: {
        messages_deleted: summary.messagesDeleted,
        sessions_deleted: summary.sessionsDeleted,
        batches: summary.batches,
        retention_months: RETENTION_MONTHS,
      },
      trx: db,
    });
  }

  opts.logger?.info({ ...summary }, 'message retention sweep complete');
  return summary;
}
