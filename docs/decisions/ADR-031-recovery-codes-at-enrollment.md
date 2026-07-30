# ADR-031 — Recovery codes are issued at enrollment, not on a Profile visit

**Status:** Accepted • Sprint 11 (STEP 13) — **BUILT**
**Cross-refs:** ADR-002 (MFA wiring deferred to Sprint 8) · `AUTH-MATRIX` §10 ·
`07-API-CONTRACT` (`/v1/auth/mfa/*`) · Sprint 11 STEP 8 (recovery-code redeem)

> This is the completion of the recovery-code story, not a new decision. STEP 8 built the
> redeem path; this ADR records that the redeem path is worthless to a user who holds no
> codes, and closes the half that was still open.

## Context

STEP 8 built `POST /v1/auth/mfa/recovery` so a user who has lost their authenticator can
spend a single-use code and get back in. It exists because of the sole-admin lockout: an
admin with no second admin has nobody to press "Reset MFA" for them.

`/v1/auth/mfa/enroll` mints ten codes as part of enrollment, and `mfa-setup` shows them
once behind an "I've saved these" acknowledgment. **But there is a second enrollment
path.** When the installed Supabase admin SDK cannot enroll a factor server-side, that
endpoint answers `501 MFA_ENROLL_UNAVAILABLE` and the client falls back to enrolling
through the user's own Supabase session — a path that mints nothing. It set
`recoveryCodes: []`, skipped the acknowledgment gate entirely, and told the user to *"ask
an admin to reset your MFA"*.

So the users on that path did not merely lack awareness of their codes. **They had none.**
And "ask an admin" is precisely the wrong first answer for the person the redeem path was
built for.

## Decision

1. **Immediately after the TOTP factor verifies, the portal ensures codes exist.** If
   enrollment returned an empty set, `mfa-setup` calls the existing
   `POST /v1/auth/mfa/recovery/regenerate` before showing the recovery step.

2. **After verify, never before.** Issuing recovery codes for a factor that then fails to
   enroll would replace a working set with one belonging to a factor nobody holds.
   `regenerate` requires `aal2`, which `supabase.auth.mfa.verify` has just granted — so
   the ordering is enforced by the endpoint as well as by the code.

3. **The acknowledgment gate applies to both paths.** "Continue to portal" stays disabled
   until the user ticks *I've saved my recovery codes*.

4. **No new surface.** This is the same generation and the same display the Profile
   regenerate path already uses, wired into the post-verify step. Profile → Regenerate
   stays for rotation and the ≤2 nag; it stops being the only way to *have* codes.

5. **A failed mint is best-effort, not a failed enrollment.** MFA is genuinely active at
   that point; erroring out would strand the user with a verified factor and no way
   forward. The step names `Profile → Recovery codes` instead — a remedy they can perform
   themselves.

## On testing a path this environment cannot run

Local Supabase cannot issue a TOTP factor, so `/v1/auth/mfa/enroll` 501s locally and the
fallback is the only branch a developer sees by hand. That is a reason to **mock the enroll
success** and cover the generate-display-acknowledge path in a unit test
(`mfa-setup/page.test.tsx`, three branches: server-enroll, fallback-mint, mint-failure),
and to verify the live flow on staging.

> An environment that cannot exercise a path is a reason to mock it in the test, never a
> reason to ship the hole.

## Rule

> Nobody leaves enrollment without recovery codes.
