# ADR-016 — Bot-mediated writes are attributed to the human

**Status:** Accepted • Pre-Sprint 9 (build impact: Sprint 9+)
**Cross-refs:** `05-BACKEND-SCHEMA.md` §6 (`audit_log`) · Audit C-04 · ADR-014

## Context

`audit_log.changed_by_source` has carried three values (`'user'`, `'system'`, `'bot'`) since
migration 023 — `audit_log_source_check CHECK (changed_by_source IN ('user','system','bot'))`.
`'bot'` has **never been written**: Sprint 8's tools are read-only, and every automated write
so far used `'system'` plus the System Actor UUID. Sprint 9 is its first use.

## Decision

A bot-mediated write sets `audit_log.staff_id` = **the JWT-authenticated caller** (the human
on whose behalf the bot acted) and `changed_by_source = 'bot'`.

**Never the System Actor** — that is reserved for genuinely unattended writes (rollover,
trigger recomputes).

`AuditService.log` already accepts `actorSource?: ChangedBySource` and defaults to `'user'`
whenever an `actorId` is present. That default is wrong for this path, so `'bot'` must be
threaded explicitly from the mutation tool through to the service call; omitting it audits a
bot write as a hand edit.

## Rule

The audit log must answer *"did a person do this, or did they ask the bot to?"*
That is the entire reason the enum has three values rather than two.

## Rationale

Attributing to the System Actor loses the human and makes the write unaccountable.
Attributing plainly as `'user'` loses the fact that a probabilistic system composed it —
which is exactly what an investigator needs when a bot-mediated change turns out wrong.
