import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTIFICATION_REGISTRY, NOTIFICATION_TYPES, SPRINT_10_DEFERRED_TYPES } from '@skaly/shared';
import { describe, test, expect } from 'vitest';

import type { NotificationType } from '@skaly/shared';

/**
 * ADR-020's producer census, asserted against the SOURCE (Sprint 10 STEP 8).
 *
 * The registry test (NotificationRegistry.test.ts) proves the registry and the enum
 * agree, and that the deferred list is the right length. Neither of those notices if
 * someone deletes a producer: the type stays in the enum, the registry entry stays
 * valid, the counts still match, and the notification simply stops firing. That gap
 * is exactly how five of these types sat producer-less across four shipped sprints
 * until Sprint 10's STEP 1.3 grep found them.
 *
 * So this reads apps/api/src and asserts the emitter is really there. It is a static
 * check on purpose — it needs no fixtures, cannot be satisfied by a test double, and
 * fails the moment a producer is removed rather than when someone next looks.
 */
// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." which
// resolves to "C:\C:\..." and scandir fails.
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every .ts file under src, recursively. */
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

/** type → the src files that emit it, found by the `type: 'x'` producer shape. */
async function producersByType(): Promise<Map<NotificationType, string[]>> {
  const files = await sourceFiles();
  const found = new Map<NotificationType, string[]>();

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const type of NOTIFICATION_TYPES) {
      // The call shape every producer uses: `type: 'holiday_added',` inside a
      // NotificationService.create / createForStaff argument object.
      if (new RegExp(`type:\\s*'${type}'`).test(text)) {
        found.set(type, [...(found.get(type) ?? []), file.replace(SRC, '')]);
      }
    }
  }
  return found;
}

/** The 11 with a producer as of Sprint 10 — the complement of the deferred list. */
const WITH_PRODUCERS = NOTIFICATION_TYPES.filter((t) => !SPRINT_10_DEFERRED_TYPES.includes(t));

describe('every type the census claims has a producer, has one in src', () => {
  test('⭐ all 11 resolve to a real emitter', async () => {
    const producers = await producersByType();
    const missing = WITH_PRODUCERS.filter((t) => !producers.has(t));

    // A failure here means a producer was deleted or renamed. The type stays valid
    // everywhere else, so nothing else in the suite would notice.
    expect(missing, 'types claiming a producer that src does not emit').toEqual([]);
    expect(WITH_PRODUCERS).toHaveLength(11);
  });

  test('each producer lives where the census says it does', async () => {
    const producers = await producersByType();
    // The owning module for each — recorded so a producer moving is a deliberate edit
    // to this table, not a silent relocation.
    const expected: Record<string, string> = {
      task_assigned: 'services/TaskService.ts',
      task_overdue: 'services/TaskService.ts',
      dependency_resolved: 'services/TaskService.ts',
      shoot_confirmed: 'services/ShootPlannerService.ts',
      holiday_added: 'services/HolidayService.ts',
      holiday_removed: 'services/HolidayService.ts',
      signup_request: 'services/AuthService.ts',
      signup_approved: 'services/AuthService.ts',
      signup_rejected: 'services/AuthService.ts',
      client_updated: 'services/ClientService.ts',
      mention: 'services/ChatService.ts',
    };

    for (const type of WITH_PRODUCERS) {
      const files = (producers.get(type) ?? []).map((f) => f.replace(/\\/g, '/'));
      expect(files, type).toContain(expected[type]);
    }
  });

  test('⭐ the deferred seven emit NOTHING — no invented emitters', async () => {
    const producers = await producersByType();

    // ADR-020 decision 4: a type with no producer is named and dated, never invented.
    // If one of these acquires an emitter, it has stopped being deferred and both this
    // test and SPRINT_10_DEFERRED_TYPES must be updated deliberately.
    for (const type of SPRINT_10_DEFERRED_TYPES) {
      expect(producers.get(type) ?? [], `${type} should have no producer yet`).toEqual([]);
    }
    expect(SPRINT_10_DEFERRED_TYPES).toHaveLength(7);
  });

  test('11 + 7 accounts for the whole enum, with nothing double-counted', () => {
    expect(WITH_PRODUCERS.length + SPRINT_10_DEFERRED_TYPES.length).toBe(18);
    const overlap = WITH_PRODUCERS.filter((t) => SPRINT_10_DEFERRED_TYPES.includes(t));
    expect(overlap).toEqual([]);
  });
});

describe('the census matches what the registry claims', () => {
  test('producerSprint ≤ 10 exactly when a producer exists', async () => {
    const producers = await producersByType();

    for (const type of NOTIFICATION_TYPES) {
      const hasProducer = producers.has(type);
      const claimsProducer = NOTIFICATION_REGISTRY[type].producerSprint <= 10;
      // The registry's producerSprint is the DOCUMENTED claim; src is the truth. This
      // is the assertion that caught account_reactivated claiming Sprint 2 while
      // having no write path at all.
      expect(hasProducer, `${type}: registry says sprint ${NOTIFICATION_REGISTRY[type].producerSprint}`).toBe(
        claimsProducer,
      );
    }
  });
});
