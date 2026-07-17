/**
 * Process-local, typed event bus for cross-module triggers (02-TRD §5.3).
 *
 * This is NOT the Socket.io layer. Cross-instance / cross-client fan-out is
 * Socket.io's job (STEP 7); this bus only carries in-process service-to-service
 * triggers. Services emit AFTER their originating transaction COMMITs (02-TRD
 * §5.2), and handlers run inline — no retries, no persistence.
 *
 * NO listeners are attached here. Listeners attached in Sprint 6
 * (shoot:confirmed AND shoot:reset → ContentDropperService recomputes
 * coming_shoot_date from the confirmed-future slot set, guarded by
 * coming_shoot_source) and Sprint 7 (pipeline:posted).
 */
import { EventEmitter } from 'node:events';

/** Event name → payload contract. Adding an event? Add it here first. */
export interface EventPayloads {
  /** Trigger 1 → Content Dropper (Sprint 6). */
  'shoot:confirmed': { clientId: string; period: string; slotDate: string };
  /** Slot reset → Sprint 6 recomputes coming_shoot_date for the client+period. */
  'shoot:reset': { clientId: string; period: string };
  /** Trigger 2 → Content Calendar (Sprint 7). */
  'pipeline:posted': { clientId: string; period: string; postedAt: string };
}

export type EventName = keyof EventPayloads;
export type EventHandler<E extends EventName> = (payload: EventPayloads[E]) => void | Promise<void>;

/**
 * Thin typed wrapper over Node's EventEmitter. The typed emit/on surface makes a
 * mismatched payload a compile error; at runtime it's just an EventEmitter.
 */
class TypedEventBus {
  private readonly emitter = new EventEmitter();

  emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    this.emitter.emit(event, payload);
  }

  on<E extends EventName>(event: E, handler: EventHandler<E>): void {
    this.emitter.on(event, handler);
  }

  off<E extends EventName>(event: E, handler: EventHandler<E>): void {
    this.emitter.off(event, handler);
  }
}

/** The one shared bus for the process. */
export const eventBus = new TypedEventBus();