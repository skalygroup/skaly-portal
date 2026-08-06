/**
 * ADR-034 — the rollover-side `coming_shoot_date` recompute.
 *
 * There is exactly one implementation of the recompute itself, and it is not
 * here: `ContentDropperService.recomputeComingShootDate` (Sprint 6). Trigger 1
 * calls it for one client on shoot confirm/reset; this job calls the same
 * function for every client in a period. They differ in scope and in nothing
 * else — same MIN-of-confirmed-slots, same `source='manual'` guard, same
 * no-version-bump, same System Actor audit.
 *
 * The guard is the whole point. A second copy of this logic that forgets it
 * erases an admin's manual override at 00:01 with nobody watching, and the
 * value it writes instead is perfectly plausible — which is why the failure
 * would survive review. So this file iterates and logs; it does not compute.
 */
import { ContentDropperService } from '../services/ContentDropperService.js';

import type { JobLogger } from './job-logger.js';
import type { Executor } from '../services/BaseService.js';
import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';

export interface RecomputeSummary {
  clients: number;
  recomputed: number;
  failed: number;
}

/**
 * Recompute `coming_shoot_date` for every client holding a pipeline row in
 * `period`.
 *
 * Scoped to the pipeline rows rather than to `clients` because a client with no
 * pipeline row for the period has nothing to project onto — the recompute would
 * return early anyway, and iterating them just buys round-trips.
 *
 * Per-client failures are logged and the sweep continues: the recompute is a
 * projection that the next run re-derives, so one client's bad slot data must
 * not cost the other nineteen their recompute. That is the same swallow-and-log
 * contract `events/listeners.ts` applies to Trigger 1.
 */
export async function recomputeAllComingShootDates(
  db: Kysely<DB>,
  period: string,
  logger?: JobLogger,
): Promise<RecomputeSummary> {
  const dropper = new ContentDropperService();

  const rows = await selectPipelineClients(db, period);
  const summary: RecomputeSummary = { clients: rows.length, recomputed: 0, failed: 0 };

  for (const { client_id } of rows) {
    try {
      // The function opens its own transaction per client (transactionWithEmits),
      // which is what makes the per-client isolation above real rather than
      // aspirational — a failure here has already rolled back only its own client.
      await dropper.recomputeComingShootDate(client_id, period, db);
      summary.recomputed += 1;
    } catch (err) {
      summary.failed += 1;
      logger?.error({ err, clientId: client_id, period }, 'coming_shoot_date recompute failed');
    }
  }

  logger?.info({ ...summary, period }, 'coming_shoot_date recompute sweep complete');
  return summary;
}

function selectPipelineClients(db: Executor, period: string) {
  return db
    .selectFrom('content_pipelines')
    .innerJoin('clients', 'clients.id', 'content_pipelines.client_id')
    .select('content_pipelines.client_id as client_id')
    .distinct()
    .where('content_pipelines.period', '=', period)
    .where('clients.active', '=', true)
    .execute();
}
