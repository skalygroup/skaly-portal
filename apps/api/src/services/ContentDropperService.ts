/**
 * ContentDropperService — the read/write core behind the Content Dropper grid
 * (04-APPFLOW §7, 07-API-CONTRACT §9, 08-AUTH-MATRIX §3/§4).
 *
 * Table is `content_pipelines` (one row per client per period, seeded by
 * generatePeriodRows). UI "Content Dropper"; route /v1/content-dropper.
 *
 *   - getGrid    — every pipeline row for a period (+ client name, updated_by
 *                  name/avatar). Status is DERIVED at read time from which stage
 *                  timestamps are set — there is NO stored stage/status column
 *                  (04-APPFLOW §7). admin/manager only.
 *   - updateStage — mark raw/finals/posted → raw_received_at/finals_ready_at/
 *                  posted_at. Timestamps are server-set (now() IST, H-02) — any
 *                  client timestamp is ignored. content_pipelines IS versioned,
 *                  so writes go through optimisticUpdate (C-02): version required,
 *                  STALE_DATA on mismatch. Sequence raw→finals→posted enforced
 *                  here (STAGE_SEQUENCE_VIOLATION). Forward-only — re-marking a set
 *                  stage → VALIDATION_ERROR (no un-mark this sprint).
 *
 * TRIGGER 2 PRODUCER (ADR-010, H-02): after COMMIT, reaching `posted` emits
 * `pipeline:posted { clientId, period, postedAt }` where postedAt is the server
 * IST CURRENT_DATE — there is no posted_date column. The Sprint 7 calendar
 * listener consumes it; no socket broadcast here.
 *
 * (coming_shoot_date is written by the Trigger 1 listener, STEP 3 — never here.)
 */
import { sql, type Kysely, type Updateable } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, currentIstDate, optimisticUpdate, type Executor } from './BaseService.js';
import { transactionWithEmits } from '../lib/emit-after-commit.js';
import { AppError } from '../lib/errors.js';
import { eventBus } from '../lib/EventBus.js';
import { broadcastToOrg } from '../sockets/index.js';

import type { CurrentUser } from './AttendanceService.js';
import type { DB } from '@skaly/shared';

/** The three manual stages and their target timestamp columns (reconciliation #2). */
export const STAGES = ['raw', 'finals', 'posted'] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_COLUMN: Record<Stage, 'raw_received_at' | 'finals_ready_at' | 'posted_at'> = {
  raw: 'raw_received_at',
  finals: 'finals_ready_at',
  posted: 'posted_at',
};

/** Derived pipeline status (04-APPFLOW §7 — no stored column). */
export type PipelineStatus = 'Awaiting' | 'Editing' | 'Review' | 'Posted';

/** One pipeline row in the §9 wire shape (camelCase at the boundary). */
export interface PipelineDTO {
  id: string;
  period: string;
  clientId: string;
  clientName: string;
  visitType: string | null;
  lastShootDate: string | null; // YYYY-MM-DD
  rawReceivedAt: string | null; // ISO
  finalsReadyAt: string | null; // ISO
  postedAt: string | null; // ISO
  comingShootDate: string | null; // YYYY-MM-DD
  comingShootSource: string | null; // 'trigger' | 'manual' | null
  version: number;
  updatedBy: { staffId: string; name: string | null; avatarUrl: string | null } | null;
  /** Derived from which timestamps are set — not stored. */
  status: PipelineStatus;
  /** Count of raw/finals/posted set (0–3) — drives the progress bar. */
  stagesComplete: number;
}

/** Raw joined row → wire shape. Dates arrive pre-formatted via to_char. */
interface JoinedPipelineRow {
  id: string;
  period: string;
  client_id: string;
  client_name: string;
  visit_type: string | null;
  last_shoot_date: string | null;
  raw_received_at: Date | string | null;
  finals_ready_at: Date | string | null;
  posted_at: Date | string | null;
  coming_shoot_date: string | null;
  coming_shoot_source: string | null;
  version: number;
  updated_by: string | null;
  updated_by_name: string | null;
  updated_by_avatar: string | null;
}

const iso = (v: Date | string | null): string | null =>
  v instanceof Date ? v.toISOString() : v;

function deriveStatus(raw: unknown, finals: unknown, posted: unknown): PipelineStatus {
  if (posted) return 'Posted';
  if (finals) return 'Review';
  if (raw) return 'Editing';
  return 'Awaiting';
}

