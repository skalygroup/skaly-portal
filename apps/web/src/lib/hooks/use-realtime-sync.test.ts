import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { SYNC_MATRIX, useRealtimeSync, type RealtimePayload } from './use-realtime-sync';

// Capture socket subscriptions so a test can deliver an event as the server would.
const handlers = vi.hoisted(() => new Map<string, (p: unknown) => void>());
vi.mock('@/lib/socket', () => ({
  WS_NOTIFY: '/ws/notify',
  getSocket: () => ({
    on: (event: string, fn: (p: unknown) => void) => handlers.set(event, fn),
    off: (event: string) => handlers.delete(event),
  }),
}));

/**
 * ADR-022's matrix, asserted row by row (Sprint 10 STEP 9).
 *
 * The guide is explicit that the table IS the test: every row of the ADR must be
 * checkable here against the ADR itself. So each test names its row and asserts the
 * ACTION, not the outcome — patch vs invalidate is the decision the ADR makes, and it
 * is the thing that silently regresses.
 *
 * The two that matter most:
 *   - the calendar patch WRITING THE VERSION (rule a). Forgetting it makes the
 *     receiver's next edit 409 against a value the server already moved past, which
 *     presents as a backend bug and is not one.
 *   - holidays INVALIDATING rather than patching (the H-01 cascade). A patch here
 *     leaves every other staff column showing a working day that is now a holiday.
 */
let client: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

const CELL = {
  id: 'cell-1',
  clientId: 'client-1',
  date: '2026-07-21',
  period: '2026-07',
  status: 'Posted',
  note: null,
  source: 'pipeline_trigger',
  version: 7,
};

/** Seed the calendar cache the way a loaded grid would look. */
function seedCalendar(overrides: Partial<typeof CELL> = {}) {
  client.setQueryData(['content-calendar', '2026-07'], {
    cells: [{ ...CELL, status: 'Draft', version: 6, source: null, ...overrides }],
    clients: [{ id: 'client-1', name: 'Naaz Furniture' }],
  });
}

const run = (event: string, payload: RealtimePayload) => {
  const action = SYNC_MATRIX[event];
  if (!action) throw new Error(`${event} is not in the matrix`);
  if (action.kind === 'patch') action.apply(client, payload);
  else for (const key of action.keys(payload)) void client.invalidateQueries({ queryKey: key });
  return action;
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = vi.spyOn(client, 'invalidateQueries');
});

describe('the matrix classifies every wired event', () => {
  test.each([
    ['content-calendar:updated', 'patch'],
    ['client:name_updated', 'patch'],
    ['attendance:holiday_added', 'invalidate'],
    ['attendance:holiday_removed', 'invalidate'],
    ['task:created', 'invalidate'],
    ['task:updated', 'invalidate'],
    ['task:assigned', 'invalidate'],
    ['shoot:slot_updated', 'invalidate'],
    ['content-dropper:updated', 'invalidate'],
  ] as const)('%s → %s', (event, kind) => {
    expect(SYNC_MATRIX[event]?.kind, event).toBe(kind);
  });

  test('an event NOT in the matrix is not wired — silence, not a guess', () => {
    expect(SYNC_MATRIX['something:invented']).toBeUndefined();
  });
});

