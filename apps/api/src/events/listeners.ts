/**
 * EventBus listener registration (02-TRD §5.3). Attaches the cross-module
 * triggers exactly once at startup, after the shared `db` exists.
 *
 * TRIGGER 1 (Sprint 6): shoot:confirmed AND shoot:reset →
 * ContentDropperService.recomputeComingShootDate. Both events mean the same
 * thing — "this client/period's confirmed-slot set changed, recompute" — so both
 * call the SAME recompute; the shoot:confirmed payload's slotDate is deliberately
 * ignored (the recompute reads the live confirmed set, ADR-012).
 *
 * A failed recompute must never crash the process — the handler swallows and
 * logs; Sprint 12's daily rollover re-derives coming_shoot_date regardless.
 */
import { eventBus } from '../lib/EventBus.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { ContentDropperService } from '../services/ContentDropperService.js';

import type { DB } from '@skaly/shared';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

// Module-level guard: registered once per process. Protects against a double
// buildApp() (multi-instance tests) or a dev hot-reload re-registering handlers.
let registered = false;

export function registerEventListeners(db: Kysely<DB>, log: Logger = defaultLogger): void {
  if (registered) return;
  registered = true;

  const dropper = new ContentDropperService();

  const recompute = async (clientId: string, period: string): Promise<void> => {
    try {
      await dropper.recomputeComingShootDate(clientId, period, db);
    } catch (err) {
      log.error({ err, clientId, period }, 'Trigger 1 recompute failed');
    }
  };

  eventBus.on('shoot:confirmed', ({ clientId, period }) => void recompute(clientId, period));
  eventBus.on('shoot:reset', ({ clientId, period }) => void recompute(clientId, period));

  log.info('EventBus listeners registered: shoot:confirmed, shoot:reset → coming_shoot_date recompute');
}
