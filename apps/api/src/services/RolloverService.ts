/**
 * RolloverService — the two-tier month rollover (ADR-035/036/037).
 *
 * The highest-stakes procedure in the product: it runs unattended at 00:01 IST
 * with nobody watching, and a wrong outcome is discovered by the business owner
 * the next morning. Every decision here favours a LOUD, RECOVERABLE,
 * NON-DESTRUCTIVE failure over an elegant success.
 *
 * ┌─ TIER 1 ─ one transaction, all-or-nothing ────────────────────────────────┐
 * │  months row (create-if-absent — the idempotency key, ADR-037 §1)          │
 * │  period rows for every active client   (generatePeriodRows, Sprint 5)     │
 * │  coming_shoot_date recompute per client (ADR-034 via …In, ADR-035)        │
 * │  audit entry, System Actor                                               │
 * │  rollover_completed_at                                                    │
 * │  month_ready + rollover_success notification rows                         │
 * └───────────────────── COMMIT — THIS IS THE BOUNDARY ───────────────────────┘
 *   TIER 2 — post-commit, separate, independently failable:
 *     REFRESH MATERIALIZED VIEW CONCURRENTLY × 2  →  view_refreshed_at
 *     failure ⇒ rollover_view_refresh_failed, and the endpoint STILL RETURNS OK.
 *
 * WHY THE NOTIFICATIONS ARE INSIDE TIER 1. `rollover_success`/`month_ready` must
 * fire "on Tier 1 commit" (ADR-035). Writing their rows inside the transaction
 * gets that exactly: the rows commit with the month, and `emitAfterCommit` queues
 * the socket delivery until the same commit. It also removes a window ADR-037 §2
 * had to reason about — there is no "committed but not yet notified" state for a
 * retry to resume into, because the two are the same commit.
 *
 * WHY THE TARGET PERIOD IS `currentIstPeriod()`, NOT "next month". The cron is
 * DAILY (`31 18 * * *` = 00:01 IST, Infra §4), not monthly. At 00:01 on the 1st,
 * IST "now" is already the new month, and that month is the one missing its rows.
 * On the other ~29 nights the guard finds the work done and returns
 * `already_completed` in one query. The routine case is the no-op; that is what
 * the idempotency is FOR, not an edge case it tolerates.
 */
