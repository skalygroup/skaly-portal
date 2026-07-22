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
 * TRIGGER 2 (Sprint 7): pipeline:posted → ContentCalendarService.applyPostedTrigger,
 * then broadcast content-calendar:updated to org:all (API-Contract §6) — but ONLY
 * when a write actually happened. The service returns null for every skip path
 * (missing cell, locked period, manual cell, already set), so "did we write?" and
 * "do we broadcast?" are the same question.
 *
 * A failed recompute must never crash the process — the handler swallows and
 * logs; Sprint 12's daily rollover re-derives coming_shoot_date regardless. The
 * same holds for Trigger 2: the pipeline write has already committed by the time
 * the event fires, so a calendar failure must not surface to the user.
 */
import { eventBus } from '../lib/EventBus.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { ContentCalendarService } from '../services/ContentCalendarService.js';
import { ContentDropperService } from '../services/ContentDropperService.js';
import { broadcastToOrg } from '../sockets/index.js';

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
  const calendar = new ContentCalendarService();

  const recompute = async (clientId: string, period: string): Promise<void> => {
    try {
      await dropper.recomputeComingShootDate(clientId, period, db);
    } catch (err) {
      log.error({ err, clientId, period }, 'Trigger 1 recompute failed');
    }
  };

  eventBus.on('shoot:confirmed', ({ clientId, period }) => void recompute(clientId, period));
  eventBus.on('shoot:reset', ({ clientId, period }) => void recompute(clientId, period));

  // ── TRIGGER 2 — pipeline:posted → guarded calendar cell write ───────────────
  // The event's `period` is deliberately unused: the target cell is derived from
  // postedAt inside the service (a prior-month pipeline posted today updates
  // THIS month's cell).
  const applyPosted = async (clientId: string, postedAt: string): Promise<void> => {
    try {
      const written = await calendar.applyPostedTrigger(clientId, postedAt, db);
      if (!written) return; // skipped — nothing changed, so nothing to announce.
      broadcastToOrg('content-calendar:updated', { ...written });
    } catch (err) {
      log.error({ err, clientId, postedAt }, 'Trigger 2 calendar write failed');
    }
  };

  eventBus.on('pipeline:posted', ({ clientId, postedAt }) => void applyPosted(clientId, postedAt));

  log.info(
    'EventBus listeners registered: shoot:confirmed, shoot:reset → coming_shoot_date recompute; pipeline:posted → content_calendar cell',
  );
}
