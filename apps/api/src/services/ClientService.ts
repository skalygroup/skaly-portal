/**
 * ClientService — read side (07-API-CONTRACT §clients). Every SELECT goes
 * through softDeletable so soft-deleted clients never surface (audit H-02).
 *
 * TODO(client-create): POST /v1/clients and the reactivate flow do not exist
 * yet. When they are built, the insert transaction must call
 * `backfillClientPeriodRows(clientId, (await getCurrentPeriod(trx)).period, trx)`
 * — one call, already written and tested (period-generation.ts), which covers
 * all three row sets (shoot slots + pipeline row + calendar cells) and no-ops
 * for inactive/internal clients. Sprint 7 closed the generator half of the
 * carried Sprint 5/6 debt; only this call site remains.
 */
import { AuditService } from './AuditService.js';
import { AppError } from '../lib/errors.js';
import { softDeletable } from '../lib/queries.js';
import { broadcastToOrg } from '../sockets/index.js';

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