/**
 * Bot write attribution (ADR-016) — `changed_by_source = 'bot'` for the duration
 * of a bot-mediated write, without threading a parameter through eleven service
 * signatures.
 *
 * WHY AsyncLocalStorage rather than an argument.
 *
 * A bot mutation tool calls the SAME service method the REST route calls; that is
 * the whole parity discipline, and the reason 423/409/403/400 pass through
 * unchanged. Those methods write audit rows through 29 `audit.log(...)` call sites
 * across 10 services, and many are NESTED — the H-01 attendance revert,
 * `create`'s three backfills, ADR-006's assignee fan-out, ADR-013's
 * trigger writes. Threading `actorSource` would mean:
 *
 *   - changing every mutating method's signature, and
 *   - remembering to forward it at every nested call — where "forgot one" is
 *     silent, and shows up as a bot write audited as a hand edit.
 *
 * A request-scoped store gets it right by construction: whatever writes inside the
 * bot's execution window is attributed to the bot, however deep it sits.
 *
 * `staff_id` is NOT touched here — it is the JWT caller, which the services already
 * pass. ADR-016 attributes the write to the human; only the source says a bot
 * composed it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ChangedBySource } from '../../services/AuditService.js';

const store = new AsyncLocalStorage<ChangedBySource>();

/**
 * Run `fn` with every audit write inside it attributed to `source`.
 * Wrap ONLY the tool execution — not the whole turn, or the transcript archive
 * and session bookkeeping would be tagged too.
 */
export function withActorSource<T>(source: ChangedBySource, fn: () => Promise<T>): Promise<T> {
  return store.run(source, fn);
}

/** The ambient source, or undefined outside any bot execution window. */
export function currentActorSource(): ChangedBySource | undefined {
  return store.getStore();
}
