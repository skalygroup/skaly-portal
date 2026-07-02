# ADR-003: audit_log write path

**Date:** 2026-07-03
**Status:** Accepted
**Sprint:** 3 pre-flight (decision #1)

## Context

Every Sprint 3 write (attendance edits, holiday create/remove) audits through
`AuditService.log`. Before building those services we had to confirm which
write path Sprint 0 actually locked in for `audit_log`, so `AuditService.log`
matches it and no Sprint 3 service triggers a `permission denied for table
audit_log`.

Two possible styles:

- **Style A** — the app role holds `INSERT` on `audit_log`; `AuditService.log`
  writes via a direct Kysely `insertInto('audit_log')`.
- **Style B** — the app role has `INSERT` **revoked**; the only way in is a
  `SECURITY DEFINER` function; `AuditService.log` calls that function.

Confirmed against the live DB (migration `027_audit_log_security_definer`):

```
skaly_app grants on audit_log        → SELECT only   (INSERT revoked)
SECURITY DEFINER function            → audit_log_insert(...)  prosecdef = t
```

Migration 026 made the table append-only (`REVOKE UPDATE, DELETE`); migration
027 revoked the blanket `INSERT` and routed all writes through
`audit_log_insert()`, owned by the superuser with a pinned
`search_path = pg_catalog, public` (schema-hijack hardening).

## Decision

Sprint 0 implemented **Style B**. `AuditService.log` writes via the
`SECURITY DEFINER` function — never `insertInto('audit_log')`, never UPDATE or
DELETE:

```
audit_log_insert(
  p_staff_id          UUID,
  p_table_name        VARCHAR(50),
  p_action            VARCHAR(15),
  p_record_id         UUID  DEFAULT NULL,
  p_old_value         JSONB DEFAULT NULL,
  p_new_value         JSONB DEFAULT NULL,
  p_changed_by_source VARCHAR(10) DEFAULT 'user',
  p_ip_address        INET  DEFAULT NULL
) RETURNS UUID
```

`apps/api/src/services/AuditService.ts` already calls it positionally in this
exact argument order — verified, no change required.

**Rule:** `audit_log` is written ONLY through `AuditService.log`. No direct
writes anywhere else in the codebase.

## Rationale

Both styles satisfy B-01 (history cannot be edited or deleted). Style B is
strictly stronger: the app role *cannot* write arbitrary audit rows even if a
future code path tried to. Rewriting the lockdown migration on a deployed,
tamper-proof system would be churn with no security gain. Keep what Sprint 0
built.

## Consequences

- Every Sprint 3+ service that mutates data calls `AuditService.log` (Style B);
  a stray `insertInto('audit_log')` would fail at runtime with `permission
  denied` — this is the intended guard, not a bug.
- `AuditService.log` fails fast on a non-enum `action` before the DB CHECK, and
  never nulls `staff_id` (falls back to `SYSTEM_ACTOR_UUID` + source `system`,
  audit C-04).
- If the function signature ever changes, `AuditService.log` and this ADR must
  change together — the positional call is coupled to the declared arg order.