import { SYSTEM_ACTOR_UUID } from '@skaly/shared';
import { sql, type Kysely, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import { currentIstPeriod, monthLabel } from './BaseService.js';
import { ContentDropperService } from './ContentDropperService.js';
import { NotificationService } from './NotificationService.js';
import { generatePeriodRows } from './period-generation.js';
import { transactionWithEmits } from '../lib/emit-after-commit.js';
import { summariseRolloverFailure } from '../lib/rollover-summary.js';

import type { JobLogger } from '../jobs/job-logger.js';
import type { DB } from '@skaly/shared';

/** The dashboard views Tier 2 refreshes. Both carry the unique index CONCURRENTLY needs. */
const DASHBOARD_VIEWS = ['dashboard_org_stats', 'dashboard_staff_task_stats'] as const;

/**
 * The Tier 1 steps, in order. The name of the one that threw is what the failure
 * notification tells an admin — so these are user-facing strings, not internals.
 */
export type RolloverStep = 'period_rows' | 'recompute' | 'audit' | 'notify' | 'view_refresh';

/**
 * The two failure notification types (ADR-036 §1). NAMED rather than written
 * inline as a union, deliberately: as an inline annotation on `notifyFailure`'s
 * parameter, `type: 'rollover_failed' | '…'` matches NotificationCensus's
 * `type:\s*'X'` producer grep — so the census would have reported a producer for
 * `rollover_failed` on the strength of a TYPE ANNOTATION while the real emitter
 * went unfound. That is precisely the false positive the census exists to catch,
 * and it caught it here. The literals now appear only at the real call sites.
 */
export type RolloverFailureType = 'rollover_failed' | 'rollover_view_refresh_failed';

/** What the failure path needs to write and enrich a notification (ADR-036). */
export interface RolloverFailureNotice {
  type: RolloverFailureType;
  period: string;
  failedStep: RolloverStep;
  error: unknown;
}

export type RolloverStatus =
  /** Tier 1 ran now. */
  | 'completed'
  /** Tier 1 had already committed; only Tier 2 was resumed. */
  | 'resumed'
  /** Both tiers were already done. No work. */
  | 'already_completed';

export interface RolloverResult {
  period: string;
  status: RolloverStatus;
  /** Active clients the recompute covered. 0 on a resume/no-op — nothing was recomputed. */
  clients: number;
  /** Tier 2's outcome. False after a refresh failure — the month is still intact. */
  viewsRefreshed: boolean;
}

/** Thrown out of Tier 1 carrying the step, so the notification path needs no DB read (ADR-036 §5). */
export class RolloverFailure extends Error {
  constructor(
    readonly step: RolloverStep,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RolloverFailure';
  }
}

export class RolloverService {
  private readonly audit = new AuditService();
  private readonly notifications = new NotificationService();
  private readonly dropper = new ContentDropperService();

  /**
   * Run (or resume, or skip) the rollover for `period`.
   *
   * Throws `RolloverFailure` only when TIER 1 fails — the caller returns non-2xx
   * and the cron retries (Infra §4). A Tier 2 failure resolves normally with
   * `viewsRefreshed: false`: the dashboard is stale, the month is intact, and
   * retrying the whole rollover to fix a view refresh would be the tail wagging
   * the dog.
   */
  async run(
    db: Kysely<DB>,
    period: string = currentIstPeriod(),
    logger?: JobLogger,
  ): Promise<RolloverResult> {
    // ── THE THREE-WAY BRANCH (ADR-037 §3) — one decision, read top to bottom ──
    //
    // Note what the key is: `rollover_completed_at`, NOT the row's presence. A
    // months row can exist without any rollover having made it — the seed creates
    // the current month, and an admin can lock a future one. Presence alone as the
    // signal would skip the very first rollover after a seed.
    const existing = await db
      .selectFrom('months')
      .select(['rollover_completed_at', 'view_refreshed_at'])
      .where('period', '=', period)
      .executeTakeFirst();

    if (existing?.rollover_completed_at && existing.view_refreshed_at) {
      logger?.info({ period }, 'rollover: already completed, no work');
      return { period, status: 'already_completed', clients: 0, viewsRefreshed: true };
    }

    if (existing?.rollover_completed_at) {
      // Tier 1 committed on an earlier attempt; only the refresh is outstanding.
      // RESUME, never re-run — re-running Tier 1 is what double-fires month_ready.
      logger?.warn({ period }, 'rollover: Tier 1 already committed, resuming Tier 2 only');
      return {
        period,
        status: 'resumed',
        clients: 0,
        viewsRefreshed: await this.tier2(db, period, logger),
      };
    }

    // Absent, or present-but-never-rolled-over → the full run.
    //
    // ⭐ TIER 1 FAILURE. The transaction has already rolled back — no months row,
    // no period rows, nothing partial. Notify admins, then RETHROW so the caller
    // returns non-2xx and the cron's 3× retry engages (Infra §4). The notification
    // is awaited before the rethrow: a 500 whose incident report is still in flight
    // when the process is recycled is a rollover that failed silently, which is the
    // one outcome ADR-036 exists to prevent.
    let clients: number;
    try {
      clients = await this.tier1(db, period, logger);
    } catch (err) {
      const failedStep = err instanceof RolloverFailure ? err.step : 'period_rows';
      logger?.error({ err, period, failedStep }, 'rollover Tier 1 failed — rolled back fully');
      await this.notifyFailure(db, { type: 'rollover_failed', period, failedStep, error: err }, logger);
      throw err;
    }

    return {
      period,
      status: 'completed',
      clients,
      viewsRefreshed: await this.tier2(db, period, logger),
    };
  }

  /**
   * TIER 1 — one transaction. Either the whole month exists or none of it does.
   *
   * Every `await` in here is inside `trx`; there is no `db` in scope by the time
   * the body runs, which is the mechanical reason a stray non-transactional write
   * cannot creep in. Returns the client count for the result.
   */
  private async tier1(db: Kysely<DB>, period: string, logger?: JobLogger): Promise<number> {
    return transactionWithEmits(db, async (trx) => {
      // a. The idempotency key, INSIDE the transaction (ADR-037 §1) — so "the
      //    month row exists" and "the period rows exist" commit together, which is
      //    the only reason skip-if-present is trustworthy.
      await trx
        .insertInto('months')
        .values({ period, label: monthLabel(period), locked: false })
        .onConflict((oc) => oc.column('period').doNothing())
        .execute();

      // b. Every active client's rows. The generator is Sprint 5's, shared with the
      //    dev seed, and idempotent per-insert — so a resume that somehow reached
      //    here twice fills gaps rather than duplicating (ADR-035).
      await step('period_rows', () => generatePeriodRows(period, trx));

      // c. The recompute (ADR-034), enrolled in THIS transaction (ADR-035's
      //    amendment). No swallow-and-log here, deliberately: the standalone sweep
      //    isolates per client because it can, but Tier 1 is all-or-nothing, and a
      //    swallowed failure would commit a month quietly missing a recompute.
      const clients = await trx
        .selectFrom('content_pipelines')
        .innerJoin('clients', 'clients.id', 'content_pipelines.client_id')
        .select('content_pipelines.client_id as client_id')
        .distinct()
        .where('content_pipelines.period', '=', period)
        .where('clients.active', '=', true)
        .execute();

      await step('recompute', async () => {
        for (const { client_id } of clients) {
          await this.dropper.recomputeComingShootDateIn(client_id, period, trx);
        }
      });

      // d. Audit, System Actor (actorId: null ⇒ SYSTEM_ACTOR_UUID + 'system', C-04).
      await step('audit', () =>
        this.audit.log({
          actorId: null,
          action: 'INSERT',
          entity: 'months',
          // entityId is NULL, not the period: audit_log.record_id is a UUID column
          // and `months` is keyed by CHAR(7) — the same reason MonthService.setLock
          // passes null. The period goes in the JSONB, where a reader looks anyway.
          // Passing the period here throws 'invalid input syntax for type uuid' at
          // step `audit`, i.e. every night, after the rows were already generated.
          entityId: null,
          after: { period, clients: clients.length, tier: 1 },
          trx,
        }),
      );

      // e. The completion mark — the signal every later guard reads.
      await trx
        .updateTable('months')
        .set({ rollover_completed_at: sql`now()`, rollover_failed_step: null })
        .where('period', '=', period)
        .execute();

      // f. The two success notifications, written HERE so they commit with the
      //    month and deliver on the same commit (see the header).
      await step('notify', () => this.notifySuccess(period, clients.length, trx));

      logger?.info({ period, clients: clients.length }, 'rollover Tier 1 committing');
      return clients.length;
      // ── COMMIT ── everything above is now durable, together. THE BOUNDARY. ──
    });
  }

  /**
   * TIER 2 — post-commit, outside Tier 1's transaction, independently failable.
   *
   * CONCURRENTLY is not a nicety: the plain form takes ACCESS EXCLUSIVE and blocks
   * every dashboard read for the refresh's duration, contradicting NFR §3.1's "API
   * fully operational during 00:01–00:05".
   *
   * Never throws. A refresh failure degrades the dashboard to stale data and is
   * fixed by re-running the refresh; a refresh failure that undid the month would
   * be fixed by nothing.
   */
  private async tier2(db: Kysely<DB>, period: string, logger?: JobLogger): Promise<boolean> {
    try {
      for (const view of DASHBOARD_VIEWS) {
        await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${sql.ref(view)}`.execute(db);
      }
      await db
        .updateTable('months')
        .set({ view_refreshed_at: sql`now()`, rollover_failed_step: null })
        .where('period', '=', period)
        .execute();
      logger?.info({ period }, 'rollover Tier 2 refreshed');
      return true;
    } catch (err) {
      logger?.error({ err, period }, 'rollover Tier 2 view refresh failed — month is intact');
      // A post-commit failure, so the row survives to record it (ADR-037 §2).
      await db
        .updateTable('months')
        .set({ rollover_failed_step: 'view_refresh' })
        .where('period', '=', period)
        .execute();
      await this.notifyFailure(
        db,
        { type: 'rollover_view_refresh_failed', period, failedStep: 'view_refresh', error: err },
        logger,
      );
      return false;
    }
  }

  /** `month_ready` to everyone, `rollover_success` to admins — both on Tier 1's commit. */
  private async notifySuccess(period: string, clients: number, trx: Transaction<DB>): Promise<void> {
    const data = { period, clients, recordId: period };
    await this.notifications.createForStaff({
      actorId: SYSTEM_ACTOR_UUID, // excluded from its own fan-out; it is a staff row
      type: 'month_ready',
      title: `${monthLabel(period)} is ready`,
      body: `The new month has been set up. Attendance, tasks, shoots and the content calendar are ready for ${monthLabel(period)}.`,
      data,
      recordId: period,
      trx,
    });
    await this.notifications.createForStaff({
      actorId: SYSTEM_ACTOR_UUID,
      roles: ['admin'],
      type: 'rollover_success',
      title: 'Rollover completed',
      body: `Rollover for ${monthLabel(period)} completed successfully across ${clients} client${clients === 1 ? '' : 's'}.`,
      data,
      recordId: period,
      trx,
    });
  }

  /**
   * ⭐ THE FAILURE PATH (ADR-036 §2). Both failure types converge here.
   *
   * ROW FIRST, SUMMARY SECOND — and never the reverse. The templated body is a
   * complete, correct notification on its own; the AI summary only ever REPLACES
   * it with a better one. A cron whose failure notification also fails to generate
   * is the worst case in the product: broken AND silent, discovered from missing
   * data rather than from a bell.
   *
   * Runs in its OWN transaction, necessarily — a Tier 1 failure has already rolled
   * its transaction back, so there is nothing to enroll in.
   */
  async notifyFailure(
    db: Kysely<DB>,
    notice: RolloverFailureNotice,
    logger?: JobLogger,
  ): Promise<void> {
    const { type, period, failedStep, error } = notice;
    const templated =
      `Rollover for ${monthLabel(period)} failed at step ${failedStep}. ` +
      'The previous month is intact — data was not affected. ' +
      'A detailed summary is being generated.';

    // 1. The row. Unconditional, first, in its own transaction so it is durable
    //    before anything that can fail is attempted.
    await transactionWithEmits(db, (trx) =>
      this.notifications.createForStaff({
        actorId: SYSTEM_ACTOR_UUID,
        roles: ['admin'],
        type,
        title: type === 'rollover_failed' ? 'Rollover failed' : 'Dashboard refresh failed',
        body: templated,
        // `action` is what renders the inline [Manual rollover] button (ADR-036 §4).
        // It names the shared idempotent endpoint — there is no force path.
        data: { period, failedStep, recordId: period, action: 'manual_rollover' },
        recordId: period,
        trx,
      }),
    );

    // 2. Enrichment. Best-effort by construction: summariseRolloverFailure returns
    //    null on any failure, including exhausted SDK retries, and the templated
    //    body simply stays.
    const summary = await summariseRolloverFailure({ period, failedStep, error }, logger);
    if (!summary) return;

    // Keyed on the payload the rows already carry, so no ids need threading back
    // out of the fan-out.
    //
    // ponytail: DB-only enrichment — a connected admin keeps the templated body
    // until the bell refetches. `applyNotificationEvent` is idempotent by id, so a
    // re-emit is dropped rather than applied, and adding a third notify:* event
    // fights the pinned two-event invariant in lib/socket.ts. At 00:01 nobody is
    // watching; any page load shows the summary. Upgrade path if that changes:
    // make the bell's reducer replace-by-id and re-emit notify:new.
    await db
      .updateTable('notifications')
      .set({ message: summary })
      .where('type', '=', type)
      .where(sql<boolean>`payload->>'period' = ${period}`)
      .where('message', '=', templated)
      .execute();
  }
}

/**
 * Run a Tier 1 step, tagging any throw with WHICH step it was.
 *
 * The tag is the whole point: an admin reading "failed at step recompute" at 08:00
 * knows something different from "failed at step period_rows", and a Tier 1 failure
 * rolls the months row back, so there is nowhere to have written it down.
 */
async function step<T>(name: RolloverStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof RolloverFailure ? err : new RolloverFailure(name, err);
  }
}
