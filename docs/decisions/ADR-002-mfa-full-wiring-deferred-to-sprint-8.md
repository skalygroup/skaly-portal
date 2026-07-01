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
