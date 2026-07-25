/**
 * ClientService — clients CRUD (07-API-CONTRACT §clients). Every SELECT goes
 * through softDeletable so soft-deleted clients never surface (audit H-02).
 *
 * The role gates live HERE, not only on the routes: Sprint 9's `add_client` /
 * `deactivate_client` bot tools call these methods directly with the JWT caller,
 * so a route-only guard would let the bot write what the REST layer refuses.
 * The service is the security boundary.
 */
import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, getCurrentPeriod } from './BaseService.js';
import { backfillClientPeriodRows } from './period-generation.js';
import { AppError } from '../lib/errors.js';
import { softDelete, softDeletable } from '../lib/queries.js';
import { broadcastToOrg } from '../sockets/index.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { ClientCreateInput, Clients, DB } from '@skaly/shared';
import type { Selectable , Kysely } from 'kysely';

export interface ClientListItem {
  id: string;
  name: string;
  isInternal: boolean;
  active: boolean;
  shootSlotsPerMonth: number;
  piecesPerVisit: number;
  whatsappNumber: string | null;
  createdAt: string;
}

function clientToDTO(r: Selectable<Clients>): ClientListItem {
  return {
    id: r.id,
    name: r.name,
    isInternal: r.is_internal,
    active: r.active,
    shootSlotsPerMonth: r.shoot_slots_per_month,
    piecesPerVisit: r.pieces_per_visit,
    whatsappNumber: r.whatsapp_number,
    createdAt: r.created_at.toISOString(),
  };
}

export class ClientService {
  private readonly audit = new AuditService();

  /**
   * List clients, name-ascending. Active-only unless `includeInactive` (the
   * route enforces that only admins may pass it). Soft-deleted rows excluded.
   */
  async list(opts: { includeInactive: boolean }, trx: Executor): Promise<ClientListItem[]> {
    let query = softDeletable(trx.selectFrom('clients').selectAll());
    if (!opts.includeInactive) {
      query = query.where('active', '=', true);
    }
    const rows = await query.orderBy('name', 'asc').execute();
    return rows.map(clientToDTO);
  }

  /**
   * Create a client (admin/manager — Auth-Matrix §3, `/settings/clients` is ✅
   * for both) and generate its current-period operational rows in the SAME
   * transaction. A client that commits without its period rows is invisible to
   * Trigger 2: marking its pipeline Posted hits applyPostedTrigger's missing-cell
   * no-op and the post is never recorded on the calendar (Sprint 7's carried debt).
   *
   * `backfillClientPeriodRows` is the single call that covers all three row sets
   * (shoot slots + pipeline row + calendar cells) and already no-ops for an
   * inactive or internal client — so there is no is_internal guard here.
   *
   * Refused with 423 when the CURRENT month is locked (ADR-017). Onboarding is
   * atomic with its scaffolding: nothing backfills the current period
   * retroactively (rollover only generates the next month), so a client created
   * without its rows would be permanently half-onboarded with no error to signal
   * it. All-or-nothing is the only sound option.
   */
  async create(input: ClientCreateInput, currentUser: CurrentUser, db: Kysely<DB>): Promise<ClientListItem> {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'Only admins and managers can create clients.');
    }
    // The canonical guard: clients.shoot_slots_per_month has no DEFAULT, so an
    // absent value has nothing to fall back to. Zod catches this at the route;
    // repeated here because the bot tool calls the service directly. Range
    // matches adjustSlotCount, the column's other writer.
    const slots = input.shootSlotsPerMonth;
    if (!Number.isInteger(slots) || slots < 1 || slots > 20) {
      throw new AppError(
        'CLIENT_SHOOT_SLOTS_REQUIRED',
        'shootSlotsPerMonth is required and must be an integer between 1 and 20.',
      );
    }

    // Before the transaction opens: if the current month is locked there is
    // nothing to attempt. The scaffolding would be an illegal write into a locked
    // period, and skipping it is not an option (see above).
    const month = await getCurrentPeriod(db);
    await assertPeriodNotLocked(
      month.period,
      db,
      `Can't onboard a client into a locked month — unlock ${month.label} first, or wait for the new month to open.`,
    );

    return db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('clients')
        .values({
          name: input.name,
          shoot_slots_per_month: slots,
          pieces_per_visit: input.piecesPerVisit ?? 1,
          is_internal: input.isInternal ?? false,
          whatsapp_number: input.whatsappNumber ?? null,
          active: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await backfillClientPeriodRows(created.id, month.period, trx);

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'INSERT',
        entity: 'clients',
        entityId: created.id,
        after: {
          name: created.name,
          shootSlotsPerMonth: created.shoot_slots_per_month,
          isInternal: created.is_internal,
        },
        trx,
      });

      return clientToDTO(created);
    });
  }

  /**
   * Deactivate a client (admin only — mirrors staff deactivation; Auth-Matrix §5
   * gives `deactivate_client` to admin alone). Soft-delete + active = false.
   *
   * HISTORICAL ROWS ARE NOT TOUCHED. Existing shoot_schedules / content_pipelines
   * / content_calendar / tasks rows stay exactly as they are: the client
   * disappears from FUTURE generation (generatePeriodRows filters on active +
   * deleted_at) and from softDeletable reads, while the history it already
   * produced remains intact and auditable. Cascading would destroy the record of
   * work that actually happened.
   */
  async deactivate(id: string, currentUser: CurrentUser, db: Kysely<DB>): Promise<{ deactivated: true }> {
    if (currentUser.role !== 'admin') {
      throw new AppError('PERMISSION_DENIED', 'Only admins can deactivate clients.');
    }

    return db.transaction().execute(async (trx) => {
      const before = await softDeletable(trx.selectFrom('clients').selectAll())
        .where('id', '=', id)
        .executeTakeFirst();
      if (!before) {
        throw new AppError('RESOURCE_NOT_FOUND', `clients row ${id} does not exist.`);
      }

      await softDelete('clients', id, currentUser.staffId, trx);
      await trx.updateTable('clients').set({ active: false }).where('id', '=', id).execute();

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'DELETE',
        entity: 'clients',
        entityId: id,
        before: { name: before.name, active: before.active },
        trx,
      });

      return { deactivated: true };
    });
  }

  /**
   * Rename a client (admin/manager; route-gated). clients is NOT versioned →
   * plain last-write-wins UPDATE, soft-delete guarded. The frontend invalidates
   * every query keyed by this clientId so the new name propagates across modules
   * (04-APPFLOW §7). Returns the updated client.
   */
  async rename(id: string, name: string, currentUser: CurrentUser, db: Kysely<DB>): Promise<ClientListItem> {
    const updated = await db.transaction().execute(async (trx) => {
      const before = await softDeletable(trx.selectFrom('clients').selectAll())
        .where('id', '=', id)
        .executeTakeFirst();
      if (!before) {
        throw new AppError('RESOURCE_NOT_FOUND', `clients row ${id} does not exist.`);
      }

      const updated = await trx
        .updateTable('clients')
        .set({ name })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'clients',
        entityId: id,
        before: { name: before.name },
        after: { name },
        trx,
      });

      return clientToDTO(updated);
    });

    // After COMMIT — API-Contract §6. Forward-wiring for Sprint 10, which
    // invalidates every clientId-keyed query so a rename propagates across modules.
    broadcastToOrg('client:name_updated', { clientId: id, name });

    return updated;
  }
}