import { describe, test, expect, vi } from 'vitest';

import { eventBus } from '../../src/lib/EventBus.js';

describe('EventBus', () => {
  test('emitting shoot:confirmed invokes the handler with the exact payload', () => {
    const handler = vi.fn();
    eventBus.on('shoot:confirmed', handler);

    const payload = { clientId: 'client-1', period: '2026-07', slotDate: '2026-07-15' };
    eventBus.emit('shoot:confirmed', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);

    eventBus.off('shoot:confirmed', handler);
  });

  test('emitting pipeline:posted invokes its handler with the exact payload', () => {
    const handler = vi.fn();
    eventBus.on('pipeline:posted', handler);

    const payload = { clientId: 'client-1', period: '2026-07', postedAt: '2026-07-15T10:00:00Z' };
    eventBus.emit('pipeline:posted', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);

    eventBus.off('pipeline:posted', handler);
  });

  test('a wrong-shaped payload is a compile error', () => {
    // @ts-expect-error shoot:confirmed requires slotDate
    eventBus.emit('shoot:confirmed', { clientId: 'client-1', period: '2026-07' });
  });
});