function pipelineToDTO(row: JoinedPipelineRow): PipelineDTO {
  const raw = row.raw_received_at;
  const finals = row.finals_ready_at;
  const posted = row.posted_at;
  return {
    id: row.id,
    period: row.period,
    clientId: row.client_id,
    clientName: row.client_name,
    visitType: row.visit_type,
    lastShootDate: row.last_shoot_date,
    rawReceivedAt: iso(raw),
    finalsReadyAt: iso(finals),
    postedAt: iso(posted),
    comingShootDate: row.coming_shoot_date,
    comingShootSource: row.coming_shoot_source,
    version: row.version,
    updatedBy: row.updated_by
      ? { staffId: row.updated_by, name: row.updated_by_name, avatarUrl: row.updated_by_avatar }
      : null,
    status: deriveStatus(raw, finals, posted),
    stagesComplete: [raw, finals, posted].filter(Boolean).length,
  };
}

export class ContentDropperService {
  private readonly audit = new AuditService();

  /** Pipeline joined with client name + updated_by name/avatar; dates as stable strings. */
  private pipelineQuery(trx: Executor) {
    return trx
      .selectFrom('content_pipelines')
      .innerJoin('clients', 'clients.id', 'content_pipelines.client_id')
      .leftJoin('staff', 'staff.id', 'content_pipelines.updated_by')
      .select([
        'content_pipelines.id',
        'content_pipelines.period',
        'content_pipelines.client_id',
        'clients.name as client_name',
        'content_pipelines.visit_type',
        sql<string | null>`to_char(content_pipelines.last_shoot_date, 'YYYY-MM-DD')`.as('last_shoot_date'),
        'content_pipelines.raw_received_at',
        'content_pipelines.finals_ready_at',
        'content_pipelines.posted_at',
        sql<string | null>`to_char(content_pipelines.coming_shoot_date, 'YYYY-MM-DD')`.as('coming_shoot_date'),
        'content_pipelines.coming_shoot_source',
        'content_pipelines.version',
        'content_pipelines.updated_by',
        'staff.name as updated_by_name',
        'staff.avatar_url as updated_by_avatar',
      ]);
  }

  /**
   * Every pipeline row for `period`, active non-internal clients only, ordered by
   * client name. Status + stagesComplete are derived per row (no stored column).
   * admin/manager only (route-gated; asserted here as layer 3).
   */
  async getGrid(period: string, currentUser: CurrentUser, trx: Executor): Promise<PipelineDTO[]> {
    this.assertAdminOrManager(currentUser);

    const rows = await this.pipelineQuery(trx)
      .where('content_pipelines.period', '=', period)
      .where('clients.deleted_at', 'is', null)
      .where('clients.active', '=', true)
      .where('clients.is_internal', '=', false)
      .orderBy('clients.name')
      .execute();

    return rows.map((r) => pipelineToDTO(r as JoinedPipelineRow));
  }

  /**
   * Mark a stage. admin/manager only. One transaction: load → lock gate →
   * forward-only guard → sequence check → optimisticUpdate (server timestamp +
   * version bump) → audit. Trigger 2 (`pipeline:posted`) emits strictly AFTER
   * COMMIT when the stage is `posted`.
   */
  async updateStage(
    id: string,
    stage: Stage,
    currentUser: CurrentUser,
    expectedVersion: number,
    db: Kysely<DB>,
  ): Promise<PipelineDTO> {
    this.assertAdminOrManager(currentUser);
    const column = STAGE_COLUMN[stage];

    const { clientId, period } = await transactionWithEmits(db, async (trx) => {
      const row = await trx
        .selectFrom('content_pipelines')
        .select(['id', 'period', 'client_id', 'raw_received_at', 'finals_ready_at', 'posted_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) {
        throw new AppError('RESOURCE_NOT_FOUND', `content_pipelines row ${id} does not exist.`);
      }

      await assertPeriodNotLocked(row.period, trx);

      // Forward-only (reconciliation #9): re-marking a set stage is rejected.
      if (row[column] != null) {
        throw new AppError('VALIDATION_ERROR', `Stage "${stage}" is already marked.`);
      }

      // Sequence raw → finals → posted (04-APPFLOW §7).
      if (stage === 'finals' && row.raw_received_at == null) {
        throw new AppError('STAGE_SEQUENCE_VIOLATION', 'Mark RAW before Finals.');
      }
      if (stage === 'posted' && row.finals_ready_at == null) {
        throw new AppError('STAGE_SEQUENCE_VIOLATION', 'Mark Finals before Posted.');
      }

      // Versioned write (C-02): sets the server timestamp, bumps version, or 409.
      const patch = { [column]: sql`now()`, updated_by: currentUser.staffId };
      await optimisticUpdate(
        'content_pipelines',
        id,
        expectedVersion,
        patch as Omit<Updateable<DB['content_pipelines']>, 'version' | 'updated_at' | 'id'>,
        trx,
      );

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'content_pipelines',
        entityId: id,
        before: { [column]: null },
        after: { [column]: 'now()', stage },
        trx,
      });

      return { clientId: row.client_id, period: row.period };
    });

