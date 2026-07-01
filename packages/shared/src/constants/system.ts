/**
 * The fixed System Actor staff row, seeded by database/seeds/001_system_actor.ts.
 *
 * Every automated / system-originated write that must be audited attributes
 * itself to this staff id (audit C-04) — e.g. cron rollovers, view refreshes,
 * and any AuditService.log() call made with changed_by_source = 'system'.
 *
 * Defined once here and imported everywhere. The zero-UUID must never appear as
 * an inline string literal elsewhere in the codebase.
 */
export const SYSTEM_ACTOR_UUID = '00000000-0000-0000-0000-000000000000' as const;
