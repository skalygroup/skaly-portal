# Post-Launch Backlog

Items deliberately deferred out of the MVP, each with the **trigger condition** that makes it
real work. A deferral without a trigger is just a thing that got forgotten with extra steps.

---

## 2-year audit-log archival to R2 cold storage

**Spec:** NFR §5.2. **Trigger:** table growth, or the 2-year mark — whichever comes first.

`audit_log` is roughly 50k rows at 12 months of full-team use, which is nowhere near a
Postgres problem. The retention policy says 2 years hot, then cold storage; year one has no
work in it. Revisit when the table crosses ~1M rows or in 2028, and archive by
`created_at` month to `audit/{yyyy-mm}/` in R2.

## Id-based mention resolution

**Where:** `ChatService.resolveMentions` and the comment mention path.
**Trigger:** two **active** staff genuinely share a display name in production.

Current behaviour is notify-all-matches: a `@Name` that resolves to two active staff notifies
both. That is recorded, correct, and was fixed in Sprint 12 (`bb22b8e`) — the accumulator
used to overwrite, so one of the two was silently dropped.

The residual-free version carries the composer's *selected* `staffId` through the send payload
instead of re-deriving the person by name on the server, plus a role/email distinguisher
beside duplicate names in the mention dropdown. It is only load-bearing if a duplicate active
display name actually exists; Skaly's real names are distinct, so notify-all resolves to
exactly one person on production data today. The ceiling is named in a `ponytail:` comment at
the resolution Map.

## Socket.io Redis adapter (`@socket.io/redis-adapter`)

**Spec:** Infra §10 tripwire. **Trigger:** a **second** API instance. Not a date, not a user
count — the instance count.

Single-instance at 50 users (the full team, NFR §2.1) needs it not at all: every socket is on
the one process, so `io.to(room).emit()` already reaches everyone. The moment a second
instance exists, room broadcasts silently reach only the half of the users connected to the
emitting instance — which looks like flaky real-time, not like a missing adapter. Decided at
launch (STEP 11.3) as single-instance; this entry is the tripwire.

## Phase 2 mobile

**Trigger:** a Phase 2 decision. Out of MVP scope entirely.

Expo app, FCM/APNs push (replacing the in-app bell for off-hours), offline read-only cache of
the current period.

## Monthly backup restore drill

**Spec:** Infra §7. **Trigger:** recurring — the first of each month.

STEP 11.1's drill was run once as a launch gate. It becomes a **monthly** exercise, because a
backup pipeline that worked in August is not evidence that it works in November — schema
drift, a rotated R2 credential, or a silently failing cron all present identically (a backup
file that exists and does not restore). The drill is: pull the latest real backup, restore to
a throwaway Postgres, compare row counts on the key tables, refresh a materialised view,
destroy the instance.