describe('PATCH — content-calendar:updated', () => {
  test('replaces the addressed cell in place', () => {
    seedCalendar();
    run('content-calendar:updated', CELL);

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    expect(data.cells[0]!.status).toBe('Posted');
    expect(data.cells[0]!.source).toBe('pipeline_trigger');
  });

  test('⭐ writes the new VERSION into the cache (ADR-022 rule a)', () => {
    seedCalendar({ version: 6 });
    run('content-calendar:updated', CELL);

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    // Leaving 6 here makes the receiver's next edit 409 against a version the server
    // already moved past — a backend-looking bug with a frontend cause.
    expect(data.cells[0]!.version).toBe(7);
  });

  test('never refetches — a patch is the whole point', () => {
    seedCalendar();
    run('content-calendar:updated', CELL);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test('a cell not in this cache is left alone rather than invented', () => {
    seedCalendar();
    run('content-calendar:updated', { ...CELL, id: 'cell-other' });

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    expect(data.cells).toHaveLength(1);
    expect(data.cells[0]!.id).toBe('cell-1');
  });

  test('an unseeded period is a no-op, not a crash', () => {
    expect(() => run('content-calendar:updated', CELL)).not.toThrow();
  });
});

describe('PATCH — client:name_updated', () => {
  test('renames the client in every cached list holding it', () => {
    seedCalendar();
    run('client:name_updated', { clientId: 'client-1', name: 'Naaz Interiors' });

    const data = client.getQueryData(['content-calendar', '2026-07']) as {
      clients: { id: string; name: string }[];
    };
    expect(data.clients[0]!.name).toBe('Naaz Interiors');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('INVALIDATE — the rows a payload cannot express', () => {
  test('⭐ holidays invalidate attendance (the H-01 cascade)', () => {
    run('attendance:holiday_added', { period: '2026-07' });
    // One holiday flips EVERY staff column for that date and reverts their logs.
    // Patching would leave the other columns showing a working day.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['attendance', '2026-07'] });
  });

  test('holiday_removed invalidates too — the revert is the same cascade', () => {
    run('attendance:holiday_removed', { period: '2026-07' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['attendance', '2026-07'] });
  });

  test.each(['task:created', 'task:updated', 'task:assigned'])(
    '%s invalidates tasks — ordering, membership, fan-out',
    (event) => {
      run(event, { period: '2026-07' });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', '2026-07'] });
    },
  );

  test('⭐ shoot:slot_updated invalidates the DROPPER as well as the planner', () => {
    run('shoot:slot_updated', { period: '2026-07' });

    // Trigger 1 recomputes coming_shoot_date on the pipeline (ADR-012), so the
    // dropper is stale in a way the slot's own fields never describe. Invalidating
    // only the planner is the subtle half-fix this asserts against.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shoot-planner', '2026-07'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['content-dropper', '2026-07'] });
  });

  test('content-dropper:updated invalidates — ADR-013 derived status', () => {
    run('content-dropper:updated', { period: '2026-07' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['content-dropper', '2026-07'] });
  });

  test('invalidateQueries is called in the v5 OBJECT form', () => {
    run('task:created', { period: '2026-07' });
    // v5 removed the positional-array signature; passing one silently invalidates
    // nothing.
    const [arg] = invalidateSpy.mock.calls[0]!;
    expect(arg).toEqual({ queryKey: ['tasks', '2026-07'] });
  });
});

describe('⭐ sender exclusion — ADR-022 rule b', () => {
  const EVENTS = ['content-calendar:updated', 'task:created'] as const;
  const ME = 'staff-me';

  const mount = (staffId?: string) => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    return renderHook(() => useRealtimeSync(EVENTS, staffId), { wrapper });
  };

  beforeEach(() => handlers.clear());

  test("an event this user caused is IGNORED — they already applied it", () => {
    seedCalendar({ version: 6 });
    mount(ME);

    handlers.get('content-calendar:updated')?.({ ...CELL, actorStaffId: ME });

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    // Re-applying the actor's own echo double-applies the optimistic update they
    // already made, or fights the mutation still in flight — a failure almost
    // impossible to diagnose from a bug report.
    expect(data.cells[0]!.version).toBe(6);
  });

  test('an event from SOMEONE ELSE is applied', () => {
    seedCalendar({ version: 6 });
    mount(ME);

    handlers.get('content-calendar:updated')?.({ ...CELL, actorStaffId: 'someone-else' });

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    expect(data.cells[0]!.version).toBe(7);
  });

  test('exclusion applies to invalidate rows too, not just patches', () => {
    mount(ME);
    handlers.get('task:created')?.({ period: '2026-07', actorStaffId: ME });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test('with no current staffId known, events still apply', () => {
    seedCalendar({ version: 6 });
    mount(undefined);

    // The server-side socket.broadcast half still excludes socket-originated echoes,
    // so degrading to "apply everything" is correct rather than silently deaf.
    handlers.get('content-calendar:updated')?.({ ...CELL, actorStaffId: ME });

    const data = client.getQueryData(['content-calendar', '2026-07']) as { cells: typeof CELL[] };
    expect(data.cells[0]!.version).toBe(7);
  });

  test('only the named events are subscribed', () => {
    mount(ME);
    expect([...handlers.keys()].sort()).toEqual(['content-calendar:updated', 'task:created']);
  });
});
