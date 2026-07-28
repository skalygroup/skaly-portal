# ADR-002: Full MFA challenge-on-login wiring deferred to Sprint 8

**Date:** 2026-06-25
**Status:** Accepted
**Sprint:** 1 close-out

## Context

Sprint 1 shipped MFA enrollment (QR code, verify endpoint, `mfa_enrolled`
flag, redirect-to-/mfa-setup guard for admin/manager on first login). Not
shipped: challenge-on-every-login enforcement, recovery-code redemption path.
Two implementation options exist:

(a) Keep enrollment on the frontend `supabase.auth.mfa.enroll()` path.
    Backend only stores recovery codes and flips the flag. Backend enroll
    endpoint returns 501 as fallback.
(b) Upgrade/self-host GoTrue to expose admin MFA enroll on the backend.

## Decision

Full MFA wiring is deferred to Sprint 8, where role-gated AI Bot mutations
first require an MFA-confirmed session. Path (a) is the tentative direction.
Sprint 8 will finalise with an ADR update.

## Consequences

- Admin/manager still forced through enrollment on first login (Sprint 1 works).
- MFA challenge on subsequent logins is NOT enforced pre-Sprint 8.
- Recovery-code redemption is storage-only — no verify path.
- Sprint 8's driving prompt must include full MFA wiring as task 1.

## Closed — Sprint 11 STEP 8

Path (a) is what shipped, and Sprint 8 closed the challenge half. The
**redemption** half stayed open one sprint longer than this ADR expected:
codes were generated and stored from Sprint 8 with no endpoint that could
spend them, while MFA is mandatory for admin and manager. The documented
fallback — another admin's `PUT /v1/staff/:id/mfa/reset` — cannot help the case
that matters, a sole admin who lost their authenticator, which is why it was
promoted out of "follow-up" and built beside its counterpart.

Path (a) shaped the answer. Because enrolment and verification live on the
user's own Supabase session, only Supabase can mint the `aal2` claim the
middleware gates on, so a redeemed code cannot complete a session — it clears
the factor and routes to `/mfa-setup` instead. See `08-AUTH-MATRIX.md` §10 and
`AuthService.redeemRecoveryCode`.

The failure budget is one Redis key shared by both credential types. Because
the login TOTP check never reaches the API, a failed challenge is reported by
the client (`POST /v1/auth/mfa/failure`) rather than counted where it happened —
the one place path (a) costs something real.
