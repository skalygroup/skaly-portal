import {
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TYPES,
  DEFERRED_NOTIFICATION_TYPES,
  isNotificationType,
} from '@skaly/shared';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe, test, expect, afterAll } from 'vitest';

import type { DB, NotificationType } from '@skaly/shared';

/**
 * ADR-020 — the registry mirrors the enum, and the deferred list is asserted.
 *
 * The set-equality test below is the drift guard, and it is the whole point of this
 * file: it must fail if someone adds an enum value without a registry entry AND if
 * someone adds a registry entry without an enum value. A one-directional check is the
 * usual mistake and catches only half the drift.
 *
 * The enum is read FROM POSTGRES, not from a second hardcoded list here — a constant
 * copied into the test proves only that two hand-written lists agree with each other.
 */
const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://skaly:localdev@localhost:5432/skaly_dev';
const pool = new pg.Pool({ connectionString });
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

afterAll(async () => {
  await db.destroy();
});

/** The live `notifications_type_check` values, parsed from the constraint itself. */
async function enumValuesFromSchema(): Promise<string[]> {
  const row = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = 'notifications_type_check'
  `.execute(db);

  const def = row.rows[0]?.def;
  if (!def) throw new Error('notifications_type_check not found — has migration 021 run?');

  // CHECK (type::text = ANY (ARRAY['month_ready'::character varying, ...]))
  return [...def.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1]!).sort();
}

describe('the registry mirrors the enum (the drift guard)', () => {
  test('⭐ registry keys === enum values, as SETS, in BOTH directions', async () => {
    const fromSchema = await enumValuesFromSchema();
    const fromRegistry = [...NOTIFICATION_TYPES].sort();

    // Both directions, named separately so a failure says WHICH way it drifted.
    const missingFromRegistry = fromSchema.filter((t) => !fromRegistry.includes(t as NotificationType));
    const missingFromEnum = fromRegistry.filter((t) => !fromSchema.includes(t));

    expect(missingFromRegistry, 'enum values with no registry entry').toEqual([]);
    expect(missingFromEnum, 'registry entries with no enum value').toEqual([]);
    expect(fromRegistry).toEqual(fromSchema);
  });

  test('the canonical count is 18 — the schema wins over the PRD/Impl-Plan 14', async () => {
    const fromSchema = await enumValuesFromSchema();
    expect(fromSchema).toHaveLength(18);
    expect(NOTIFICATION_TYPES).toHaveLength(18);
  });

  test('the four system-generated types are what the stale 14 omitted (18 − 4)', () => {
    // Recorded so the discrepancy stays explained rather than re-litigated. An
    // explained discrepancy stays fixed; a declared winner reseeds.
    const systemGenerated = [
      'month_ready',
      'rollover_success',
      'rollover_failed',
      'rollover_view_refresh_failed',
    ];
    for (const t of systemGenerated) expect(isNotificationType(t)).toBe(true);
    expect(NOTIFICATION_TYPES.length - systemGenerated.length).toBe(14);
  });

  test('no enum value exists for ordinary chat messages', async () => {
    const fromSchema = await enumValuesFromSchema();
    // Chat delivers over the socket; only @mentions create a row (ADR-020 §5).
    // Adding a value here would be a migration AND scope drift.
    for (const forbidden of ['chat_message', 'new_message', 'message_received', 'chat']) {
      expect(fromSchema).not.toContain(forbidden);
    }
    expect(fromSchema).toContain('mention');
  });
});

describe('every registry entry is complete', () => {
  test('each has a title, template, icon, severity and producerSprint', () => {
    for (const type of NOTIFICATION_TYPES) {
      const spec = NOTIFICATION_REGISTRY[type];
      expect(spec.title, `${type}.title`).toBeTruthy();
      expect(spec.template, `${type}.template`).toBeTruthy();
      expect(spec.icon, `${type}.icon`).toBeTruthy();
      expect(['info', 'success', 'warning', 'critical']).toContain(spec.severity);
      expect(Number.isInteger(spec.producerSprint), `${type}.producerSprint`).toBe(true);
    }
  });

  test('each linkBuilder is callable and tolerates an empty payload', () => {
    for (const type of NOTIFICATION_TYPES) {
      const spec = NOTIFICATION_REGISTRY[type];
      expect(typeof spec.linkBuilder).toBe('function');
      // A producer that omits the addressing key must yield null, never "/undefined".
      const link = spec.linkBuilder({});
      expect(link === null || typeof link === 'string').toBe(true);
      if (typeof link === 'string') expect(link).not.toContain('undefined');
    }
  });

  test('a linkBuilder given its payload produces the deep link', () => {
    expect(NOTIFICATION_REGISTRY.task_assigned.linkBuilder({ taskId: 't1', period: '2026-07' })).toBe(
      '/tasks?period=2026-07&highlight=t1',
    );
    expect(NOTIFICATION_REGISTRY.mention.linkBuilder({ messageId: 'm1' })).toBe('/chat?highlight=m1');
    expect(NOTIFICATION_REGISTRY.signup_request.linkBuilder({})).toBe('/settings/signup-requests');
  });
});

describe('the deferred six are asserted by name, not merely commented', () => {
  test('⭐ exactly 5 types have no producer as of Sprint 11', () => {
    // Bumping SHIPPED_THROUGH_SPRINT makes this FAIL until every producer that
    // sprint owes exists in src. That failure is the intended workflow — it is how
    // the deferral stays honest.
    //
    // Sprint 10 left SEVEN, not the six its plan predicted: account_reactivated was
    // counted as a shipped-sprint gap like holiday_added and client_updated, but
    // unlike those it had no write path to hook into — StaffService was read-only
    // and there was no staff deactivate OR reactivate anywhere. Sprint 11 built
    // both (ADR-026 reinstate, ADR-027 reports), so seven becomes five.
    expect(DEFERRED_NOTIFICATION_TYPES).toHaveLength(5);
    expect(DEFERRED_NOTIFICATION_TYPES).toEqual(
      [
        'month_ready',
        'new_comment',
        'rollover_failed',
        'rollover_success',
        'rollover_view_refresh_failed',
      ].sort(),
    );
  });

  test('each deferred type names the sprint that owns its producer', () => {
    const owners: Record<string, number> = {
      new_comment: 12,
      month_ready: 12,
      rollover_success: 12,
      rollover_failed: 12,
      rollover_view_refresh_failed: 12,
    };
    for (const type of DEFERRED_NOTIFICATION_TYPES) {
      expect(NOTIFICATION_REGISTRY[type].producerSprint, type).toBe(owners[type]);
    }
  });

  test('the other 13 are claimed by a sprint at or before 11', () => {
    const withProducers = NOTIFICATION_TYPES.filter(
      (t) => !DEFERRED_NOTIFICATION_TYPES.includes(t),
    );
    expect(withProducers).toHaveLength(13);
    for (const t of withProducers) {
      expect(NOTIFICATION_REGISTRY[t].producerSprint, t).toBeLessThanOrEqual(11);
    }
  });
});
