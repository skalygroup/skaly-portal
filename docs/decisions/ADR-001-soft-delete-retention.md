# ADR-001: Soft-deleted staff row retention

**Date:** 2026-06-25
**Status:** Accepted
**Sprint:** 1 close-out

## Context

Sprint 1 introduced soft delete via `staff.deleted_at`. Audit-trail integrity
(H-04 duplicate prevention, audit log completeness, historical attendance
queries) requires soft-deleted rows to remain queryable.

## Decision

Soft-deleted staff rows are retained indefinitely. No time-based hard-delete
job is scheduled for MVP or Phase 2. A retention review may be initiated in
Phase 3 if regulatory or storage pressure requires it. Until then,
`deleted_at IS NOT NULL` rows are permanent.

## Consequences

- H-04 duplicate prevention continues to work for previously-onboarded emails.
- Audit log entries referencing deleted staff resolve to a real row.
- Historical attendance/task/comment records maintain referential integrity.
- Growth in `staff` table is bounded by lifetime onboarded staff count — small.
- If GDPR-style right-to-deletion becomes a requirement, revisit — hard-delete
  path needs a data-migration + audit-log actor-rewrite plan first.
