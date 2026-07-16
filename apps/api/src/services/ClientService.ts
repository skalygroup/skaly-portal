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
import { softDeletable } from '../lib/queries.js';

import type { Executor } from './BaseService.js';

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

export class ClientService {
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
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isInternal: r.is_internal,
      active: r.active,
      shootSlotsPerMonth: r.shoot_slots_per_month,
      piecesPerVisit: r.pieces_per_visit,
      whatsappNumber: r.whatsapp_number,
      createdAt: r.created_at.toISOString(),
    }));
  }
}