# ADR-036 — Rollover notifications: templated-first, AI-enriched, actionable

**Status:** Accepted • Pre-Sprint 13 — **closes ADR-020's deferred list to zero**
**Cross-refs:** ADR-020 (the 18-type registry) · `09-ERROR-HANDLING.md` §7 (the failure
summary + the `[Manual rollover]` button) · `11-THIRD-PARTY-INTEGRATIONS.md` §3 (the SDK
built-in retry, Sprint 8 amendment) · ADR-022 (`notify:new` self-heal) · `02-TRD.md` §8
(typed delivery) · ADR-035 · ADR-037

> **Naming note.** The sprint guide cross-refs "ADR-017" for the 18-type registry. In this
> repo that ruling is **ADR-020** (`ADR-020-notification-type-count.md`); ADR-017 is client
> onboarding atomicity. The registry ADR is ADR-020 throughout — same drift as the Sprint 11
> ADR renumbering, and `docs/decisions/` wins.

## Context

The four rollover types are the last of ADR-020's deferred set. As of Sprint 12,
`DEFERRED_NOTIFICATION_TYPES` is exactly `[month_ready, rollover_failed, rollover_success,
rollover_view_refresh_failed]` and `NotificationCensus.test.ts` asserts both that the list has
length 4 and that those four emit **nothing** in `src`. Sprint 13 flips both assertions.

The failure summary calls Anthropic from inside a cron with no user waiting on it — which is
the entire hazard. A notification that depends on that call is a notification that can be
swallowed by an unrelated third-party outage, at 00:01, about the most important failure in
the product.

## Decision

### 1. Four types, delivered as `notify:new` **types**

| Type | Audience | Trigger |
|---|---|---|
| `month_ready` | all staff | Tier 1 commit |
| `rollover_success` | admins | Tier 1 commit |
| `rollover_failed` | admins | Tier 1 failure |
| `rollover_view_refresh_failed` | admins | Tier 2 failure |

They are **types over the existing `notify:new` event** — not bespoke `rollover:*` socket
events. The payload arrives under `payload`. This is the invariant caught twice already
(`report_ready` in Sprint 11, live comments in Sprint 12) and pinned on `useNotifySocket`; a
consumer test fires the **server emit**, never the handler's assumed shape.

`linkBuilder` returns an in-app route (`/settings/months` for the three rollover types,
`/dashboard?period=` for `month_ready`) — already present in the registry, unchanged.

After this, all 18 enum types have producers and the census test's deferred list is **zero**.

### 2. ⭐ The failure notification is unconditional and written FIRST

Both failure types write their notification row **immediately**, with a templated body:

```
Rollover for {period} failed at step {failedStep}. The previous month is intact —
data was not affected. A detailed summary is being generated.
```

Only then is enrichment attempted. The Claude summary (Error-Handling §7 — `claude-sonnet-4-6`,
`max_tokens: 400`, calm plain-language non-technical prose, 3–5 sentences) **updates** that
row's body if it succeeds.

**The notification never waits on and never depends on the summary.** A cron whose failure
notification also fails to generate is the worst case in the product: the rollover is broken
*and* silent, and the business owner finds out from missing data rather than from a bell.

### 3. SDK retry, not a hand loop

The enrichment call uses the shared client from `lib/anthropic.ts` (`maxRetries: 3`, respects
`Retry-After`) — the Sprint 8 amendment, already the codebase's only Anthropic client. There
is **no retry inside the cron's retry**: the cron retries the endpoint 3× (Infra §4), the SDK
retries the API call 3×, and the service adds no third layer. On exhaustion the templated
body simply stays, and that is a complete, correct notification.

### 4. ⭐ Actionable

The failure notification carries an inline, idempotent **`[Manual rollover]`** action
(Error-Handling §7, red tint), admin-only, POSTing to the **same idempotent endpoint** the
cron uses (ADR-037 §3) — not a force path. A failure summary with no recovery action is a
dead-end: it tells an admin something broke and leaves them with nothing to click.

### 5. `failedStep` is threaded, not read back

A Tier 1 failure rolls the `months` row back with everything else, so there is no row to read
the failed step from. The step is carried out of the caught error on the service→notification
path as a field. (`months.rollover_failed_step` exists for the *post-commit* failure case,
where a row does exist — ADR-037 §2.)

## Rule

> The notification is the invariant; the summary is enrichment.
> Write the row, then enrich it — never the reverse.
