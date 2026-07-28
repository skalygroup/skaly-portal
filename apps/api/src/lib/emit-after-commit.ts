/**
 * The ONE way a socket event leaves a service. Emit AFTER COMMIT, not after write.
 *
 * WHY THIS EXISTS
 *
 * Sprint 9 had a persist-then-emit rule and a test for it, and the test passed for
 * nine sprints by luck: BotService.finalise happened to `await` a database write
 * AFTER the emit, and that await gave the async assertion time to observe the
 * already-persisted session. Remove the incidental await — as ADR-021 correctly did,
 * by moving both durable writes ahead of the emit — and the test failed without the
 * product having regressed. An outcome test cannot tell ordered from luckily ordered.
 *
 * WHY "COMMIT" AND NOT "WRITE"
 *
 * NotificationService.create runs inside the CALLER's transaction: it inserts through
 * `trx` and then emits. The row is written but not committed. If the caller's
 * transaction subsequently rolls back, the notification row vanishes and the emit has
 * already gone out. Before ADR-022 that was a spurious bell. After ADR-022 it is
 * worse: subscribers PATCH their caches from these payloads, so fifty clients are left
 * holding a state that never existed in the database, with no refetch coming to
 * correct them — a patch is only safe if the thing it describes is durable.
 *
 * WHY AsyncLocalStorage, matching lib/bot/actor-context.ts
 *
 * The alternative is threading an emit buffer through every service signature and
 * remembering to forward it at every nested call site — where "forgot one" is silent
 * and shows up as a phantom update. Same argument ADR-016 made for actor attribution,
 * same solution: whatever emits inside the transaction's execution window is held
 * until that window commits, however deep it sits.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from './logger.js';

import type { Kysely, Transaction } from 'kysely';

interface QueuedEmit {
  namespace: string;
  room: string;
  event: string;
  payload: unknown;
}

const store = new AsyncLocalStorage<QueuedEmit[]>();

/**
 * Injected by sockets/index.ts at boot rather than imported, to keep this module free
 * of a cycle (sockets → services → here → sockets). Undefined under unit test, where
 * there is no io; emits are then dropped with a debug line, never thrown.
 */
type Sender = (namespace: string, room: string, event: string, payload: unknown) => void;
let send: Sender | undefined;

export function setEmitter(sender: Sender): void {
  send = sender;
}

/** Test seam: drop the registered sender so a suite starts from a known state. */
export function resetEmitter(): void {
  send = undefined;
}

function deliver(e: QueuedEmit): void {
  if (!send) {
    logger.debug({ event: e.event }, 'emit dropped — no socket sender registered');
    return;
  }
  try {
    send(e.namespace, e.room, e.event, e.payload);
  } catch (err) {
    // Fire-and-forget by contract: a socket failure must never roll back or surface
    // on a request that already committed.
    logger.warn({ err, event: e.event, room: e.room }, 'socket emit failed');
  }
}

/**
 * Run a transaction whose queued emits flush only after it COMMITS.
 *
 * Use this instead of `db.transaction().execute(...)` anywhere the work inside can
 * emit — which, once a service writes a notification, is nearly everywhere.
 */
export async function transactionWithEmits<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const queue: QueuedEmit[] = [];
  // A throw propagates out of store.run, so the flush below is unreachable and the
  // queue is discarded with the rolled-back rows. That is the entire mechanism.
  const result = await store.run(queue, () => db.transaction().execute(fn));
  for (const e of queue) deliver(e);
  return result;
}

/**
 * Emit `event` to `room` on `namespace`.
 *
 * Inside a `transactionWithEmits` window the emit is QUEUED and delivered on commit.
 * Outside one it is delivered immediately — which is correct for genuinely
 * non-transactional broadcasts, and is the only reason this is safe to call anywhere.
 */
export function emitAfterCommit(namespace: string, room: string, event: string, payload: unknown): void {
  const queue = store.getStore();
  if (queue) {
    queue.push({ namespace, room, event, payload });
    return;
  }
  deliver({ namespace, room, event, payload });
}

/** True when called inside a transactionWithEmits window — for tests and assertions. */
export function isDeferringEmits(): boolean {
  return store.getStore() !== undefined;
}
