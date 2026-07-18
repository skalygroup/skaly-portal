/**
 * ClientService — read side (07-API-CONTRACT §clients). Every SELECT goes
 * through softDeletable so soft-deleted clients never surface (audit H-02).
 *
 * TODO(client-create): when POST /v1/clients / reactivate is built, the same
 * transaction must call ShootPlannerService.backfillClientSlots(clientId,
 * getCurrentPeriod().period, trx) for active non-internal clients.
 * TODO(Sprint 6/7): backfill pipeline + calendar rows for a mid-month client
 * in the same place.
 */
import { AuditService } from './AuditService.js';
import { AppError } from '../lib/errors.js';
import { softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Executor } from './BaseService.js';
import type { Clients, DB } from '@skaly/shared';
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
   * Rename a client (admin/manager; route-gated). clients is NOT versioned →
   * plain last-write-wins UPDATE, soft-delete guarded. The frontend invalidates
   * every query keyed by this clientId so the new name propagates across modules
   * (04-APPFLOW §7). Returns the updated client.
   */
  async rename(id: string, name: string, currentUser: CurrentUser, db: Kysely<DB>): Promise<ClientListItem> {
    return db.transaction().execute(async (trx) => {
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
  }
}