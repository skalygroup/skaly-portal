# ADR-026 — Soft-deleted identity entities are re-onboardable

**Status:** Accepted • Pre-Sprint 11 (fixes `SPRINT-10-AUDIT.md` A4)
**Cross-refs:** `05-BACKEND-SCHEMA.md` (`staff`, `clients`, migration `030_holidays_active_unique`) ·
`08-AUTH-MATRIX.md` §4 · `13-NFRS.md` §3.1 · ADR-014 · ADR-017 · ADR-020

> **Numbering note.** The Sprint 11 guide calls this ADR-023. That number is taken by
> `ADR-023-presence-hash` (Sprint 10). The guide's numbering runs three behind this
> repo's from ADR-020 onward — see ADR-020's note for the full mapping. Sprint 11's five
> ADRs are **026–030**. Inside this document, the guide's ADR-014/017 references resolve
> to **ADR-014** (bot mutation confirmation, unchanged) and **ADR-020** (notification
> type count).

## Context

`ClientService.deactivate` is one-way. There is no `reactivate` anywhere — a client
deactivated by mistake, or a client who returns, cannot come back.

Separately, and worse (audit **A4**): `staff_email_unique` is a plain `UNIQUE (email)`
with no partial predicate, so a soft-deleted staffer's email still occupies the
constraint for all time. `AuthService.approveSignupRequest` pre-checks for a staff row
by email **with no `deleted_at` filter** (`AuthService.ts` step b, the "H-04 backstop"),
finds the dead row, and marks the request:

```
status: 'rejected',
rejection_note: 'Account already exists at approval time'
```

It does not crash — that was verified in the audit, and it matters, because the failure
mode is not a stack trace anyone would chase. **The account does not exist. It was
deleted.** The sentence is untrue, the outcome is wrong, and the person is now
unhireable through the product: every subsequent application hits the same dead row.

Two defects sit here, and fixing only one is a trap. The index alone lets a *new* row be
created but leaves the false rejection in place and loses the person's history. The
approval fix alone cannot write the row.

## Decision — one principle, two levels

1. **A unique constraint on a soft-deletable identity column MUST be partial**
   (`WHERE deleted_at IS NULL`). Migration `030` already established this for `holidays`,
   for the identical reason: *removing something has to actually free the slot it
   occupied.* `staff` is the remaining case. Verified across all 30 migrations: no other
   table pairs soft-delete with a non-partial unique index.

2. **CLIENTS — `reactivate(id)`:** clear `deleted_at`, set `active = true`, and run the
   **same** current-period three-way backfill `create` runs — shoot slots, pipeline row,
   calendar cells. `create` already delegates to `backfillClientPeriodRows`, so this is a
   call, not a copy. Internal clients get no period rows, exactly as on create (ADR-017).
   Audited. No migration: `clients` has soft-delete but no colliding unique constraint.

3. **STAFF — reinstate the ORIGINAL row**, never a duplicate. The history and the audit
   trail are the whole reason the row was soft-deleted rather than hard-deleted.
   `PUT /v1/staff/:id/reactivate` is **already specified in AUTH-MATRIX §4** — it was
   never built, not never designed. Do not invent an endpoint.

4. **APPROVAL DETECTS, IT DOES NOT REJECT.** When approval finds a soft-deleted staff row
   for that email it surfaces *"previously employed — reinstate?"* to the admin and
   **leaves the signup request `pending`**. A pending request an admin can act on beats a
   rejected one carrying a false reason.

5. **Reinstatement checks for a LIVE row with that email first.** Once the index is
   partial, a dead row and a live row can legitimately share an email. Reinstating into
   that collision must return a clear `409`, not a Postgres unique violation surfacing as
   a 500.

6. **Bot parity:** add `reactivate_client` through the ADR-014 confirmation machine,
   mirroring `deactivate_client`. A bot that can destroy but not undo is its own footgun.

7. **No new notification enum value for client reactivation.** Admins act and see the
   result immediately. The enum stays at 18 (ADR-020). `account_reactivated` already
   exists for exactly the staff case.

## On NFR §3.1 — non-additive, but non-breaking

§3.1 says "additive changes only in MVP". Dropping `staff_email_unique` and recreating it
as a partial index **relaxes** a constraint: every row that satisfied the old constraint
satisfies the new one, because the new predicate is a strict subset of the old rows. No
existing data can violate it, no write that succeeded before can fail now, and no
maintenance window is required. §3.1 is about breaking changes; this is the opposite of
one. Recorded here and in the migration comment so nobody blocks on §3.1 later — or,
worse, "hardens" the weaker constraint back.

## Rule

> Soft delete means recoverable. If a delete is soft, some path must undo it — and the
> error message on the way there must be true.