    // ── After COMMIT — Trigger 2 (H-02): server-computed IST CURRENT_DATE, no
    // posted_date column. The content-calendar:updated broadcast belongs to
    // Sprint 7's listener, not here — this only announces the dropper's own grid.
    if (stage === 'posted') {
      eventBus.emit('pipeline:posted', { clientId, period, postedAt: currentIstDate() });
    }

    // API-Contract §6. Forward-wiring for Sprint 10 — no consumer yet (ADR-010).
    broadcastToOrg('content-dropper:updated', { clientId, period });

    return this.getRow(id, db);
  }

  /**
   * TRIGGER 1 consumer (ADR-012). Recompute coming_shoot_date for one
   * client+period from the LIVE confirmed-future slot set — never pushed from an
   * event payload. Guarded by coming_shoot_source ('manual' wins). The UPDATE is
   * ORTHOGONAL: it touches only coming_shoot_date + coming_shoot_source, never
   * `version` and never optimisticUpdate — so a background recompute can't
   * false-conflict a concurrent stage PATCH. Idempotent; safe to run repeatedly.
   * Owns its own short transaction (the event handler has none).
   */
  async recomputeComingShootDate(clientId: string, period: string, db: Kysely<DB>): Promise<void> {
    await transactionWithEmits(db, async (trx) => {
      // nextDate = MIN(slot_date) over confirmed, still-upcoming slots; NULL if none.
      const agg = await trx
        .selectFrom('shoot_schedules')
        .select(sql<string | null>`to_char(min(slot_date), 'YYYY-MM-DD')`.as('next_date'))
        .where('client_id', '=', clientId)
        .where('period', '=', period)
        .where('slot_status', '=', 'Confirmed')
        .where('slot_date', '>=', sql<string>`CURRENT_DATE`)
        .executeTakeFirst();
      const nextDate = agg?.next_date ?? null;

      const pipeline = await trx
        .selectFrom('content_pipelines')
        .select([
          'id',
          'coming_shoot_source',
          sql<string | null>`to_char(coming_shoot_date, 'YYYY-MM-DD')`.as('coming_shoot_date'),
        ])
        .where('client_id', '=', clientId)
        .where('period', '=', period)
        .executeTakeFirst();
      // No pipeline row (client has none for this period) → nothing to project onto.
      if (!pipeline) return;
      // Manual override wins — never clobber it (guard mirrors calendar M-04).
      if (pipeline.coming_shoot_source === 'manual') return;
      // Idempotent no-op: value already correct and already sourced 'trigger'.
      if (pipeline.coming_shoot_date === nextDate && pipeline.coming_shoot_source === 'trigger') return;

      // Orthogonal write — NO version bump, NO optimisticUpdate (ADR-012).
      const changes: Record<string, unknown> = {
        coming_shoot_date: nextDate,
        coming_shoot_source: 'trigger',
      };
      await trx
        .updateTable('content_pipelines')
        .set(changes)
        .where('period', '=', period)
        .where('client_id', '=', clientId)
        .execute();

      // Automated write → System Actor + changed_by_source 'system' (C-04).
      await this.audit.log({
        actorId: null,
        action: 'UPDATE',
        entity: 'content_pipelines',
        entityId: pipeline.id,
        before: { coming_shoot_date: pipeline.coming_shoot_date },
        after: { coming_shoot_date: nextDate, coming_shoot_source: 'trigger' },
        trx,
      });
    });
  }

  /**
   * Single pipeline row (with derived status), or 404.
   *
   * Public since Sprint 9: `update_pipeline_stage`'s turn-1 read needs the row AND
   * its `version` to capture (ADR-014 §2), and the alternative was a raw query in
   * the tool. Carries no role filter of its own — the Dropper is admin/manager at
   * every layer (ROLE_DEFAULTS, the route, and `updateStage`), so there is no
   * lower-privileged caller for it to leak to.
   */
  async getRow(id: string, trx: Executor): Promise<PipelineDTO> {
    const row = await this.pipelineQuery(trx).where('content_pipelines.id', '=', id).executeTakeFirst();
    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `content_pipelines row ${id} does not exist.`);
    }
    return pipelineToDTO(row as JoinedPipelineRow);
  }

  /** Defensive layer-3 assert — the route already gates (Auth-Matrix §3–§4). */
  private assertAdminOrManager(currentUser: CurrentUser): void {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to use the Content Dropper.');
    }
  }
}
