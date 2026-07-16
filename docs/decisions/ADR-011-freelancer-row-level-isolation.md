# ADR-011 — Freelancer row-level isolation is query-level

**Status:** Accepted • Pre-Sprint 5 (build impact: Sprint 5 shoot planner; pattern for every future freelancer-visible module)
**Cross-refs:** Audit M-07 · `08-AUTH-MATRIX.md` §4 + §8 · `12-TESTING-STRATEGY.md` §5.3 · Sprint 5 reconciliation #9

## Context
Sprint 5's shoot planner is the first module a freelancer can see. A freelancer
must see **only slots assigned to them** — never other freelancers' slots and
never unassigned slots. There are two ways to enforce that: filter rows after
fetching them, or scope the query itself. Post-fetch filtering has already been
flagged (audit M-07) as a data-leak footgun: one forgotten filter in one code
path exposes every client's shoot schedule.

## Decision
1. **Isolation is a query predicate, applied before execution.** When
   `currentUser.role === 'freelancer'`, the service adds
   `.where('freelancer_id', '=', currentUser.staffId)` to the base query in
   `getGrid` / `getSlot`. Never fetch-then-filter.
2. **Unassigned slots (`freelancer_id IS NULL`) are invisible to freelancers.**
   The predicate is equality, not `= self OR IS NULL`.
3. **A freelancer requesting a non-owned slot by id gets `404`**, not 403 —
   the row's existence is not revealed.
4. **Freelancer is read-only on shoot-planner.** PATCH/reset are blocked at the
   route (`requireRole('admin','manager')` → 403); the service asserts
   defensively as a third layer.
5. **Tested (M-07 headline test):** own slot visible; other freelancer's slot
   and unassigned slot absent from GET; non-owned by id → 404; PATCH/reset → 403.

## Rule
Any future module a freelancer can read (calendar, pipelines, …) reuses this
pattern: role check → equality predicate on the base query → 404 on non-owned
by-id access. Route-level role gates are layer 2; the query predicate is the
layer that actually protects data.

## Rationale
A query predicate cannot be forgotten per-row and never pages data it must not
return. Post-fetch filtering fails silently the day someone adds a new query
path; 404-on-non-owned prevents enumeration of slot ids.
