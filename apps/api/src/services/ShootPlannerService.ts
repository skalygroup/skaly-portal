/**
 * ShootPlannerService — the read/write core behind the Shoot Planner grid
 * (04-APPFLOW §6, 07-API-CONTRACT §8, 08-AUTH-MATRIX §4/§8).
 *
 *   - getGrid — all slots for a period (+ client columns); freelancers get a
 *     query-level `freelancer_id = self` predicate (ADR-011 / audit M-07).
 *   - getSlot — single slot; freelancer non-owned → 404 (existence hidden).
 *   - update  — the Unset → Scheduled → Confirmed → Completed lifecycle.
 *     shoot_schedules has NO version (schema): plain guarded UPDATE,
 *     last-write-wins, never optimisticUpdate / STALE_DATA.
 *   - reset   — any non-Unset state → Unset; `confirm: true` mandatory
 *     (400 SHOOT_RESET_CONFIRMATION_REQUIRED otherwise).
 *
 * TRIGGER 1 PRODUCER (ADR-010): after the transaction COMMITs, a Confirmed
 * result emits `shoot:confirmed` and writes the durable `shoot_confirmed`
 * notification to the assigned freelancer; reset emits `shoot:reset`.
 * coming_shoot_date is recomputed by the Sprint 6 listener on shoot:confirmed /
 * shoot:reset (derived, guarded by coming_shoot_source) — this service never
 * writes content_pipelines.
 */
