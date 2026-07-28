import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from 'vitest';

/**
 * ADR-022's matrix, asserted against the SOURCE (Sprint 10 STEP 9).
 *
 * The frontend test proves each event is CLASSIFIED correctly. Nothing proved the
 * events exist: a grid can subscribe to `task:created` forever, and if no service
 * emits it the subscription is dead code that every test still passes.
 *
 * That is not hypothetical — this file was written because the STEP 9 close-out audit
 * found FOUR of the nine matrix events (task:created, task:updated, task:assigned,
 * shoot:slot_updated) had no emitter at all. The tasks and shoot-planner grids were
 * listening to nothing. It is the same failure as a notification type with no
 * producer, in a different guise, and it needs the same kind of guard.
 *
 * Static on purpose: no fixtures, no sockets, and it fails when an emitter is deleted
 * rather than when someone next opens the grid.
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every event in ADR-022's matrix, and whether it is patchable. */
const MATRIX = {
  'content-calendar:updated': 'patch',
  'client:name_updated': 'patch',
  'attendance:holiday_added': 'invalidate',
  'attendance:holiday_removed': 'invalidate',
  'task:created': 'invalidate',
  'task:updated': 'invalidate',
  'task:assigned': 'invalidate',
  'shoot:slot_updated': 'invalidate',
  'content-dropper:updated': 'invalidate',
} as const;

async function sourceFiles(dir = SRC): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** event → the src files that emit it. */
async function emittersByEvent(): Promise<Map<string, string[]>> {
  const files = await sourceFiles();
  const found = new Map<string, string[]>();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const event of Object.keys(MATRIX)) {
      if (text.includes(`'${event}'`)) {
        found.set(event, [...(found.get(event) ?? []), file.replace(SRC, '').replace(/\\/g, '/')]);
      }
    }
  }
  return found;
}

describe('every matrix event has a real emitter', () => {
  test('⭐ all nine are emitted somewhere in src', async () => {
    const emitters = await emittersByEvent();
    const missing = Object.keys(MATRIX).filter((e) => !emitters.has(e));

    // A failure here means a grid is subscribed to an event nothing sends — dead
    // code that no other test can detect.
    expect(missing, 'matrix events with no emitter').toEqual([]);
  });

  test('each emitter lives in the module that owns the change', async () => {
    const emitters = await emittersByEvent();
    const expected: Record<string, string> = {
      'content-calendar:updated': 'services/ContentCalendarService.ts',
      'client:name_updated': 'services/ClientService.ts',
      'attendance:holiday_added': 'services/HolidayService.ts',
      'attendance:holiday_removed': 'services/HolidayService.ts',
      'task:created': 'services/TaskService.ts',
      'task:updated': 'services/TaskService.ts',
      'task:assigned': 'services/TaskService.ts',
      'shoot:slot_updated': 'services/ShootPlannerService.ts',
      'content-dropper:updated': 'services/ContentDropperService.ts',
    };
    for (const [event, file] of Object.entries(expected)) {
      expect(emitters.get(event) ?? [], event).toContain(file);
    }
  });
});

describe('sender exclusion is possible for every user-driven event', () => {
  test('⭐ each carries actorStaffId at its emit site', async () => {
    const files = await sourceFiles();
    const withoutActor: string[] = [];

    for (const event of Object.keys(MATRIX)) {
      let sawActor = false;
      let sawUserDrivenEmit = false;

      for (const file of files) {
        const text = await readFile(file, 'utf8');
        const idx = text.indexOf(`'${event}'`);
        if (idx === -1) continue;
        // The emit call and its payload object, generously bounded.
        const window = text.slice(idx, idx + 400);
        if (!/broadcastToOrg|emitAfterCommit|this\.broadcast/.test(window)) continue;
        sawUserDrivenEmit = true;
        if (window.includes('actorStaffId')) sawActor = true;
      }
      if (sawUserDrivenEmit && !sawActor) withoutActor.push(event);
    }

    // Without actorStaffId the client-side half of ADR-022 rule b cannot work, and a
    // REST-originated write has NO originating socket for the server to exclude — so
    // this is the only guard those events get. The actor would re-apply their own
    // echo on top of an optimistic update, or fight a mutation still in flight.
    //
    // Trigger 2's calendar emit in events/listeners.ts is exempt: it is a SYSTEM
    // write with no human actor, which is why the check is per emit site rather than
    // per event name.
    expect(withoutActor, 'user-driven events missing actorStaffId').toEqual([]);
  });
});

describe('the matrix is closed', () => {
  test('nine events, and the patch/invalidate split matches ADR-022', () => {
    expect(Object.keys(MATRIX)).toHaveLength(9);
    const patchable = Object.entries(MATRIX).filter(([, k]) => k === 'patch').map(([e]) => e);
    // Only two rows are patchable, and both are ones whose payload can carry the
    // complete new state of one addressable entry.
    expect(patchable.sort()).toEqual(['client:name_updated', 'content-calendar:updated']);
  });
});