import { sql, type Kysely, type Transaction } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, getCurrentPeriod, type Executor } from './BaseService.js';
import { NotificationService } from './NotificationService.js';
import { generateShootSlotsForClient } from './period-generation.js';
import { transactionWithEmits } from '../lib/emit-after-commit.js';
import { AppError } from '../lib/errors.js';
import { eventBus } from '../lib/EventBus.js';
import { softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { DB } from '@skaly/shared';

/** slot_status enum (05-BACKEND-SCHEMA shoot_schedules CHECK). */
export const SLOT_STATUSES = ['Unset', 'Scheduled', 'Confirmed', 'Completed'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** The only legal forward move from each state. Backward moves go through reset. */
const NEXT_STATUS: Record<SlotStatus, SlotStatus | null> = {
  Unset: 'Scheduled',
  Scheduled: 'Confirmed',
  Confirmed: 'Completed',
  Completed: null,
};

/** The fields a PATCH may change. No `version` — shoot slots are not versioned. */
export interface SlotPatch {
  slotStatus?: SlotStatus;
  slotDate?: string; // YYYY-MM-DD
  piecesExpected?: number;
  freelancerId?: string | null;
}

/** One slot in the §8 wire shape (camelCase at the boundary). */
export interface SlotDTO {
  id: string;
  period: string;
  clientId: string;
  clientName: string;
  slotIndex: number;
  slotStatus: string;
  slotDate: string | null;
  piecesExpected: number;
  freelancerId: string | null;
  freelancerName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ShootGrid {
  slots: SlotDTO[];
  /** Active non-internal clients — the frontend sizes columns off shootSlotsPerMonth. */
  clients: { id: string; name: string; shootSlotsPerMonth: number; piecesPerVisit: number }[];
}

/** Raw joined row → wire shape. slot_date arrives pre-formatted via to_char. */
interface JoinedSlotRow {
  id: string;
  period: string;
  client_id: string;
  client_name: string;
  slot_index: number;
  slot_status: string;
  slot_date: string | null;
  pieces_expected: number;
  freelancer_id: string | null;
  freelancer_name: string | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

function slotToDTO(row: JoinedSlotRow): SlotDTO {
  return {
    id: row.id,
    period: row.period,
    clientId: row.client_id,
    clientName: row.client_name,
    slotIndex: row.slot_index,
    slotStatus: row.slot_status,
    slotDate: row.slot_date,
    piecesExpected: row.pieces_expected,
    freelancerId: row.freelancer_id,
    freelancerName: row.freelancer_name,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ?? null),
    updatedBy: row.updated_by,
  };
}

export class ShootPlannerService {
  private readonly audit = new AuditService();
  private readonly notifications = new NotificationService();

  /** The slots-joined-with-names base query, slot_date as a stable string. */
  private slotQuery(trx: Executor) {
    return trx
      .selectFrom('shoot_schedules')
      .innerJoin('clients', 'clients.id', 'shoot_schedules.client_id')
      .leftJoin('staff', 'staff.id', 'shoot_schedules.freelancer_id')
      .select([
        'shoot_schedules.id',
        'shoot_schedules.period',
        'shoot_schedules.client_id',
        'clients.name as client_name',
        'shoot_schedules.slot_index',
        'shoot_schedules.slot_status',
        sql<string | null>`to_char(shoot_schedules.slot_date, 'YYYY-MM-DD')`.as('slot_date'),
        'shoot_schedules.pieces_expected',
        'shoot_schedules.freelancer_id',
        'staff.name as freelancer_name',
        'shoot_schedules.updated_at',
        'shoot_schedules.updated_by',
      ]);
  }

  /**
   * The full grid for `period`. admin/manager/team_member read everything;
   * freelancer gets `WHERE freelancer_id = self` ON THE QUERY — never a
   * post-fetch filter (ADR-011). Unassigned slots are invisible to freelancers.
   */
  async getGrid(period: string, currentUser: CurrentUser, trx: Executor): Promise<ShootGrid> {
    let slotsQb = this.slotQuery(trx).where('shoot_schedules.period', '=', period);
    if (currentUser.role === 'freelancer') {
      slotsQb = slotsQb.where('shoot_schedules.freelancer_id', '=', currentUser.staffId);
    }
    const slotRows = await slotsQb.orderBy('clients.name').orderBy('shoot_schedules.slot_index').execute();
    const slots = slotRows.map((r) => slotToDTO(r as JoinedSlotRow));

    let clientsQb = softDeletable(
      trx
        .selectFrom('clients')
        .select(['id', 'name', 'shoot_slots_per_month', 'pieces_per_visit'])
        .where('active', '=', true)
        .where('is_internal', '=', false),
    ).orderBy('name');
    // A freelancer sees only the clients their own slots belong to (ADR-011).
    if (currentUser.role === 'freelancer') {
      const clientIds = [...new Set(slots.map((s) => s.clientId))];
      if (clientIds.length === 0) return { slots, clients: [] };
      clientsQb = clientsQb.where('id', 'in', clientIds);
    }
    const clients = await clientsQb.execute();

    return {
      slots,
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        shootSlotsPerMonth: c.shoot_slots_per_month,
        piecesPerVisit: c.pieces_per_visit,
      })),
    };
  }

  /** Single slot. Freelancer + not owned → 404 (don't reveal existence). */
  async getSlot(id: string, currentUser: CurrentUser, trx: Executor): Promise<SlotDTO> {
    const row = await this.slotQuery(trx).where('shoot_schedules.id', '=', id).executeTakeFirst();
    if (!row || (currentUser.role === 'freelancer' && row.freelancer_id !== currentUser.staffId)) {
      throw new AppError('RESOURCE_NOT_FOUND', `shoot_schedules row ${id} does not exist.`);
    }
    return slotToDTO(row as JoinedSlotRow);
  }

  /**
   * Drive the slot lifecycle. admin/manager only (route-gated; asserted here as
   * the third layer). Opens its own transaction so the Trigger-1 emit + the
   * shoot_confirmed notification fire strictly AFTER COMMIT — a notify failure
   * can never roll back the slot write.
   */
  async update(id: string, patch: SlotPatch, currentUser: CurrentUser, db: Kysely<DB>): Promise<SlotDTO> {
    this.assertAdminOrManager(currentUser);

    const { updated, clientName, effectiveDate } = await transactionWithEmits(db, async (trx) => {
      const slot = await this.loadSlotRow(id, trx);
      await assertPeriodNotLocked(slot.period, trx);

      const from = slot.slot_status as SlotStatus;
      const to = patch.slotStatus ?? from;
      // Same-state field edits are fine; otherwise only the single forward move.
      if (to !== from && NEXT_STATUS[from] !== to) {
        throw new AppError('VALIDATION_ERROR', `Invalid slot transition: ${from} → ${to}.`);
      }

      const effectiveDate = patch.slotDate ?? slot.slot_date;
      if ((to === 'Scheduled' || to === 'Confirmed') && !effectiveDate) {
        throw new AppError('VALIDATION_ERROR', 'A shoot date is required to schedule or confirm a slot.');
      }

      // Plain guarded UPDATE — shoot_schedules has no version (last-write-wins).
      const changes: Record<string, unknown> = {
        updated_by: currentUser.staffId,
        updated_at: sql`now()`,
      };
      if (patch.slotStatus !== undefined) changes.slot_status = patch.slotStatus;
      if (patch.slotDate !== undefined) changes.slot_date = patch.slotDate;
      if (patch.piecesExpected !== undefined) changes.pieces_expected = patch.piecesExpected;
      if (patch.freelancerId !== undefined) changes.freelancer_id = patch.freelancerId;

      const row = await trx
        .updateTable('shoot_schedules')
        .set(changes)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'shoot_schedules',
        entityId: id,
        before: {
          slot_status: slot.slot_status,
          slot_date: slot.slot_date,
          pieces_expected: slot.pieces_expected,
          freelancer_id: slot.freelancer_id,
        },
        after: {
          slot_status: row.slot_status,
          slot_date: patch.slotDate ?? slot.slot_date,
          pieces_expected: row.pieces_expected,
          freelancer_id: row.freelancer_id,
        },
        trx,
      });

      return { updated: row, clientName: slot.client_name, effectiveDate };
    });

    // ── After COMMIT — Trigger 1 (ADR-010). Covers first-confirm AND a
    // reschedule of an already-Confirmed slot (resulting state is what counts).
    const slotDate = effectiveDate;
    if (updated.slot_status === 'Confirmed' && slotDate) {
      eventBus.emit('shoot:confirmed', {
        clientId: updated.client_id,
        period: updated.period,
        slotDate,
      });
      // Durable per-record notification (ADR-006/ADR-010 distinction). Actor
      // exclusion for consistency — unreachable in practice (freelancers are
      // read-only here).
      if (updated.freelancer_id && updated.freelancer_id !== currentUser.staffId) {
        await this.notifications.create({
          recipientId: updated.freelancer_id,
          type: 'shoot_confirmed',
          title: `${clientName} shoot confirmed`,
          body: `Shoot confirmed for ${slotDate}`,
          data: {
            slotId: id,
            clientId: updated.client_id,
            period: updated.period,
            slotDate,
            link: `/shoot-planner?period=${updated.period}`,
          },
          trx: db,
        });
      }
    }

    return this.getSlot(id, currentUser, db);
  }

  /**
   * Reset a slot to Unset from any non-Unset state. `confirm: true` is
   * mandatory (04-APPFLOW §6). Clears slot_date + freelancer_id and restores
   * pieces_expected to the client's pieces_per_visit (the generated default).
   */
  async reset(
    id: string,
    currentUser: CurrentUser,
    confirm: boolean | undefined,
    db: Kysely<DB>,
  ): Promise<{ reset: true }> {
    this.assertAdminOrManager(currentUser);

    if (confirm !== true) {
      throw new AppError(
        'SHOOT_RESET_CONFIRMATION_REQUIRED',
        'Resetting a slot requires explicit confirmation.',
      );
    }

    const slot = await transactionWithEmits(db, async (trx) => {
      const row = await this.loadSlotRow(id, trx);
      await assertPeriodNotLocked(row.period, trx);

      if (row.slot_status === 'Unset') {
        throw new AppError('VALIDATION_ERROR', 'This slot is already Unset.');
      }

      const client = await trx
        .selectFrom('clients')
        .select('pieces_per_visit')
        .where('id', '=', row.client_id)
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('shoot_schedules')
        .set({
          slot_status: 'Unset',
          slot_date: null,
          freelancer_id: null,
          pieces_expected: client.pieces_per_visit,
          updated_by: currentUser.staffId,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .execute();

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'shoot_schedules',
        entityId: id,
        before: {
          slot_status: row.slot_status,
          slot_date: row.slot_date,
          pieces_expected: row.pieces_expected,
          freelancer_id: row.freelancer_id,
        },
        after: {
          slot_status: 'Unset',
          slot_date: null,
          pieces_expected: client.pieces_per_visit,
          freelancer_id: null,
        },
        trx,
      });

      return row;
    });

    // After COMMIT — Sprint 6 recomputes coming_shoot_date off this.
    eventBus.emit('shoot:reset', { clientId: slot.client_id, period: slot.period });

    return { reset: true };
  }

  /**
   * Mid-month backfill: generate the current-period slots for ONE client
   * (04-APPFLOW §6). Runs on the caller's transaction — the client-create /
   * reactivate flow calls this atomically with its own insert. Idempotent; a
   * client that is inactive or internal gets no slots (returns 0). Returns the
   * number of slots created.
   */
  async backfillClientSlots(clientId: string, period: string, trx: Transaction<DB>): Promise<number> {
    const client = await trx
      .selectFrom('clients')
      .select(['id', 'shoot_slots_per_month', 'pieces_per_visit', 'active', 'is_internal'])
      .where('id', '=', clientId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!client) {
      throw new AppError('RESOURCE_NOT_FOUND', `clients row ${clientId} does not exist.`);
    }
    if (!client.active || client.is_internal) return 0;
    return generateShootSlotsForClient(client, period, trx);
  }

  /**
   * Change a client's shoot_slots_per_month (admin only; audit H-06 family) and
   * reconcile the CURRENT period's slots: increase fills the gap with Unset
   * slots; decrease removes ONLY trailing Unset slots and rejects if any slot
   * beyond the new count is Scheduled/Confirmed/Completed. Past periods are
   * historical — never touched. Future periods pick the new count up via
   * rollover.
   */
  async adjustSlotCount(
    clientId: string,
    newCount: number,
    currentUser: CurrentUser,
    db: Kysely<DB>,
  ): Promise<{ clientId: string; shootSlotsPerMonth: number; slotsAdded: number; slotsRemoved: number }> {
    if (currentUser.role !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'Only admins can adjust a client slot count.');
    }
    if (!Number.isInteger(newCount) || newCount < 1 || newCount > 20) {
      throw new AppError('VALIDATION_ERROR', 'slotsPerMonth must be an integer between 1 and 20.');
    }

    return transactionWithEmits(db, async (trx) => {
      const client = await trx
        .selectFrom('clients')
        .select(['id', 'shoot_slots_per_month', 'pieces_per_visit', 'active', 'is_internal'])
        .where('id', '=', clientId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!client) {
        throw new AppError('RESOURCE_NOT_FOUND', `clients row ${clientId} does not exist.`);
      }

      await trx
        .updateTable('clients')
        .set({ shoot_slots_per_month: newCount })
        .where('id', '=', clientId)
        .execute();

      // ── Reconcile the current period only (internal/inactive: nothing to do) ─
      let slotsAdded = 0;
      let slotsRemoved = 0;
      if (client.active && !client.is_internal) {
        const { period } = await getCurrentPeriod(trx);
        const slots = await trx
          .selectFrom('shoot_schedules')
          .select(['slot_index', 'slot_status'])
          .where('period', '=', period)
          .where('client_id', '=', clientId)
          .execute();
        const maxIndex = Math.max(0, ...slots.map((s) => s.slot_index));

        if (newCount > maxIndex) {
          slotsAdded = await generateShootSlotsForClient(
            { ...client, shoot_slots_per_month: newCount },
            period,
            trx,
          );
        } else if (newCount < maxIndex) {
          const blocking = slots
            .filter((s) => s.slot_index > newCount && s.slot_status !== 'Unset')
            .sort((a, b) => a.slot_index - b.slot_index)[0];
          if (blocking) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Reset or complete slot ${blocking.slot_index} before reducing the count.`,
            );
          }
          const removed = await trx
            .deleteFrom('shoot_schedules')
            .where('period', '=', period)
            .where('client_id', '=', clientId)
            .where('slot_index', '>', newCount)
            .where('slot_status', '=', 'Unset')
            .returning('id')
            .execute();
          slotsRemoved = removed.length;
        }
      }

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'clients',
        entityId: clientId,
        before: { shoot_slots_per_month: client.shoot_slots_per_month },
        after: { shoot_slots_per_month: newCount },
        trx,
      });

      return { clientId, shootSlotsPerMonth: newCount, slotsAdded, slotsRemoved };
    });
  }

  /** Load a slot (+ client name, slot_date pre-formatted) or 404. */
  private async loadSlotRow(id: string, trx: Executor) {
    const row = await trx
      .selectFrom('shoot_schedules')
      .innerJoin('clients', 'clients.id', 'shoot_schedules.client_id')
      .select([
        'shoot_schedules.id',
        'shoot_schedules.period',
        'shoot_schedules.client_id',
        'clients.name as client_name',
        'shoot_schedules.slot_status',
        sql<string | null>`to_char(shoot_schedules.slot_date, 'YYYY-MM-DD')`.as('slot_date'),
        'shoot_schedules.pieces_expected',
        'shoot_schedules.freelancer_id',
      ])
      .where('shoot_schedules.id', '=', id)
      .executeTakeFirst();
    if (!row) {
      throw new AppError('RESOURCE_NOT_FOUND', `shoot_schedules row ${id} does not exist.`);
    }
    return row;
  }

  /** Defensive layer-3 assert — the route already gates (Auth-Matrix §4). */
  private assertAdminOrManager(currentUser: CurrentUser): void {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to edit the shoot planner.');
    }
  }

}
