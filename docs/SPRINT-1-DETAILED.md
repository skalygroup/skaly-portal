# SPRINT 1 — AUTH + SIGNUP: DETAILED PROMPT-BY-PROMPT GUIDE

## Scaly Business Portal • Sprint 1 of 13

**Companion to `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9**
**Same Goal / Prompt / Verify framework as Sprint 0 (PART 7)**

---

## WHAT YOU'RE BUILDING IN SPRINT 1

By the end of this week, every authentication path defined in `docs/04-APPFLOW.md` §1–§2 works end-to-end:

- Users log in with email/password.
- Users log in with Google OAuth.
- Admins invite new users by email (one-link, expiring in 24h).
- Outsiders request access through `/signup` with a CV upload; admins approve or reject.
- On approval, the new staff member's attendance rows for the rest of the current period are generated automatically (audit M-02).
- Admins and managers are forced through MFA enrollment on first login.
- Password reset works.
- Sessions silently refresh at the 55-minute mark.
- Deactivated accounts get a clear error message at login.

**Estimated time:** 5 working days (per `docs/06-IMPLEMENTATION-PLAN.md` §4). Sprint 1 is dense — auth is the most security-critical surface in the entire portal. Do not rush. Every test in the close-out checklist must pass before Sprint 2 starts.

**Prerequisites from Sprint 0** (all must be green):

- `apps/api` boots, `/v1/health` returns ok.
- `apps/web` boots, gold "Scaly Business Portal" placeholder renders.
- All 26 migrations applied; `signup_requests` table exists with partial unique index on `email WHERE status='pending'`.
- Supabase project created in Sprint 0 PART 3 with TOTP enabled.
- shadcn/ui initialised in `apps/web` (Sprint 0 STEP 4).
- B-01 lockdown verified — `audit_log` writes only via SECURITY DEFINER function.
- Git on `main` with Sprint 0 close-out pushed.

---

## READ FIRST (Open in Antigravity Split View)

Pin these tabs before you begin. Antigravity lets you `@`-reference them in chat with `@docs/04-APPFLOW.md`.

| Doc | Sections | Why |
|---|---|---|
| `docs/04-APPFLOW.md` | §1, §2.1–§2.8 | Every flow Sprint 1 must produce |
| `docs/07-API-CONTRACT.md` | §1 (auth endpoints) | Exact request/response shapes |
| `docs/08-AUTH-MATRIX.md` | entire (it's short) | RBAC roles + permission grid |
| `docs/06-IMPLEMENTATION-PLAN.md` | §4 | Sprint 1 checklist |
| `docs/05-BACKEND-SCHEMA.md` | tables `staff`, `invite_links`, `signup_requests` | Field names you'll reference |
| `docs/FIX-GUIDE-V2-COMPLETE.md` | §H-04, §M-02 | The two audit items resolved this sprint |
| `docs/09-ERROR-HANDLING.md` | §1 (auth errors) | Error code shapes |

---

## AUDIT ITEMS THIS SPRINT MUST HANDLE

| ID | What | Where it lives |
|---|---|---|
| **H-04** | Reject signup if email already in `staff` (active OR soft-deleted) with `{ code: 'ALREADY_PROCESSED' }`. The partial unique index on `signup_requests(email) WHERE status='pending'` from migration 007 backstops duplicate pending requests at the DB layer. | STEP 6 (AuthService.signupRequest) |
| **M-02** | On approval, `AttendanceService.backfillCurrentPeriod(newStaffId)` runs **inside the same transaction** as the staff row insert. No mid-month staff missing the first days of the period. | STEP 7 (AuthService.approveSignupRequest) |
| **Rejection privacy** | `rejection_note` is stored in DB only. The API response to the rejected user **never** includes it. Only `public_rejection_message` is transmitted. | STEP 7 + STEP 9 test |
| **Role privacy on denial** | Failed RBAC checks return generic "permission denied" — never reveal role requirements. | STEP 4 (auth.plugin.ts) |

If you skip the test for any of these, Sprint 1 is not done. They show up again in CI when you push.

---

## STEP-BY-STEP STRUCTURE

| # | Type | What |
|---|---|---|
| 1 | Manual | Supabase project configuration |
| 2 | Manual | Google OAuth credentials in Google Cloud Console |
| 3 | Prompt | New backend deps + Zod schemas in `packages/shared` |
| 4 | Prompt | Auth plugin (JWT verify + Redis cache + RBAC factory) |
| 5 | Prompt | AuthService + invite flow (`/v1/auth/invite`, `/v1/auth/signup/invite`) |
| 6 | Prompt | Self-signup with CV upload (H-04) |
| 7 | Prompt | Admin approve/reject (M-02 + rejection privacy) |
| 8 | Prompt | Password reset + session + MFA endpoints |
| 9 | Prompt | Route registration + integration test pass |
| 10 | Manual + Prompt | Frontend shadcn install + auth route group |
| 11 | Prompt | `/login` page (email/password + Google) |
| 12 | Prompt | `/signup` + `/signup/invite` + `/signup/pending` |
| 13 | Prompt | `/mfa-setup` + `/forgot-password` + `/reset-password` |
| 14 | Prompt | Next.js middleware + admin signup-requests panel + session refresh |
| 15 | Manual | End-to-end smoke test + commit + close-out |

---

## SPRINT 1 — STEP 1: Supabase project configuration

**Goal:** Your Supabase project's auth settings exactly match what `docs/04-APPFLOW.md` §2 and `docs/08-AUTH-MATRIX.md` assume. JWT settings, redirect URLs, email templates, OAuth providers, and MFA are configured before any code touches them.

**This is a manual step.** Supabase's dashboard has shifted layouts a few times — section names below are correct as of January 2026, but if you can't find a setting under the exact heading, search inside the project dashboard's search bar (top-right) for the keyword.

### 1.1 — Confirm project basics

1. Open `https://supabase.com/dashboard` → select the `skaly-portal` project you created in Sprint 0 PART 3.
2. Sidebar → **Project Settings** (gear icon at bottom).
3. **General** tab → confirm:
   - Region: Singapore (`ap-southeast-1`) or Mumbai (`ap-south-1`).
   - Project ref: matches `NEXT_PUBLIC_SUPABASE_URL` in your `apps/web/.env.local`.

### 1.2 — Authentication → URL Configuration

Sidebar → **Authentication** → **URL Configuration**.

- **Site URL:** `http://localhost:3000` (development). You'll add production later in Sprint 13.
- **Redirect URLs** (allow-list — every callback URL must be here or Supabase refuses the OAuth callback):
  - `http://localhost:3000/auth/callback`
  - `http://localhost:3000/auth/confirm`
  - `http://localhost:3000/reset-password`
  - `https://*.vercel.app/auth/callback` (covers Vercel preview deploys)
  - `https://*.vercel.app/auth/confirm`
  - `https://*.vercel.app/reset-password`

Click **Save**.

### 1.3 — Authentication → Providers → Email

Sidebar → **Authentication** → **Providers** → click **Email**.

- **Enable Email provider:** ON.
- **Confirm email:** ON (users must verify email).
- **Secure email change:** ON.
- **Secure password change:** ON.
- **Minimum password length:** `10`.
- **Password requirements:** lowercase, uppercase, digits, special characters — all ON.

Save.

### 1.4 — Authentication → Multi-Factor Authentication

Sidebar → **Authentication** → **Multi-Factor Authentication** (or under **Settings** → **Auth** depending on dashboard version — search "MFA" if missing).

- **TOTP factor:** Enabled.
- **Max factors per user:** `1` (one authenticator app per account is enough; recovery codes are separate).

Save.

### 1.5 — Authentication → Email Templates (T1–T4 fallback)

This is the audit item **B-02** decision point from the Sprint 0 close-out. If your design lead has delivered branded T1–T4 templates, paste those HTML bodies in here. **If they have not delivered**, use Supabase defaults for now and Sprint 13 will re-skin them. Either decision is acceptable; not deciding is not.

Sidebar → **Authentication** → **Email Templates**. Four templates to review:

- **Confirm signup** — sent after a self-signup or invite-acceptance.
- **Invite user** — sent by `inviteUserByEmail`.
- **Magic Link** — not used by us (we use password) — leave default.
- **Reset Password** — sent by password reset flow.

In each one you customize, the subject line should match: "Welcome to Scaly Portal" / "You've been invited to Scaly Portal" / "Reset your Scaly Portal password". The body's call-to-action button URL is templated with `{{ .ConfirmationURL }}` — leave that variable alone.

### 1.6 — JWT secret + JWKS URL

Sidebar → **Project Settings** → **API**.

- Copy **JWT Secret** (a long base64 string starting with something like `super-secret-`). This is for HS256 — we don't use HS256. **Ignore this.**
- Copy **JWKS URL** (looks like `https://<project-ref>.supabase.co/.well-known/jwks.json`). This is what our Fastify plugin will fetch RS256 public keys from. **Save this** in a scratchpad — you'll paste it into `apps/api/.env` as `SUPABASE_JWKS_URL` in STEP 4.

### 1.7 — Service role key

Same page (**Project Settings** → **API**), section **Project API Keys**.

- **`anon`** (public) — already in `apps/web/.env.local` as `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Sprint 0. Leave alone.
- **`service_role`** (secret) — required for backend admin operations (creating users, sending invites, resetting MFA factors). **Copy** this. Paste into `apps/api/.env` as `SUPABASE_SERVICE_ROLE_KEY=...`. **Never** put this in the web app's env file — it bypasses Row Level Security and would be a critical leak.

### 1.8 — Create a test admin user

Sidebar → **Authentication** → **Users** → click **Add user** → **Create new user**.

- Email: your own personal email.
- Password: a strong one. (You'll change it on first login if you want.)
- **Auto Confirm User:** ON. (Skips email confirmation for this seed admin.)

Click **Create user**. Copy the new user's UUID (visible in the row, or click into the user — top-left, the `id` field).

Now you need a corresponding row in the `staff` table for this Supabase user. Open a terminal in Antigravity:

```bash
docker exec -it skaly-portal-postgres-1 psql -U skaly -d skaly_dev
```

Run (replace `<your-uuid>` with the UUID you just copied, and `<your-email>` with your email):

```sql
INSERT INTO staff (id, supabase_uid, name, email, role, active, mfa_enrolled, created_at)
VALUES (
  gen_random_uuid(),
  '<your-uuid>',
  'Mohammed Arslaan',
  '<your-email>',
  'admin',
  true,
  false,
  NOW()
);
```

Confirm with `SELECT id, email, role FROM staff;` then `\q` to exit.

**Verify:**

- URL Config saved (refresh the page; values stick).
- TOTP enabled.
- Service role key in `apps/api/.env` as `SUPABASE_SERVICE_ROLE_KEY`.
- JWKS URL noted (for STEP 4).
- One row in `staff` table with `role='admin'`, and the matching Supabase user in **Authentication** → **Users**.

---

## SPRINT 1 — STEP 2: Google OAuth setup in Google Cloud Console

**Goal:** Users can sign in / sign up with "Continue with Google". This needs a Google Cloud project, an OAuth consent screen, and an OAuth 2.0 client ID wired into Supabase.

### 2.1 — Create or pick a Google Cloud project

1. Open `https://console.cloud.google.com/`.
2. Top bar → project dropdown → **New Project**.
3. Name: `skaly-portal`. Organization: leave default. Click **Create**.
4. Wait ~10 seconds for project creation. Switch to it via the project dropdown.

### 2.2 — Enable the OAuth API

You don't need to enable any specific Google API for sign-in (no Gmail API, no Drive API). But you do need the OAuth consent screen configured.

### 2.3 — Configure the OAuth consent screen

Sidebar → **APIs & Services** → **OAuth consent screen** (Google Cloud has been migrating users to a new "Auth platform" experience — if you see that, use it instead; the prompts are equivalent).

1. **User Type:** **External** (we want any Google account to be able to apply for access).
2. **App information:**
   - **App name:** `Scaly Portal`.
   - **User support email:** your email.
   - **App logo:** upload the Skaly circle-badge logo from your `apps/web/public/brand/` folder (square, 120×120 minimum).
3. **App domain:**
   - Application home page: `https://portal.skaly.in` (set this even though the domain isn't live yet — placeholder).
   - Application privacy policy: leave blank for now (add in Sprint 13).
   - Application terms of service: leave blank.
4. **Authorized domains:** add `skaly.in`. (Just the apex domain — not `portal.skaly.in`.)
5. **Developer contact:** your email.
6. Click **Save and Continue**.

**Scopes screen:** add the three basic scopes:
- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`
- `openid`

Click **Save and Continue**.

**Test users screen** (only relevant while the app is in "Testing" mode): add your own email + any teammates who will test before launch. Click **Save and Continue**.

**Summary screen:** review. Click **Back to Dashboard**.

The app will stay in **Testing** mode (which has a 100-user cap and warns testers with an "unverified app" screen). For the MVP that's fine. When you launch, you can either submit for verification or keep it in Testing if total staff stays under 100.

### 2.4 — Create the OAuth 2.0 client ID

Sidebar → **APIs & Services** → **Credentials** → top bar **+ Create Credentials** → **OAuth client ID**.

- **Application type:** **Web application**.
- **Name:** `Scaly Portal Web Client`.
- **Authorized JavaScript origins:**
  - `http://localhost:3000`
  - `https://*.vercel.app` — Wait. Google does **not** allow wildcards in JS origins. Add specific Vercel preview origins as they come up, or skip this for now and add only when needed:
  - For now add just: `http://localhost:3000`. You'll add the production `https://portal.skaly.in` in Sprint 13.
- **Authorized redirect URIs:**
  - `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback` — this is Supabase's OAuth callback, **not** yours. (Replace `<your-supabase-project-ref>` with the ref from Project Settings → General.)

Click **Create**. A modal shows the **Client ID** and **Client Secret**. **Copy both immediately** (the secret is only shown once with full visibility, though you can re-create later if needed).

### 2.5 — Paste credentials into Supabase

Back to Supabase dashboard → **Authentication** → **Providers** → click **Google**.

- Toggle **Enable Sign in with Google:** ON.
- **Client ID (for OAuth):** paste the Google Client ID.
- **Client Secret (for OAuth):** paste the Google Client Secret.
- **Callback URL (for OAuth):** Supabase shows you this URL — copy it and confirm it matches what you put in Google Console step 2.4 above. If they don't match exactly, OAuth will fail with `redirect_uri_mismatch`.

Save.

**Verify:**

In a fresh browser incognito tab, manually hit:
```
https://<your-supabase-project-ref>.supabase.co/auth/v1/authorize?provider=google&redirect_to=http://localhost:3000/auth/callback
```

You should be redirected to Google's account picker. Pick your Google account → grant permissions → you'll land on `http://localhost:3000/auth/callback` with an error (because `apps/web` doesn't have a callback handler yet — we build that in STEP 11). The error is fine for now; what matters is that you got from Google back to your localhost. That confirms the OAuth handshake works end-to-end. If you got stuck on a Google "redirect_uri_mismatch" error or got a Supabase "Provider not enabled" error, fix the corresponding setting and re-test.

---

## SPRINT 1 — STEP 3: Backend new dependencies + Zod schemas

**Goal:** Install the auth-specific npm packages we need for the Fastify backend, then build a single source of truth for all auth request/response shapes in `packages/shared`.

### 3.1 — Install backend dependencies

In the Antigravity terminal:

```bash
cd apps/api
pnpm add jose @supabase/supabase-js @fastify/multipart
pnpm add -D @types/node
```

What these are:
- **`jose`** — JWT/JWKS verification. The plugin in STEP 4 uses `createRemoteJWKSet` against the Supabase JWKS URL to verify RS256 signatures.
- **`@supabase/supabase-js`** — Supabase Admin client (for creating users, sending invites, MFA reset). Use the `service_role` key only on the backend.
- **`@fastify/multipart`** — for the CV upload in `/v1/auth/signup/request`. Configures multipart streaming straight to R2 via presigned URL (no disk write).

Confirm versions in `apps/api/package.json` are pinned to caret-major (`^`) — Fastify 5 plugins must all match Fastify's major.

### 3.2 — Add `SUPABASE_JWKS_URL` to env

Open `apps/api/.env` and add (use the JWKS URL you copied in STEP 1.6):

```
SUPABASE_JWKS_URL=https://<your-project-ref>.supabase.co/.well-known/jwks.json
SUPABASE_SERVICE_ROLE_KEY=<the service role key you copied in STEP 1.7>
SUPABASE_URL=https://<your-project-ref>.supabase.co
```

Then update `apps/api/src/lib/env.ts` (the Zod env validator from Sprint 0 STEP 5) to require these three keys. The validator's `parse()` call at app start will fail loud if any are missing.

### 3.3 — Build the auth Zod schemas (prompt)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 0 is done. I'm in Sprint 1, STEP 3.3 — building the Zod schemas that every auth route will share between backend (request validation, response typing) and frontend (form validation).
>
> **WHAT TO BUILD**
>
> Create `packages/shared/src/schemas/auth.ts` with Zod schemas for every auth payload defined in `docs/04-APPFLOW.md` §2 and `docs/07-API-CONTRACT.md` §1.
>
> Export named schemas (not default export). The file must export at minimum:
>
> 1. **`LoginEmailSchema`** — `{ email: z.string().email(), password: z.string().min(10) }`.
>
> 2. **`InviteCreateSchema`** — body of `POST /v1/auth/invite`:
>    - `email`: optional `z.string().email()` (if present, invite is scoped to that email; if absent, generic link).
>    - `role`: enum `['admin','manager','team_member','freelancer']`.
>
> 3. **`SignupViaInviteSchema`** — body of `POST /v1/auth/signup/invite`:
>    - `token`: `z.string().min(32)`.
>    - `password`: `z.string().min(10)` with regex enforcing one uppercase, one lowercase, one digit, one special char.
>    - `name`: `z.string().min(1).max(255)`.
>    - `dateOfBirth`: `z.string().date()` (ISO YYYY-MM-DD).
>    - `mobileNumber`: `z.string().regex(/^\+\d{1,3}\d{6,14}$/, '+CC format required')`.
>
> 4. **`SignupRequestSchema`** — body of `POST /v1/auth/signup/request` (the self-signup form per APPFLOW §2.6). Required fields: `name`, `email`, `dateOfBirth`, `mobileNumber`, `roleRequested` (enum `['manager','team_member','freelancer']` — admin **excluded**). Optional: `message` (max 500 chars), `googleUid` (set if the user came in via OAuth path A).
>
> 5. **`SignupApproveSchema`** — body of `POST /v1/auth/signup-requests/:id/approve`:
>    - `roleAssigned`: enum `['admin','manager','team_member','freelancer']` (admin can override role_requested).
>
> 6. **`SignupRejectSchema`** — body of `POST /v1/auth/signup-requests/:id/reject`:
>    - `rejectionNote`: `z.string().min(1).max(2000)` (internal, never shown to user).
>    - `publicRejectionMessage`: `z.string().max(300).optional()`.
>
> 7. **`PasswordResetRequestSchema`** — `{ email: z.string().email() }`.
>
> 8. **`PasswordResetConfirmSchema`** — `{ token: z.string(), newPassword: z.string().min(10) }` with same complexity rules.
>
> 9. **`MfaEnrollResponseSchema`** — describes what `POST /v1/auth/mfa/enroll` returns to the frontend: `{ factorId, qrCodeDataUrl, secret, recoveryCodes: z.array(z.string()).length(10) }`.
>
> 10. **`MfaVerifySchema`** — body of `POST /v1/auth/mfa/verify`: `{ factorId, code: z.string().length(6).regex(/^\d+$/) }`.
>
> 11. **`SessionRefreshResponseSchema`** — `{ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() }`.
>
> 12. **`StaffMeResponseSchema`** — shape of `GET /v1/staff/me`: `{ id, name, email, role, active, mfaEnrolled, avatarUrl: z.string().url().nullable(), permissions: z.record(z.string(), z.boolean()) }`. This is the response shape from C-04 (Sprint 0 reference handler).
>
> Also export inferred TypeScript types using `z.infer<typeof Schema>` for each — naming convention `LoginEmailInput`, `InviteCreateInput`, etc.
>
> **RULES**
>
> - One file, one source of truth. Both `apps/api` and `apps/web` will import from `@skaly/shared/schemas/auth`.
> - Password complexity regex: at least one lowercase, one uppercase, one digit, one special char. Min 10 chars.
> - The `roleRequested` enum on `SignupRequestSchema` excludes `'admin'` — per APPFLOW §2.6 admin is never self-selectable.
> - For dates, use `z.string().date()` (ISO calendar date validation). Don't use `z.date()` because the wire format is JSON-string.
> - Use `z.email()` and `z.string()` from Zod's standard surface — no custom validators.
> - **Verify before moving on.** After creating the file, show me the file contents. Then run `pnpm --filter @skaly/shared build` and paste the output. If TypeScript complains, fix before continuing.
>
> Start now.

**Verify:**

```bash
cd /
pnpm --filter @skaly/shared build
pnpm typecheck
```

Both must come back clean. Then verify imports resolve:

```bash
cd apps/api
node -e "console.log(Object.keys(require('@skaly/shared/schemas/auth')))"
```

Should print an array containing `LoginEmailSchema`, `InviteCreateSchema`, etc.

---

## SPRINT 1 — STEP 4: Auth plugin (JWT verify + Redis cache + RBAC factory)

**Goal:** Every protected Fastify route runs through one plugin that verifies the Supabase RS256 JWT, looks up the staff row (cached in Redis), attaches `request.user`, and rejects unauthorized requests with the right error code. A `requireRole(...roles)` factory exposes role-gated route handlers.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 4. Auth schemas are in `packages/shared/src/schemas/auth.ts`. Now I'm building the Fastify auth plugin that every protected route will use.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/middleware/auth.plugin.ts`** — a Fastify plugin (registered via `fastify-plugin` so its decorators escape encapsulation):
>
>    - On registration, build a `JWKS` instance with `jose.createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL))`. Cache the JWKS object on the Fastify instance (one cache per process is correct — JWKS auto-refreshes per `jose` defaults).
>
>    - Add a `preHandler` hook named `verifyJwt` (named, not anonymous — exposed via `fastify.decorate('verifyJwt', ...)`) that:
>      a. Reads `Authorization: Bearer <token>` header. If absent, reject 401 `{ code: 'NO_TOKEN' }`.
>      b. Calls `jose.jwtVerify(token, JWKS, { issuer: env.SUPABASE_URL + '/auth/v1', audience: 'authenticated' })`. On error, 401 `{ code: 'INVALID_TOKEN' }`.
>      c. Extracts `sub` claim — that's the Supabase user UUID (`supabase_uid`).
>      d. Looks up staff row. **Cache strategy:**
>         - Try `redis.get('staff_lookup:' + supabaseUid)`. If hit, parse JSON.
>         - If miss, `SELECT id, supabase_uid, name, email, role, active, mfa_enrolled, avatar_url FROM staff WHERE supabase_uid = $1 AND deleted_at IS NULL`. If no row, 401 `{ code: 'NO_STAFF_ROW' }` (means the Supabase user exists but no staff record — happens during signup if backfill failed). Cache with `SET staff_lookup:{uid} {json} EX 300` (5-minute TTL per BACKEND-SCHEMA §Redis schema line 576).
>      e. If `staff.active === false`, reject 403 `{ code: 'ACCOUNT_DEACTIVATED' }` (the frontend translates this to "Account deactivated. Contact your admin.").
>      f. Set `request.user = staff` and proceed.
>
>    - Export a **factory** `requireRole(...roles: Role[])`: returns a `preHandler` that runs **after** `verifyJwt` and checks `request.user.role` is in the allowed set. On fail, 403 `{ code: 'PERMISSION_DENIED' }`. **Critical**: do not echo back which role was required. The error message is always the literal "Permission denied." per the audit M-08 design principle (no role leakage even in auth).
>
>    - Export a helper `invalidateStaffCache(supabaseUid: string)` that does `redis.del('staff_lookup:' + supabaseUid)`. Used in STEP 7 after approval/deactivation/role change so the cache doesn't go stale.
>
> 2. **`apps/api/src/types/fastify.d.ts`** — extend (Sprint 0 created this file; add to it):
>
>    ```ts
>    declare module 'fastify' {
>      interface FastifyRequest {
>        user: import('@skaly/shared/db.types').Staff;
>      }
>      interface FastifyInstance {
>        verifyJwt: import('fastify').preHandlerHookHandler;
>        requireRole: (...roles: string[]) => import('fastify').preHandlerHookHandler;
>      }
>    }
>    export {};
>    ```
>
> 3. **`apps/api/src/middleware/auth.plugin.test.ts`** — vitest tests using `@fastify/inject` (no live server). Cover:
>    - `verifyJwt` returns 401 on missing header.
>    - `verifyJwt` returns 401 on malformed token.
>    - `verifyJwt` returns 401 on valid signature but unknown `sub` (no staff row).
>    - `verifyJwt` returns 403 on deactivated user.
>    - `verifyJwt` returns 200 on valid token + active staff row.
>    - `requireRole('admin')` returns 403 for a team_member.
>    - `requireRole('admin','manager')` returns 200 for both.
>    - Redis cache hit on second request to same endpoint (assert via spy that DB was queried only once).
>    - Cache invalidation: `invalidateStaffCache(uid)` causes next request to re-query DB.
>
>    Mock `jose.jwtVerify` and the DB with vitest's `vi.mock`. For the signed test token, generate one with `jose.SignJWT` using a test RSA private key and inject a matching JWKS mock.
>
> 4. Register the plugin in `apps/api/src/app.ts`:
>    ```ts
>    await app.register(authPlugin);
>    ```
>    Order matters: register **after** `redis` and `db` plugins but **before** any route plugin.
>
> **RULES**
>
> - The plugin must not throw on `redis.get` failure — Redis is a cache, not a source of truth. On Redis error, log a warning via Pino and fall through to DB query. The route still succeeds.
> - Cache TTL: exactly 300 seconds (5 min) per BACKEND-SCHEMA §Redis schema.
> - Never log the JWT body (it contains the Supabase access token).
> - Per audit C-04, `request.user.id` is **never** null in our system — middleware guarantees it for protected routes. Audit log entries from automated processes use `SYSTEM_ACTOR_UUID` directly (Sprint 2 base service work).
> - **Verify before moving on.** Show me `auth.plugin.ts`, I'll review. Then write the tests. Then run them.
>
> Start with the plugin file.

**Verify:**

```bash
cd apps/api
pnpm test middleware/auth.plugin.test
```

All tests green. Then a manual sanity check with a real Supabase token:

1. In your browser at `https://supabase.com/dashboard/project/<ref>/auth/users`, click your test admin user → top-right "**...**" → **"Send password recovery email"** is one way to get a session, or use the **JWT Generator** under **Authentication** → **JWT Keys** if available; the simplest: open `apps/web` (boot it), open browser devtools → Application → Local Storage → find `sb-<ref>-auth-token` → copy the `access_token` value from the JSON.

Wait — we haven't built the login page yet. Skip the manual test for now; the unit tests above are sufficient verification at this stage. We'll do the manual test in STEP 15 once `/login` exists.

---

## SPRINT 1 — STEP 5: AuthService + invite flow

**Goal:** `POST /v1/auth/invite` (admin only) creates an `invite_links` row and sends a Supabase invite email. `POST /v1/auth/signup/invite` validates the token, creates the Supabase user, creates the staff row, marks the token consumed — all in one transaction.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 5. Auth plugin is in place. Now I'm building AuthService (the orchestration layer) and the invite-based flow first.
>
> **WHAT TO BUILD**
>
> 1. **`apps/api/src/services/AuthService.ts`** — a class that takes `db: Kysely<DB>`, `redis: Redis`, `supabaseAdmin: SupabaseClient` (built with the service role key), and a logger. Constructor signature is enough for now; methods below.
>
> 2. **`AuthService.createInvite({ email, role, createdBy, trx? })`** — implementation:
>    - Inside a transaction (if `trx` passed, use it; else open new):
>      a. Insert row into `invite_links`. The schema (migration 006) auto-generates `token` (hex) and sets `expires_at = NOW() + INTERVAL '24 hours'`. Pass `email` (nullable), `role`, `created_by`.
>      b. Get the resulting `token` value.
>      c. If `email` is set, call `supabaseAdmin.auth.admin.inviteUserByEmail(email, { data: { invite_token: token } })` — this sends Supabase's branded invite email containing a magic link that lands on our `/signup/invite?token=<token>` page. The `data.invite_token` rides along in the user's `user_metadata` so the signup flow can match it.
>      d. Audit log: `AuditService.log({ actorId: createdBy, entity: 'invite_link', entityId: insertedRow.id, action: 'invite.create', after: { email, role }, trx })`. (Sprint 2 will build `AuditService`. For Sprint 1, write a placeholder method `auditServiceLog(...)` that just `pino.info`s the entry — Sprint 2 swaps in the real service.)
>    - Return `{ id, token, expiresAt, email, role }`.
>
> 3. **`AuthService.consumeInviteSignup({ token, password, name, dateOfBirth, mobileNumber })`** — implementation:
>    - Inside a transaction:
>      a. `SELECT * FROM invite_links WHERE token = $1 FOR UPDATE` — locks the row. If no row, throw `INVITE_NOT_FOUND` (404).
>      b. If `used_at IS NOT NULL`, throw `INVITE_ALREADY_USED` (409).
>      c. If `expires_at < NOW()`, throw `INVITE_EXPIRED` (410).
>      d. **H-04 check** (also applies to invites): `SELECT 1 FROM staff WHERE email = $1 LIMIT 1` (regardless of `deleted_at`). If row exists, throw `ALREADY_PROCESSED` (409). Better to fail early than create a Supabase user that has no matching staff row.
>      e. Call `supabaseAdmin.auth.admin.createUser({ email: <invite.email or null fallback>, password, email_confirm: true, user_metadata: { name } })`. Get `supabase_uid` from the response.
>      f. Insert into `staff`: `{ supabase_uid, name, email, role: invite.role, date_of_birth, mobile_number, active: true, mfa_enrolled: false }`.
>      g. Update `invite_links SET used_at = NOW(), used_by = <newStaffId> WHERE id = $1`.
>      h. Audit log: `staff.create`.
>      i. **Cache pre-warm** (optional but cheap): `redis.set('staff_lookup:' + supabase_uid, JSON.stringify(staffRow), 'EX', 300)`.
>    - Return `{ staffId, supabaseUid }`. Frontend will follow with a separate login call.
>
> 4. **Route `POST /v1/auth/invite`** in `apps/api/src/routes/auth/invite.ts`:
>    - `preHandler: [fastify.verifyJwt, fastify.requireRole('admin')]`.
>    - Body validated with `InviteCreateSchema` via `fastify-type-provider-zod`.
>    - Calls `authService.createInvite({ email, role, createdBy: request.user.id })`.
>    - Returns 201 with `{ id, token, expiresAt, email, role }`.
>
> 5. **Route `POST /v1/auth/signup/invite`** — public (no `verifyJwt`):
>    - Body validated with `SignupViaInviteSchema`.
>    - Calls `authService.consumeInviteSignup(body)`.
>    - On `INVITE_NOT_FOUND` → 404, `INVITE_ALREADY_USED` → 409, `INVITE_EXPIRED` → 410, `ALREADY_PROCESSED` → 409, generic → 500.
>    - Returns 201 with `{ staffId }`. The user will follow with `POST /auth/v1/token?grant_type=password` from the frontend to get a session.
>
> 6. **Tests `apps/api/src/services/AuthService.invite.test.ts`** — integration (real Postgres via testcontainers or your existing local Postgres in `NODE_ENV=test`):
>    - Admin creates invite → row in `invite_links`, token is 64 hex chars.
>    - Calling `inviteUserByEmail` is mocked (`vi.spyOn(supabaseAdmin.auth.admin, 'inviteUserByEmail')`); assert it was called with the right email + `invite_token` in metadata.
>    - Consume invite with valid token + valid form → staff row exists, invite marked used.
>    - Consume invite twice → second call throws `INVITE_ALREADY_USED`.
>    - Consume expired invite (manually `UPDATE invite_links SET expires_at = NOW() - INTERVAL '1 day'`) → `INVITE_EXPIRED`.
>    - Consume invite for email already in `staff` → `ALREADY_PROCESSED`.
>    - Consume invite for soft-deleted staff email → `ALREADY_PROCESSED` (per audit H-04 — applies to both states).
>
> **RULES**
>
> - One transaction per service method. If `supabaseAdmin.createUser` throws after the Supabase user is created but before the staff row insert, we have an orphaned Supabase user. Acceptable for MVP — log loudly. (Sprint 13 will add a janitor job; not in scope here.)
> - The `createUser` call uses `email_confirm: true` so the user can log in immediately without a separate confirmation step. The invite email is the confirmation gate.
> - Don't move the invite token to the URL fragment — it goes in the query string (`/signup/invite?token=...`) so the frontend can read it server-side via Next's `searchParams`.
> - The audit-log placeholder must accept the same arg shape Sprint 2's real `AuditService.log` will use, so swap-in is one-line.
> - **Verify before moving on.** Show me `AuthService.ts` with just these two methods. I'll review. Then routes. Then tests.
>
> Start with `AuthService.ts`.

**Verify:**

```bash
cd apps/api
pnpm test services/AuthService.invite.test
```

All green. Then manually hit the route from another terminal:

```bash
# Get an admin JWT first — easiest is logging in via the Supabase JS client.
# Since we don't have /login yet, do it via curl against Supabase directly:

curl -s -X POST "https://<your-project-ref>.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <your-supabase-anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"<your-admin-email>","password":"<your-admin-password>"}' \
  | jq -r '.access_token'
```

Copy the token. Then:

```bash
curl -X POST http://localhost:3001/v1/auth/invite \
  -H "Authorization: Bearer <paste-token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"test-invite@example.com","role":"team_member"}'
```

Expect 201 with a token. Check inbox of `test-invite@example.com` — Supabase should have sent the invite email.

---

## SPRINT 1 — STEP 6: Self-signup with CV upload (H-04)

**Goal:** A prospective staff member visits `/signup`, fills the form, optionally uploads a CV (max 5MB PDF/DOC). Backend writes `signup_requests` row, streams CV to R2, notifies all admins. Duplicate emails get the H-04 rejection.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 6. Invite flow is working. Now self-signup with CV upload.
>
> **WHAT TO BUILD**
>
> 1. **Register `@fastify/multipart` in `apps/api/src/app.ts`** (before route registration):
>    ```ts
>    await app.register(import('@fastify/multipart'), {
>      limits: { fileSize: 5 * 1024 * 1024, files: 1 }
>    });
>    ```
>    5MB cap, max one file per request. Reject larger with HTTP 413.
>
> 2. **`AuthService.signupRequest(form, cvStream?)`** — implementation:
>    - **H-04 check #1 (active or soft-deleted staff):** `SELECT 1 FROM staff WHERE email = $1 LIMIT 1`. If exists, throw `ALREADY_PROCESSED` (409). The deleted_at column is NOT filtered — applies to both.
>    - **H-04 check #2 (pending signup):** the DB-level partial unique index `idx_signup_requests_email_pending` will throw a unique-violation if you try to insert a second pending row for the same email. Catch Postgres error code `23505` and translate to `ALREADY_PROCESSED`. (The service-layer check above is the fast path; the DB index is the race-condition backstop.)
>    - Insert `signup_requests` row with `status='pending'`. Get back the new `requestId`.
>    - If `cvStream` is present:
>      a. Compute R2 key: `cvs/requests/{requestId}/cv.<ext>` where `<ext>` is derived from MIME type (`application/pdf` → `pdf`, `application/msword` or `.docx` MIME → `doc`/`docx`).
>      b. Stream-upload to R2 via `@aws-sdk/client-s3` `PutObjectCommand` (the `Upload` helper from `@aws-sdk/lib-storage` handles streaming). `ContentType` from the file. Server-side: validate MIME is in allow-list `['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']`. Reject with 422 if not.
>      c. `UPDATE signup_requests SET cv_file_key = $1 WHERE id = $2`.
>    - **Notify all admins**: `SELECT id FROM staff WHERE role = 'admin' AND active = true AND deleted_at IS NULL`. For each, `notificationService.create({ recipientId: adminId, type: 'signup_request', title: 'New access request from ' + name, data: { requestId, roleRequested } })`. Sprint 2 builds `NotificationService` — use a placeholder method here that logs the intent (same swap-in pattern as audit log in STEP 5).
>    - Return `{ requestId, status: 'pending' }`.
>
> 3. **Route `POST /v1/auth/signup/request`** in `apps/api/src/routes/auth/signup-request.ts`:
>    - Public (no `verifyJwt`).
>    - Use Fastify's multipart in iteration mode: `for await (const part of request.parts())`. Build a `formFields` object from text fields, set aside the file part if present.
>    - After all parts read, validate `formFields` against `SignupRequestSchema`. If fails, 400 with Zod issues.
>    - Call `authService.signupRequest(parsed, filePart?.file)`.
>    - On `ALREADY_PROCESSED`, respond 409 `{ code: 'ALREADY_PROCESSED', message: 'A request or account already exists for this email.' }`.
>    - On success, respond 201 `{ requestId, status: 'pending' }`.
>
> 4. **Tests `apps/api/src/services/AuthService.signup-request.test.ts`**:
>    - Submit valid form (no CV) → row created, status pending, notifications enqueued for all admins.
>    - Submit valid form with PDF CV (use a tiny fixture PDF in `apps/api/test/fixtures/cv.pdf`) → row created, R2 PutObject called with key matching `cvs/requests/<uuid>/cv.pdf`. Mock the S3 client; assert command params.
>    - Submit form with invalid MIME (text/plain) → 422.
>    - Submit form with file > 5MB → 413 (let the multipart limit do its job; assert the error surfaces).
>    - **H-04 test #1**: insert a `staff` row first with the same email, then submit signup → `ALREADY_PROCESSED`.
>    - **H-04 test #2**: insert a soft-deleted staff row (deleted_at NOT NULL), submit signup → `ALREADY_PROCESSED`.
>    - **H-04 test #3** (race condition): insert a pending `signup_requests` row, submit a second pending for the same email → `ALREADY_PROCESSED` (caught from the unique index, error code 23505).
>    - **Admin notifications test**: assert N notification "create" intents for N admins.
>
> **RULES**
>
> - The `roleRequested` enum in `SignupRequestSchema` already excludes 'admin' — but defense in depth: assert this in the service too. If somehow `'admin'` slips in (manual API call), throw 422 `INVALID_ROLE`.
> - R2 keys are immutable once written. Don't overwrite. If a row already has `cv_file_key` (shouldn't happen on first insert), don't re-upload.
> - The multipart stream-to-R2 must not buffer the entire file in memory. Use `@aws-sdk/lib-storage`'s `Upload` class which handles multipart upload for streams.
> - When mocking the S3 client in tests, use `@aws-sdk/client-mock` (`aws-sdk-client-mock` package). It's the standard mocking lib for v3 clients.
> - Don't return `cv_file_key` to the user. It's an internal R2 key; the user shouldn't even know R2 exists.
> - **Verify before moving on.** Show me the service method first. Then route. Then tests.
>
> Start with `AuthService.signupRequest()`.

**Verify:**

```bash
cd apps/api
pnpm test services/AuthService.signup-request.test
```

All tests pass. Then a manual test (no auth needed — it's a public endpoint):

```bash
# No CV
curl -X POST http://localhost:3001/v1/auth/signup/request \
  -F "name=Test User" \
  -F "email=newuser@example.com" \
  -F "dateOfBirth=1995-06-15" \
  -F "mobileNumber=+919876543210" \
  -F "roleRequested=team_member" \
  -F "message=Hi, I'd like to join Skaly."

# With CV
curl -X POST http://localhost:3001/v1/auth/signup/request \
  -F "name=Test User Two" \
  -F "email=newuser2@example.com" \
  -F "dateOfBirth=1995-06-15" \
  -F "mobileNumber=+919876543210" \
  -F "roleRequested=team_member" \
  -F "cv=@/path/to/some/test.pdf"

# Duplicate (should 409)
# Re-run the first command. Expect 409 ALREADY_PROCESSED.
```

Open Postgres and confirm:
```sql
SELECT id, name, email, role_requested, cv_file_key, status FROM signup_requests;
```

---

## SPRINT 1 — STEP 7: Admin approve/reject (M-02 + rejection privacy)

**Goal:** Admin approves a signup request → Supabase user created → staff row created → **attendance backfilled in the same transaction** (M-02). Admin rejects → `rejection_note` stored internally, `public_rejection_message` sent in notification. Both flows are admin-only and audit-logged.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 7. Self-signup creates pending requests. Now admins act on them.
>
> **WHAT TO BUILD**
>
> 1. **A skeleton `AttendanceService.backfillCurrentPeriod(staffId, trx)`** in `apps/api/src/services/AttendanceService.ts`:
>    - Real implementation comes in Sprint 3, but Sprint 1 must call it. Build the method now with the M-02-specific logic:
>      ```ts
>      async backfillCurrentPeriod(staffId: string, trx: Transaction<DB>) {
>        // Find the current active period
>        const period = await trx.selectFrom('months')
>          .where('is_current', '=', true)
>          .where('status', '=', 'active')
>          .selectAll()
>          .executeTakeFirstOrThrow();
>        // Generate working-day rows from today through period.end_date
>        const today = new Date(); // server time, IST via TZ env
>        const days = generateWorkingDays(today, period.end_date); // exclude Sundays + existing holidays
>        const holidayDates = await trx.selectFrom('holidays')
>          .where('period_id','=',period.id)
>          .select('date')
>          .execute();
>        const holidaySet = new Set(holidayDates.map(h => h.date.toISOString().slice(0,10)));
>        const rows = days
>          .filter(d => !holidaySet.has(d.toISOString().slice(0,10)))
>          .map(d => ({ id: crypto.randomUUID(), staff_id: staffId, period_id: period.id, date: d, status: 'pending', work_log: null, version: 1 }));
>        if (rows.length) await trx.insertInto('attendance_logs').values(rows).execute();
>        return rows.length;
>      }
>      ```
>    - Add an internal helper `generateWorkingDays(from, to)` that returns an array of `Date` objects, excluding Sundays.
>    - This is enough for M-02. Sprint 3 will expand the service with the full grid + update logic.
>
> 2. **`AuthService.approveSignupRequest(requestId, roleAssigned, reviewerStaffId)`**:
>    - Inside one transaction:
>      a. `SELECT * FROM signup_requests WHERE id = $1 FOR UPDATE`. If not found, 404. If `status !== 'pending'`, 409 `ALREADY_REVIEWED`.
>      b. **H-04 backstop**: re-check `SELECT 1 FROM staff WHERE email = $1`. If exists (race condition since the pending row was created), throw `ALREADY_PROCESSED` and mark the signup row as rejected with an internal note "Account already exists at approval time". This is the audit's emphasis that H-04 isn't a one-shot check — every entry path enforces it.
>      c. Call `supabaseAdmin.auth.admin.createUser({ email: row.email, email_confirm: true, user_metadata: { name: row.name } })` — **no password**. The new user must use password reset to set their own. The notification we send includes the reset link.
>      d. Insert `staff`: `{ supabase_uid, name, email, role: roleAssigned, date_of_birth, mobile_number, active: true, mfa_enrolled: false }`.
>      e. **M-02 critical**: `await attendanceService.backfillCurrentPeriod(newStaffId, trx)` — same `trx`.
>      f. `UPDATE signup_requests SET status='approved', role_assigned=$1, reviewed_at=NOW(), reviewed_by=$2 WHERE id=$3`.
>      g. Send the new staff member a password setup email: `await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email: row.email })` → email with reset link. (Supabase's branded recovery template covers this.)
>      h. Notify the **requesting user** with type `signup_approved`. (Notification recipient lookup: the request has no staff_id yet, so the notification fires at the newly-created `staff.id`.)
>      i. Audit log: `signup_request.approve`.
>    - Return `{ staffId, supabaseUid, attendanceRowsCreated: <count> }`.
>
> 3. **`AuthService.rejectSignupRequest(requestId, rejectionNote, publicRejectionMessage, reviewerStaffId)`**:
>    - Inside one transaction:
>      a. `SELECT * FROM signup_requests WHERE id = $1 FOR UPDATE`. If not found, 404. If `status !== 'pending'`, 409 `ALREADY_REVIEWED`.
>      b. `UPDATE signup_requests SET status='rejected', rejection_note=$1, public_rejection_message=$2, reviewed_at=NOW(), reviewed_by=$3 WHERE id=$4`.
>      c. **No Supabase user, no staff row, no attendance backfill.** Reject is terminal.
>      d. The `/signup/pending` page is polling. When the next poll reads `status='rejected'`, the API response includes ONLY `public_rejection_message` (see route below). `rejection_note` is NEVER returned.
>      e. Audit log: `signup_request.reject` — include `rejection_note` in the `after` field of the audit row (admins reading audit log can see it; the rejected user cannot since they have no JWT).
>    - Return `{ status: 'rejected' }`.
>
> 4. **Route `POST /v1/auth/signup-requests/:id/approve`** — admin only.
>    - Body: `SignupApproveSchema` (`{ roleAssigned }`).
>    - Calls `authService.approveSignupRequest(...)`.
>    - 200 with `{ staffId, attendanceRowsCreated }`.
>
> 5. **Route `POST /v1/auth/signup-requests/:id/reject`** — admin only.
>    - Body: `SignupRejectSchema`.
>    - Calls `authService.rejectSignupRequest(...)`.
>    - 200 with `{ status: 'rejected' }`. Response body **does not** echo `rejectionNote`.
>
> 6. **Route `GET /v1/settings/signup-requests`** — admin only.
>    - Query params: `?status=pending|approved|rejected|all` (default `pending`).
>    - Returns `[{ id, name, email, dateOfBirth, mobileNumber, roleRequested, message, cvFileKey, status, createdAt, reviewedAt, reviewedBy: { id, name } | null, publicRejectionMessage }]`. **Note**: this is for admins, so `rejectionNote` is also included here (admin can see their own internal note). The privacy rule is only about the **rejected user's** poll endpoint not seeing it.
>
> 7. **Route `GET /v1/auth/signup-requests/me/status?email=`** — public (poll endpoint used by `/signup/pending`).
>    - Query: `?email=<the email the user submitted>`.
>    - Returns: `{ status, publicRejectionMessage: null | string, submittedAt }`. **Crucially**: shape **never** includes `rejectionNote`. The Zod response schema for this endpoint explicitly omits it; serialization is gated on that schema.
>    - Rate-limit this endpoint aggressively: 10 req/min per IP. The frontend polls every 10–60s so even a slow poller is fine; this is to stop scraping.
>
> 8. **Route `GET /v1/auth/signup-requests/:id/cv`** — admin only. Returns a presigned R2 download URL with 1-hour TTL.
>
> 9. **Tests `apps/api/src/services/AuthService.approve-reject.test.ts`**:
>    - **Approve happy path**: pending request → approve → Supabase admin createUser called, staff row exists, signup_requests.status='approved', attendance rows generated for current period.
>    - **M-02 critical test**: approve mid-period. Compute expected attendance row count (days remaining excluding Sundays/holidays). Assert exact count from `attendance_rows_created`.
>    - **M-02 transaction atomicity test**: force the staff insert to fail (e.g., violate a constraint by injecting a duplicate `supabase_uid`). Assert: no signup_requests update, no attendance rows. Rollback complete.
>    - **Reject happy path**: pending → reject → signup_requests row has rejection_note + public_rejection_message; no Supabase user, no staff row.
>    - **Rejection privacy contract** (the most important test of this sprint):
>      ```ts
>      it('GET /v1/auth/signup-requests/me/status NEVER returns rejection_note', async () => {
>        const req = await fixtures.createSignupRequest({ email: 'x@y.z' });
>        await fixtures.rejectSignupRequest(req.id, {
>          rejectionNote: 'INTERNAL: profile incomplete + suspect resume',
>          publicRejectionMessage: 'Thanks for applying. We are not moving forward at this time.',
>        });
>        const res = await app.inject({
>          method: 'GET',
>          url: '/v1/auth/signup-requests/me/status?email=x@y.z'
>        });
>        const body = JSON.parse(res.payload);
>        expect(body).not.toHaveProperty('rejectionNote');
>        expect(body).not.toHaveProperty('rejection_note');
>        expect(body.publicRejectionMessage).toBe('Thanks for applying. We are not moving forward at this time.');
>        expect(JSON.stringify(body)).not.toContain('INTERNAL');
>      });
>      ```
>    - Approve as non-admin → 403.
>    - Approve already-reviewed request → 409 `ALREADY_REVIEWED`.
>    - Reject already-reviewed → 409.
>    - Admin GET signup-requests returns rejection_note (admin can see it).
>
> **RULES**
>
> - `attendanceService.backfillCurrentPeriod` is called **inside** the same transaction as the staff insert. Not after. Not in a `setImmediate`. Same `trx`. If either fails, both roll back.
> - The audit log's `actor_id` for approval is `reviewerStaffId` (the admin's id), `actor_source='web'`. Per audit C-04 from Sprint 0.
> - The rejected-user poll endpoint's Zod **response schema** has `rejectionNote: z.never()` — making it a TypeScript impossibility to leak. The schema is in `packages/shared/src/schemas/auth.ts` (add it now).
> - Don't return `cvFileKey` to the user; only admins ever see it (via the dedicated CV-download endpoint).
> - **Verify before moving on.** Show me `approveSignupRequest` first. I'll review the M-02 transaction structure. Then `rejectSignupRequest`. Then routes. Then tests. The rejection-privacy test is the linchpin — run that one specifically before moving on.
>
> Start with the AttendanceService stub.

**Verify:**

```bash
cd apps/api
pnpm test services/AuthService.approve-reject.test

# The rejection-privacy test specifically:
pnpm test -t "rejection_note"
```

All green. Manually:

```bash
# As admin (use the token from STEP 5 verify), approve a pending signup
curl -X POST http://localhost:3001/v1/auth/signup-requests/<request-id>/approve \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"roleAssigned":"team_member"}'
```

Open Postgres:
```sql
SELECT status, reviewed_at FROM signup_requests WHERE id = '<request-id>';
SELECT COUNT(*) FROM attendance_logs WHERE staff_id = (SELECT id FROM staff WHERE email = '<requested-email>');
```

The attendance count should be > 0 (depends on day of month).

---

## SPRINT 1 — STEP 8: Password reset, session, MFA endpoints

**Goal:** Password reset email → set new password. Session refresh + sign out. MFA enroll (returns QR code data URL + recovery codes), verify (consumes a 6-digit code), reset (admin-only).

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 8. Invite + self-signup work. Now session + password + MFA.
>
> **WHAT TO BUILD**
>
> 1. **`AuthService.requestPasswordReset(email)`** — public. Look up the staff row by email (active only). If found, call `supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: 'http://localhost:3000/reset-password' } })`. **If not found, return 200 anyway** with a fake success response (don't leak which emails are in the system — standard anti-enumeration practice). Audit-log either way.
>
> 2. **`AuthService.confirmPasswordReset(token, newPassword)`** — this is a thin wrapper. The actual password update happens via Supabase's recovery flow; the frontend uses `supabase.auth.updateUser({ password })` after the recovery token sets a session. Our backend's role here is just to log the action when called explicitly. Route is optional.
>
> 3. **`AuthService.refreshSession(refreshToken)`** — calls `supabaseAdmin.auth.refreshSession({ refresh_token: refreshToken })`. Returns new `{ accessToken, refreshToken, expiresAt }`. On failure, 401 `INVALID_REFRESH_TOKEN`.
>
> 4. **`AuthService.signOut(supabaseUid)`** — calls `supabaseAdmin.auth.admin.signOut(supabaseUid)` (Supabase >= 2.40 signature; if your installed version's signature differs, check the SDK — the v2 SDK uses `signOut(jwt)` taking the user's JWT, not UID; fall back to that). Also `invalidateStaffCache(supabaseUid)`. Returns 204.
>
> 5. **`AuthService.enrollMfa(staffId, supabaseUid)`**:
>    - Call `supabaseAdmin.auth.admin.mfa.enrollFactor({ userId: supabaseUid, factorType: 'totp', friendlyName: 'Scaly Portal Authenticator' })`. (Check exact Supabase Admin API method name in your installed SDK version — it's been `mfa.enroll` and `mfa.enrollFactor` at different points. If the admin-API surface doesn't expose MFA enroll, you may need to use the client SDK with the user's session token instead — fall back to returning the QR + secret from the user's own enrollment.)
>    - The response from Supabase includes a `totp` object: `{ qr_code, secret, uri }`. `qr_code` is already a `data:image/png;base64,...` string per Supabase docs.
>    - Generate 10 recovery codes: `Array.from({length:10}, () => crypto.randomBytes(5).toString('hex'))`. Store as hashed values in a new table `mfa_recovery_codes` — **but** that table isn't in the schema. **For MVP**: store recovery codes as a comma-separated hashed list in `staff.mfa_recovery_codes_hashed` (JSON column). If this column isn't in the schema either, then for MVP recovery is handled via admin reset (which clears the factor and starts over). Return an empty array for `recoveryCodes` and document the limitation in the next sprint's notes.
>    - **Do not yet flip `staff.mfa_enrolled = true`** — that happens only after `verifyMfa` confirms the user has a working code.
>    - Return `{ factorId, qrCodeDataUrl: response.totp.qr_code, secret: response.totp.secret, recoveryCodes: [] }`.
>
> 6. **`AuthService.verifyMfa(staffId, supabaseUid, factorId, code)`**:
>    - Frontend has already done the Supabase challenge + verify dance (`supabase.auth.mfa.challenge` then `supabase.auth.mfa.verify`). Our backend's role is to flip the staff flag and audit-log.
>    - Re-verify the code server-side for safety: `supabaseAdmin.auth.admin.mfa.verifyFactor({ ... })` — if the SDK exposes this. If not, trust the client (the client's own verify call against Supabase is server-validated by Supabase).
>    - `UPDATE staff SET mfa_enrolled = true WHERE id = $1`.
>    - `invalidateStaffCache(supabaseUid)`.
>    - Audit log: `mfa.enroll`.
>    - Return 204.
>
> 7. **`AuthService.resetMfa(targetStaffId, adminId)`**:
>    - Admin-only path. Used when a user loses their authenticator.
>    - Fetch target staff. `supabaseAdmin.auth.admin.mfa.deleteFactor({ userId: supabase_uid, factorId: <enumerate factors first> })` — or call `listFactors` then delete each.
>    - `UPDATE staff SET mfa_enrolled = false WHERE id = $1`.
>    - `invalidateStaffCache(targetStaff.supabase_uid)`.
>    - Audit log.
>    - Return 204.
>
> 8. **Routes:**
>    - `POST /v1/auth/password-reset` — public, body `{ email }`. → 200 always (anti-enumeration).
>    - `POST /v1/auth/refresh` — public, body `{ refreshToken }`. → new session or 401.
>    - `DELETE /v1/auth/session` — `verifyJwt`. → 204.
>    - `POST /v1/auth/mfa/enroll` — `verifyJwt`. → `MfaEnrollResponseSchema`.
>    - `POST /v1/auth/mfa/verify` — `verifyJwt`, body `MfaVerifySchema`. → 204.
>    - `PUT /v1/staff/:id/mfa/reset` — `requireRole('admin')`. → 204.
>
> 9. **`GET /v1/staff/me`** — `verifyJwt`. Returns the C-04 shape from Sprint 0 (Sprint 0 STEP 14 patched this — verify it's in place and now returns the full `StaffMeResponseSchema` shape including computed `permissions`). The permissions map for Sprint 1 can be hard-coded based on role (the per-user override system comes in Sprint 11) — `getEffectivePermissions(staffId)` returns a baseline derived from `docs/08-AUTH-MATRIX.md`.
>
> 10. **Tests `apps/api/src/services/AuthService.session-mfa.test.ts`**:
>    - Password reset for known email → 200, `generateLink` called.
>    - Password reset for unknown email → 200 (anti-enumeration), `generateLink` NOT called.
>    - Refresh with valid refresh token → new session.
>    - Refresh with invalid → 401.
>    - Sign out → 204, `staff_lookup:{uid}` is cleared from Redis.
>    - MFA enroll → returns QR data URL starting with `data:image/png;base64,`, returns factorId, `mfa_enrolled` flag is STILL `false` in DB.
>    - MFA verify → `mfa_enrolled` flag is now `true`.
>    - MFA reset (admin) → flag returns to `false`, factor deleted in Supabase.
>    - GET /v1/staff/me returns role+permissions per AUTH-MATRIX baseline.
>
> **RULES**
>
> - Anti-enumeration on password reset: even the response timing must look the same for known/unknown emails. Add a `setTimeout(0)` or actually call a no-op-async to keep wall time consistent across both paths.
> - Don't return the raw `recoveryCodes` to the user more than once (the enroll response). They go into the user's password manager / printed sheet. There's no "show me my codes again" endpoint.
> - The hard-coded permissions map in `getEffectivePermissions(staffId)` for Sprint 1 should be a separate function in `apps/api/src/lib/permissions.ts` so Sprint 11 (overrides) can wrap it.
> - **Verify before moving on.** Show me each service method as you go. Then routes. Then tests.
>
> Start with `requestPasswordReset` and `refreshSession`. Show me those two.

**Verify:**

```bash
cd apps/api
pnpm test services/AuthService.session-mfa.test
```

All green.

---

## SPRINT 1 — STEP 9: Route registration + full integration test pass

**Goal:** Every auth route from API Contract §1 is registered, listed on `/docs` (Swagger UI from M-12 in Sprint 0), and passing one consolidated integration test that walks the entire user lifecycle.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 9. All services and routes are built. Time to wire them into the app and write a single end-to-end integration test that proves the whole picture works.
>
> **WHAT TO BUILD**
>
> 1. **Route registration in `apps/api/src/app.ts`:**
>    ```ts
>    await app.register(authPlugin);
>    await app.register(import('./routes/auth/index.js'), { prefix: '/v1' });
>    await app.register(import('./routes/staff/index.js'), { prefix: '/v1' });
>    await app.register(import('./routes/settings/index.js'), { prefix: '/v1' });
>    ```
>    Each `routes/<area>/index.ts` is an autoload that registers all sibling route files.
>
> 2. **Swagger UI verification** — `M-12`:
>    Run `pnpm dev` then open `http://localhost:3001/docs`. Every route from API Contract §1 should be listed with:
>    - Correct HTTP method.
>    - Body schema (Zod-derived).
>    - Response schema.
>    - Security (Bearer token icon) for protected routes.
>    Take a screenshot. Paste into the commit message for the human reviewer.
>
> 3. **End-to-end integration test `apps/api/test/integration/auth-lifecycle.test.ts`**:
>
>    ```ts
>    describe('Auth lifecycle', () => {
>      it('walks invite → signup → login → mfa enroll → mfa verify → sign out → password reset → sign in again', async () => {
>        const app = await buildTestApp();
>        const adminToken = await fixtures.createAdminAndGetToken();
>
>        // 1. Admin invites a new team member
>        const inviteRes = await app.inject({
>          method: 'POST', url: '/v1/auth/invite',
>          headers: { authorization: `Bearer ${adminToken}` },
>          payload: { email: 'lifecycle@example.com', role: 'team_member' }
>        });
>        expect(inviteRes.statusCode).toBe(201);
>        const { token: inviteToken } = JSON.parse(inviteRes.payload);
>
>        // 2. New user consumes the invite
>        const signupRes = await app.inject({
>          method: 'POST', url: '/v1/auth/signup/invite',
>          payload: {
>            token: inviteToken, password: 'TestPass123!',
>            name: 'Lifecycle Tester', dateOfBirth: '1995-01-01',
>            mobileNumber: '+919876543210',
>          }
>        });
>        expect(signupRes.statusCode).toBe(201);
>
>        // 3. New user logs in (via Supabase directly in test — mocked)
>        const userToken = await fixtures.signInAndGetToken('lifecycle@example.com', 'TestPass123!');
>
>        // 4. GET /v1/staff/me returns the right shape
>        const meRes = await app.inject({
>          method: 'GET', url: '/v1/staff/me',
>          headers: { authorization: `Bearer ${userToken}` }
>        });
>        const me = JSON.parse(meRes.payload);
>        expect(me.role).toBe('team_member');
>        expect(me.mfaEnrolled).toBe(false);
>
>        // 5. Admin tries to access team-only signup-requests — should be allowed (admin)
>        // 6. Team member tries admin-only endpoint — should 403
>        const forbiddenRes = await app.inject({
>          method: 'POST', url: '/v1/auth/invite',
>          headers: { authorization: `Bearer ${userToken}` },
>          payload: { email: 'x@y.z', role: 'team_member' }
>        });
>        expect(forbiddenRes.statusCode).toBe(403);
>
>        // 7. Self-signup with the same email — H-04
>        const dupRes = await app.inject({
>          method: 'POST', url: '/v1/auth/signup/request',
>          payload: { /* fields with same email */ }
>        });
>        expect(JSON.parse(dupRes.payload).code).toBe('ALREADY_PROCESSED');
>
>        // 8. Deactivate the user (admin), they get ACCOUNT_DEACTIVATED on next request
>        // (the deactivate route is Sprint 11, so stub it here with a direct DB update)
>        await db.updateTable('staff')
>          .set({ active: false })
>          .where('email', '=', 'lifecycle@example.com')
>          .execute();
>        await fixtures.invalidateCache(me.id);
>        const deactRes = await app.inject({
>          method: 'GET', url: '/v1/staff/me',
>          headers: { authorization: `Bearer ${userToken}` }
>        });
>        expect(deactRes.statusCode).toBe(403);
>        expect(JSON.parse(deactRes.payload).code).toBe('ACCOUNT_DEACTIVATED');
>      });
>    });
>    ```
>
> 4. **Run the full test suite:**
>    ```bash
>    pnpm --filter @skaly/api test
>    ```
>    All green. If any cross-test pollution issues (a previous test leaves data that breaks the next), fix the test setup to truncate tables between tests using `TRUNCATE staff, signup_requests, invite_links, attendance_logs RESTART IDENTITY CASCADE;` in a `beforeEach`.
>
> **RULES**
>
> - All routes register without errors at boot.
> - `/docs` lists all auth routes.
> - The lifecycle test runs end-to-end without manual setup beyond `fixtures.createAdminAndGetToken`.
> - **Verify before moving on.** Run the test suite and paste the output. If anything's red, fix before frontend work.
>
> Start with `routes/auth/index.ts` and the app.ts registration.

**Verify:**

```bash
cd apps/api
pnpm dev   # terminal 1
curl http://localhost:3001/docs   # terminal 2 — should return Swagger UI HTML
# In a browser, hit http://localhost:3001/docs — visual check that all auth routes are listed.

# Stop dev, run tests:
pnpm --filter @skaly/api test
```

All green. **Backend is now Sprint-1-complete.** Move to frontend.

Commit checkpoint:
```bash
git add apps/api packages/shared
git commit -m "Sprint 1 backend: auth plugin, invite + self-signup + approve/reject + MFA + session (H-04, M-02)"
git push
```

---

## SPRINT 1 — STEP 10: Frontend shadcn install + auth route group

**Goal:** Install the shadcn components Sprint 1 uses. Create the `(auth)` route group with a shared layout (split-screen with brand panel on left, form on right — the T1 fallback).

### 10.1 — Install shadcn components

In Antigravity terminal:

```bash
cd apps/web
npx shadcn@latest add button input label form card dialog alert dropdown-menu toast tabs separator badge sonner avatar input-otp
```

**Note on `input-otp`**: shadcn ships this as a wrapper around the [input-otp](https://github.com/guilhermerodz/input-otp) library. It handles the 6-digit MFA code entry with cursor jumps. If `input-otp` isn't yet in shadcn's registry at the time you run this, install manually: `pnpm add input-otp`, then copy the component from shadcn's docs into `apps/web/src/components/ui/input-otp.tsx`.

**Note on `sonner`**: this is shadcn's recommended toast library (replacing the older `toast`). The `add toast sonner` combo gives you both shapes — pick `sonner` for new code.

After install, you should have new files under `apps/web/src/components/ui/`. List them:

```bash
ls apps/web/src/components/ui/
```

Should include: `button.tsx`, `input.tsx`, `form.tsx`, `card.tsx`, `dialog.tsx`, `alert.tsx`, `dropdown-menu.tsx`, `toast.tsx` or `sonner.tsx`, `tabs.tsx`, `separator.tsx`, `badge.tsx`, `avatar.tsx`, `input-otp.tsx`, `label.tsx`.

### 10.2 — Auth layout + brand panel (prompt)

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 10.2. Backend is complete. shadcn components installed in `apps/web/src/components/ui/`. Now I'm building the shared layout for all auth pages.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/src/app/(auth)/layout.tsx`** — a route-group layout for `/login`, `/signup`, `/signup/invite`, `/signup/pending`, `/forgot-password`, `/reset-password`, `/mfa-setup`. Per `docs/03-UIUX.md` §2:
>    - Split-screen: left 40% is the brand panel (gold accent, Skaly lion mark, tagline), right 60% is the form area (white background, max-width 480px, centred vertically).
>    - On mobile (`< 768px`), the brand panel collapses to a slim top bar with just the logo.
>    - Layout uses Tailwind 4 `@theme` tokens from Sprint 0 STEP 3 `globals.css`: `bg-background`, `text-foreground`, `bg-gold` (the `#FDC257` token).
>
> 2. **`apps/web/src/components/auth/brand-panel.tsx`** — the left panel:
>    - Black background.
>    - Skaly lion mark SVG (placeholder if not yet received — use the gold-tint circle from `apps/web/public/brand/placeholder-mark.svg`).
>    - Tagline below: "Operations, organised." (in `Big Shoulders Display`, gold).
>    - Bottom-left: small text "© Skaly Group · Internal Portal".
>
> 3. **`apps/web/src/lib/supabase/client.ts`** — a typed wrapper around `@supabase/ssr`'s `createBrowserClient`. Sprint 0 stubbed this; ensure it returns a singleton (don't create a new client on every render).
>
> 4. **`apps/web/src/lib/supabase/server.ts`** — `createServerClient` for use in Server Components and middleware. Reads cookies via `next/headers`.
>
> 5. **`apps/web/src/lib/api.ts`** — a small fetch wrapper:
>    ```ts
>    export async function api<T>(path: string, init?: RequestInit): Promise<T> {
>      const supabase = createBrowserClient(...);
>      const { data: { session } } = await supabase.auth.getSession();
>      const token = session?.access_token;
>      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
>        ...init,
>        headers: {
>          ...(init?.headers ?? {}),
>          ...(token ? { authorization: `Bearer ${token}` } : {}),
>          ...(init?.body && !(init.body instanceof FormData)
>            ? { 'content-type': 'application/json' }
>            : {}),
>        },
>        credentials: 'include',
>      });
>      if (!res.ok) {
>        const error = await res.json().catch(() => ({ code: 'UNKNOWN' }));
>        throw new ApiError(res.status, error.code, error.message);
>      }
>      return res.json() as Promise<T>;
>    }
>    ```
>    `ApiError` is a custom class with `status`, `code`, `message`. Forms switch on `error.code` for inline messaging.
>
> 6. **`apps/web/src/components/providers.tsx`** — wraps the app in TanStack Query's `QueryClientProvider`, `Sonner` toaster, and a `<ThemeProvider>` from `next-themes` if needed (we're not switching themes for the portal but it's cheap to include).
>
> **RULES**
>
> - The brand panel must work without the Skaly lion SVG (graceful placeholder).
> - The form column is exactly `max-w-[480px]` and `mx-auto`.
> - Tailwind tokens come from `globals.css` `@theme`. Don't hardcode colors.
> - Don't import Supabase server client from any client component (Next 15 will error). Server client = Server Components + Route Handlers + Middleware only.
> - **Verify before moving on.** Boot `pnpm dev` and visit `http://localhost:3000/login` (404 is expected — no page yet, but the layout should render if you create a temp file `app/(auth)/login/page.tsx` with `export default function() { return <div>login placeholder</div> }`). Confirm split-screen renders.
>
> Start with `layout.tsx`.

**Verify:**

`pnpm dev`, visit `http://localhost:3000/login` (after creating the temp placeholder). Split-screen visible. Brand panel on left. Form panel on right with placeholder text.

---

## SPRINT 1 — STEP 11: `/login` page (email/password + Google)

**Goal:** Users land at `/login`, enter email + password, get redirected to `/` on success. Or they click "Continue with Google" and complete OAuth. Deactivated accounts surface the right error. Admin/manager without MFA get redirected to `/mfa-setup`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 11. Auth layout exists. Now the login page.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/src/app/(auth)/login/page.tsx`** (Client Component):
>    - Title: "Welcome back" in `Big Shoulders Display`.
>    - Email + password inputs, validated with `react-hook-form` + `@hookform/resolvers/zod` against `LoginEmailSchema`.
>    - "Continue with Google" button using `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/auth/callback' } })`.
>    - Below: "[Request access →]" link to `/signup`.
>    - Below that: "[Forgot password?]" link to `/forgot-password`.
>
> 2. **Login submit handler:**
>    ```ts
>    async function onSubmit({ email, password }) {
>      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
>      if (error) {
>        // Map Supabase errors:
>        if (error.message.includes('Invalid login credentials')) {
>          form.setError('root', { message: 'Email or password is incorrect.' });
>        } else if (error.message.includes('Email not confirmed')) {
>          form.setError('root', { message: 'Please confirm your email before logging in.' });
>        } else {
>          form.setError('root', { message: 'Something went wrong. Try again.' });
>        }
>        return;
>      }
>      // Logged in. Now check if the staff row exists + active.
>      try {
>        const me = await api<StaffMeResponse>('/v1/staff/me');
>        // Admin/manager without MFA → /mfa-setup
>        if ((me.role === 'admin' || me.role === 'manager') && !me.mfaEnrolled) {
>          router.push('/mfa-setup');
>          return;
>        }
>        // Admin/manager with MFA needs to pass MFA challenge (Supabase MFA AAL2 enforcement)
>        // If user has MFA factor, Supabase login returns aal=aal1; client must call mfa.challenge + mfa.verify
>        // For MVP, we redirect them to a /mfa-challenge page in STEP 13. For now, redirect to home.
>        router.push('/');
>      } catch (err) {
>        if (err instanceof ApiError && err.code === 'ACCOUNT_DEACTIVATED') {
>          await supabase.auth.signOut();
>          form.setError('root', { message: 'Account deactivated. Contact your admin.' });
>          return;
>        }
>        if (err instanceof ApiError && err.code === 'NO_STAFF_ROW') {
>          await supabase.auth.signOut();
>          form.setError('root', { message: 'No portal access for this account. If you signed up, your request may still be pending review.' });
>          return;
>        }
>        form.setError('root', { message: 'Could not load your profile. Try again.' });
>      }
>    }
>    ```
>
> 3. **`apps/web/src/app/auth/callback/route.ts`** (NOT inside `(auth)` group — this is at `/auth/callback` for Supabase's OAuth redirect):
>    - Route Handler (Server). Reads `code` from query params.
>    - `supabase.auth.exchangeCodeForSession(code)`. On error, redirect to `/login?error=oauth_failed`.
>    - On success, redirect to `/` (Next.js middleware will redirect to MFA if needed).
>
> 4. **Loading + error states**: button shows spinner on submit, root error renders in a `<Alert variant="destructive">` above the form.
>
> 5. **Test (Playwright)** — `apps/web/tests/auth/login.spec.ts`:
>    - Login with valid credentials → redirects to `/`.
>    - Login with invalid password → "Email or password is incorrect."
>    - Login with deactivated account → "Account deactivated. Contact your admin." (Set up the fixture by deactivating a test user in beforeEach.)
>    - Login as admin without MFA → redirects to `/mfa-setup`.
>
> **RULES**
>
> - Use `react-hook-form` (not raw `useState` per field). Sprint 4+ will share form patterns.
> - All form validation is client-side via Zod + react-hook-form. Server validates again — defense in depth.
> - Don't store the token in localStorage manually — Supabase handles that via `@supabase/ssr`. The browser client puts it in cookies.
> - The "Continue with Google" button must use the official Google "G" logo — keep an SVG at `apps/web/public/brand/google-g.svg`.
> - **Verify before moving on.** Try logging in with your seed admin user. You should land on `/` (which currently shows the placeholder "Scaly Business Portal" — we haven't built any portal pages yet, but you should see it without errors).
>
> Start with `page.tsx`.

**Verify:**

`pnpm dev`. Open `http://localhost:3000/login`. Enter your admin email + password from STEP 1.8. Click Sign In. You should land on `/` (the placeholder home page).

Try Google login: click "Continue with Google". Pick your Google account. You'll be redirected back to `/auth/callback?code=...` then onward to `/`. (Note: if your Google account email doesn't match any staff row, you'll get NO_STAFF_ROW. To test successfully, add a staff row for your Google email or use the admin user whose email matches.)

Try deactivating yourself in psql:
```sql
UPDATE staff SET active = false WHERE email = '<your-email>';
```
Sign out, sign back in. Expect "Account deactivated." error.
Re-activate:
```sql
UPDATE staff SET active = true WHERE email = '<your-email>';
```

---

## SPRINT 1 — STEP 12: `/signup` + `/signup/invite` + `/signup/pending`

**Goal:** Self-signup (PATH A Google or PATH B email form) at `/signup`. Invite-based signup at `/signup/invite?token=...`. Pending status with polling at `/signup/pending?email=...`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 12. Login works. Now signup.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/src/app/(auth)/signup/page.tsx`** (Client Component) — the self-signup form per APPFLOW §2.6:
>    - Two paths visible:
>      - PATH A: a "Continue with Google" button at top. Click → `supabase.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: origin+'/signup/oauth-complete' }})`. After OAuth, name+email are pre-filled in the form below; user completes remaining fields.
>      - PATH B: full form below — `name`, `email`, `dateOfBirth` (using a date input or shadcn calendar popover), `mobileNumber` (with +CC validation), `roleRequested` (dropdown — `team_member` default, then `manager`, `freelancer`; **admin excluded**), `message` (textarea, 500 char max), CV upload (file input, PDF/DOC/DOCX, 5MB max with client-side check).
>    - Submit → `POST /v1/auth/signup/request` as multipart (use `FormData` builder).
>    - On 201: `router.push('/signup/pending?email=' + encodeURIComponent(email))`.
>    - On 409 ALREADY_PROCESSED: inline error "An account or request already exists for this email. [Sign in →]" with link to `/login`.
>
> 2. **`apps/web/src/app/signup/oauth-complete/page.tsx`** (Route Handler or Client Component — Client is simpler):
>    - Reads the OAuth session: `supabase.auth.getSession()` → user's name+email from `session.user.user_metadata.full_name` and `session.user.email`, plus the `google_uid` from `session.user.id`.
>    - Shows the rest-of-the-fields form (DOB, mobile, role, optional CV) — name + email read-only.
>    - On submit, sends the same `POST /v1/auth/signup/request` with `googleUid` in the payload.
>    - **Important**: this page must sign the user OUT of Supabase immediately after submit. We don't want OAuth-signed-up-but-not-yet-approved users to have a session lingering — they shouldn't be able to enter the portal yet. `await supabase.auth.signOut()` before redirecting to `/signup/pending`.
>
> 3. **`apps/web/src/app/(auth)/signup/invite/page.tsx`** (Client Component for the invite path):
>    - Reads `token` from query params (`useSearchParams()`).
>    - Pre-validates the token on mount: optionally hit a `GET /v1/auth/invite/:token/check` endpoint (if backend exposes one — Sprint 1 spec doesn't require this, so for MVP just show the form and validate on submit).
>    - Shows the form: `password`, `name`, `dateOfBirth`, `mobileNumber`. (Email comes from the token's metadata; for the form it's read-only and displayed.)
>    - Submit → `POST /v1/auth/signup/invite` with token + form fields.
>    - On 201, auto-login the user: `await supabase.auth.signInWithPassword({ email, password })` (since we created the user with `email_confirm: true` in STEP 5, no confirmation step). Redirect to `/`.
>    - On 410 INVITE_EXPIRED: full-page error "This invite has expired. Contact your admin for a new one."
>    - On 409 INVITE_ALREADY_USED: "This invite has already been used. Try signing in instead."
>    - On 404 INVITE_NOT_FOUND: "We could not find this invite. The link may be invalid."
>
> 4. **`apps/web/src/app/(auth)/signup/pending/page.tsx`** (Client Component):
>    - Reads `email` from query params.
>    - Shows: name (from polling response), email, role requested, submitted timestamp, "Your request is under review. Typically reviewed same working day."
>    - Polling logic per APPFLOW §2.6: 10s → 30s → 60s → stops at 10min. Use `useEffect` with `setTimeout` chained, not `setInterval` — variable intervals.
>    - On poll response `status='approved'`: `toast.success("Your account is ready!")`, `router.push('/login')` after 2 seconds.
>    - On poll response `status='rejected'`: stop polling, show `publicRejectionMessage` in a destructive alert. (If `publicRejectionMessage` is null/empty, show generic "Your request was not approved.")
>    - "[Back to login]" button always visible.
>    - **CRITICAL**: never display `rejectionNote` even if the API leaks it (which it shouldn't per STEP 7 contract). Defense in depth: even when reading `polledData`, only access `polledData.publicRejectionMessage` — there's no code path that reads any `rejectionNote` field.
>
> 5. **Polling hook** `apps/web/src/lib/hooks/use-polling.ts`:
>    ```ts
>    export function usePolling<T>(
>      fetcher: () => Promise<T>,
>      delays: number[],     // [10000, 30000, 60000, ...]
>      shouldStop: (data: T) => boolean,
>      maxDuration: number = 10 * 60 * 1000
>    ) { ... }
>    ```
>    Returns `{ data, isPolling, stop }`.
>
> 6. **Tests:**
>    - Playwright: self-signup happy path → pending page → (manually approve in psql) → poll picks up approved → redirect to login.
>    - Playwright: rejected path → public message renders, internal note never appears in DOM.
>    - Unit (vitest): polling hook respects the delay sequence.
>
> **RULES**
>
> - Date input: shadcn doesn't ship a calendar by default but `popover` + `calendar` from `react-day-picker` is the documented combo. Install: `npx shadcn@latest add calendar popover`. Use react-day-picker v9+ (current).
> - Mobile number validation: `+CC` then 6–14 digits. Show inline format hint.
> - CV file input: client-side check size + MIME before submit, surface errors as inline form errors not toasts.
> - The OAuth-complete page MUST sign the user out before sending them to pending. We do not want the partially-onboarded user to have a valid session.
> - Polling must stop on tab hidden (`document.visibilityState !== 'visible'`) to save battery; resume on visible.
> - **Verify before moving on.** Walk the full self-signup flow with a new email. End on pending page. Then in psql manually `UPDATE signup_requests SET status='approved', role_assigned='team_member' WHERE email='<test-email>'`. Wait up to 60s. Pending page should auto-redirect.
>
> Start with `signup/page.tsx`.

**Verify:**

Walk the manual flow as described.

---

## SPRINT 1 — STEP 13: `/mfa-setup` + `/forgot-password` + `/reset-password`

**Goal:** Admin/manager set up MFA via QR code + 6-digit verify. Anyone can request a password reset and complete it via emailed link.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 13. Login + signup done. Now MFA + password reset.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/src/app/(auth)/mfa-setup/page.tsx`** (Client Component):
>    - On mount, call `POST /v1/auth/mfa/enroll` → receive `{ factorId, qrCodeDataUrl, secret, recoveryCodes }`.
>    - Display the QR code image (`<img src={qrCodeDataUrl}>`).
>    - Below: "Can't scan? Enter this code manually in your authenticator app:" + the `secret` in a monospace font with a copy button.
>    - Below that: a 6-digit code input using the `<InputOTP>` shadcn component.
>    - "Verify and complete setup" button → `POST /v1/auth/mfa/verify` with `{ factorId, code }`.
>    - On success: show the recovery codes (10 codes) in a printable format, with a "I've saved these" checkbox that must be checked before "Continue to portal" button is enabled. `router.push('/')`.
>    - Recovery codes display: `<pre>` with codes, plus a "Copy all" button and a "Download as .txt" button.
>    - If user backs out without verifying, the partial enrollment remains in Supabase but staff.mfa_enrolled stays false — they'll be re-routed to /mfa-setup on next login.
>
> 2. **`apps/web/src/app/(auth)/forgot-password/page.tsx`** (Client Component):
>    - Email input.
>    - Submit → `POST /v1/auth/password-reset` (anti-enumeration on backend means it always returns 200).
>    - Show: "If an account exists for that email, a reset link has been sent. Check your inbox." Same message in all cases.
>    - "[Back to login]" link.
>
> 3. **`apps/web/src/app/(auth)/reset-password/page.tsx`** (Client Component):
>    - This page is the target of the Supabase password recovery email link. Supabase sets a session via the URL fragment (`#access_token=...&refresh_token=...&type=recovery`). The `@supabase/ssr` client auto-consumes that on mount and creates a session.
>    - Once session exists (check via `supabase.auth.getSession()`), show the new-password form: `password` + `confirmPassword`, both validated against `PasswordResetConfirmSchema`.
>    - Submit → `supabase.auth.updateUser({ password })`. On success, `supabase.auth.signOut()` (force re-login with new password), then redirect to `/login?reset=success` which shows a toast on login page.
>    - If no session on mount (user opened the link past expiry), show "This reset link has expired or is invalid. [Request a new link →]".
>
> 4. **Tests:**
>    - MFA setup: mount the page (mock the `POST /v1/auth/mfa/enroll` to return a known QR + secret) → verify with the right code → confirm `mfa_enrolled=true` in DB.
>    - MFA setup with wrong code → form shows "Incorrect code. Try again."
>    - Forgot password: submit known email → toast shown.
>    - Forgot password: submit unknown email → identical toast (no leak).
>    - Reset password: with valid recovery session, submit new password → redirected to login. Old password no longer works.
>
> **RULES**
>
> - QR code image scaled to ~200×200px, with a min-width container so it doesn't reflow.
> - 6-digit OTP input auto-submits on the 6th digit (no extra "submit" button) — speeds up flow.
> - Recovery codes shown ONCE. The "I've saved these" checkbox gate is critical.
> - On reset-password page, don't pre-fill the email — the recovery session implicitly knows the user.
> - **Verify before moving on.** Set up MFA on your admin account. Sign out. Sign back in. You should be challenged for the 6-digit code (Supabase handles this in the login response — your login handler in STEP 11 needs an MFA-challenge branch; if you haven't built that, this step's verification only goes as far as enrolling).
>
> Start with `mfa-setup/page.tsx`.

**Verify:**

Walk through MFA setup. Open Google Authenticator (or any TOTP app), scan the QR, enter the code. You should be marked `mfa_enrolled=true` in `staff`.

Then for forgot/reset: in another browser (or incognito), go to `/forgot-password`, enter your admin email. Check your inbox. Click the link. You should land on `/reset-password` and be able to set a new password.

---

## SPRINT 1 — STEP 14: Middleware + admin signup-requests panel + session refresh

**Goal:** Next.js middleware protects every `(portal)` route, redirecting unauthenticated users to `/login`. MFA enforcement redirects admin/manager without MFA to `/mfa-setup`. Sessions silently refresh at the 55-minute mark via a client-side hook. Admin can review pending signup requests at `/settings/signup-requests`.

**Prompt:**

> **WHERE WE ARE**
>
> Sprint 1, STEP 14 — the last build step before close-out smoke test.
>
> **WHAT TO BUILD**
>
> 1. **`apps/web/middleware.ts`** (root of `apps/web`, alongside `package.json`):
>    - Uses `@supabase/ssr` `createServerClient` to read the session from cookies.
>    - Matcher: every route under `(portal)` + `/settings` + `/`. Public routes excluded: `/login`, `/signup*`, `/auth/*`, `/forgot-password`, `/reset-password`, `/_next`, `/api/*`.
>    - Logic:
>      a. If no session → redirect to `/login`.
>      b. If session, fetch `/v1/staff/me`. If 403 ACCOUNT_DEACTIVATED → sign out + redirect to `/login?error=deactivated`. If 401 NO_STAFF_ROW → same.
>      c. If role is admin or manager AND `mfaEnrolled === false` AND current path is not `/mfa-setup` → redirect to `/mfa-setup`.
>      d. Else, let the request pass.
>    - The middleware refreshes the session token automatically via `supabase.auth.getUser()` per Supabase SSR docs.
>
>    Use Next 15's middleware shape with `NextResponse.next()` returning a response that includes refreshed Set-Cookie headers from the Supabase client.
>
> 2. **`apps/web/src/lib/hooks/use-session-refresh.ts`** — client hook for silent refresh:
>    ```ts
>    export function useSessionRefresh() {
>      const supabase = createBrowserClient(...);
>      useEffect(() => {
>        const t = setInterval(async () => {
>          const { data: { session } } = await supabase.auth.getSession();
>          if (!session) return;
>          const expiresAt = session.expires_at! * 1000;
>          const msUntilExpiry = expiresAt - Date.now();
>          if (msUntilExpiry < 5 * 60 * 1000) {  // less than 5 min left
>            await supabase.auth.refreshSession();
>          }
>        }, 60 * 1000);  // check every minute
>        return () => clearInterval(t);
>      }, []);
>    }
>    ```
>    Wire this hook into `apps/web/src/components/providers.tsx` so every signed-in page gets it.
>
>    (Per IMPL-PLAN §4.2: "silent refresh at 55-minute mark". Supabase's default session is 60 min; refreshing when <5 min remain achieves the 55-min mark equivalently.)
>
> 3. **`apps/web/src/app/(portal)/settings/signup-requests/page.tsx`** (Server Component fetching initial data + Client Component for interaction):
>    - Layout: list of pending signup requests as cards.
>    - Card content: name, DOB, mobile, email, role requested, submitted relative time ("3 hours ago" via `date-fns`), message snippet, `[View CV →]` button if `cvFileKey` exists (opens presigned download URL in new tab), `[Approve]` and `[Reject]` buttons.
>    - **Approve modal**: role dropdown (defaulted to `role_requested`, admin can change; `admin` is included in the assign dropdown). `[Confirm approval]` button → `POST /v1/auth/signup-requests/:id/approve`. On success: card animates out, toast "Approved. {Name} has been notified."
>    - **Reject modal**: two textareas — "Internal note (only you see this — required)" and "Message to user (optional)". `[Confirm rejection]` button → `POST /v1/auth/signup-requests/:id/reject`. On success: card animates out, toast "Rejected. {Name} has been notified."
>    - Tab strip at top: `[Pending]` `[Approved]` `[Rejected]` — switches the `?status=` query param.
>    - Empty state: "No pending requests right now."
>
> 4. **Add the admin nav entry** in the `(portal)/settings` layout sidebar: "Signup Requests" → `/settings/signup-requests`. Admin-only visibility (check `me.role === 'admin'`).
>
> 5. **`apps/web/src/app/(portal)/page.tsx`** — the post-login home placeholder. For Sprint 1, this is just "Welcome, {name}. Module dashboards arrive in Sprint 11." Sprint 11 replaces this with the real dashboard.
>
> 6. **Tests:**
>    - Middleware: unauthenticated request to `/` → redirect to `/login`.
>    - Middleware: admin without MFA → redirect to `/mfa-setup` unless already there.
>    - Middleware: deactivated account → redirect to `/login?error=deactivated` (and signed out).
>    - Playwright: admin opens `/settings/signup-requests`, sees pending list, approves one, confirms toast. Then opens psql: confirm `signup_requests.status='approved'` and `staff` row exists.
>    - Playwright: admin rejects with note "INTERNAL: not a good fit" + public "We are not moving forward". Open the rejected user's `/signup/pending?email=...` in another browser context. Confirm "INTERNAL" string is NOT in the DOM. Public message IS in the DOM.
>
> **RULES**
>
> - The middleware runs on every protected request — keep it fast. The `/v1/staff/me` fetch must be cached on the API side (Redis `staff_lookup:{uid}` 5-min TTL handles this; ensure the middleware uses the same auth header so the API hits cache).
> - The middleware does the redirect; client-side guards are belt-and-suspenders (server side is source of truth).
> - For the signup-requests page, use TanStack Query for the request list with `staleTime: 30s` so admins approving multiple requests don't see flickers but new ones appear within 30s.
> - **Verify before moving on.** Walk the full admin approval flow end-to-end in the browser. Then walk the rejection flow and grep the DOM for "INTERNAL" (Cmd+F in browser dev tools). Must be zero matches.
>
> Start with `middleware.ts`.

**Verify:**

Walk the flow as described.

---

## SPRINT 1 — STEP 15: End-to-end smoke test + commit + close-out

**Goal:** Every Sprint 1 spec item is verified working in the browser, every test in the close-out checklist is green, the close-out commit lands on `main`.

**This is a manual step.** Tick each item.

### 15.1 — Run the full test suite

```bash
# From repo root
pnpm typecheck
pnpm lint
pnpm test
```

All three must come back green. If anything's red, fix before continuing.

### 15.2 — Manual walk-through (the full user journey)

Open three browsers (or three browser profiles, or two browsers + one incognito) so you can play multiple roles at once.

**Browser A (Admin — your seed user from STEP 1.8):**

1. `http://localhost:3000/login` → sign in with admin email + password.
2. If prompted, complete MFA setup (STEP 13 flow).
3. Land on `/` → "Welcome, Mohammed Arslaan."

**Browser B (Prospective new staff):**

4. `http://localhost:3000/signup` → fill self-signup form (use a NEW email like `test1@example.com`).
5. Submit → land on `/signup/pending?email=test1@example.com`.
6. Confirm the polling indicator runs.

**Browser A:**

7. Navigate to `/settings/signup-requests`. See the new pending request from `test1@example.com`.
8. Click `[Approve]`. Pick `team_member`. Confirm.
9. Toast: "Approved. test1 has been notified."

**Browser B (within 60 seconds):**

10. The pending page auto-redirects to `/login` with a toast: "Your account is ready!"
11. You need to set a password first since approval flow creates user without password. Check the email inbox — Supabase sent a password reset link. Click it.
12. Set a password on `/reset-password`.
13. Sign in.

**Browser C (a rejected applicant — incognito):**

14. `http://localhost:3000/signup` → submit another form with email `test2@example.com`.
15. Land on pending page.

**Browser A:**

16. Open `/settings/signup-requests` (refresh if needed).
17. `[Reject]` on `test2@example.com`. Internal: "INTERNAL: not a good fit at this time". Public: "Thanks for applying — not moving forward."
18. Submit.

**Browser C:**

19. Within 60s the pending page picks up rejection.
20. Confirms public message renders. Open browser dev tools → Elements → Cmd+F → search "INTERNAL". Must be **zero matches**.

**Browser A:**

21. Open `/settings/staff` (Sprint 11 builds the full panel; for now just verify the staff table has rows for admin + test1 via psql).

22. Test deactivation: in psql, `UPDATE staff SET active = false WHERE email = 'test1@example.com';`
23. In Browser B (test1 logged in), reload `/`. Should redirect to `/login?error=deactivated` with toast "Account deactivated. Contact your admin."
24. Re-activate: `UPDATE staff SET active = true WHERE email = 'test1@example.com';`

**Browser A (admin invite path):**

25. From terminal: `curl -X POST http://localhost:3001/v1/auth/invite -H "Authorization: Bearer <admin-jwt>" -d '{"email":"test3@example.com","role":"manager"}'` (or build a UI later).
26. Check `test3@example.com` inbox for the Supabase invite email.
27. Click the link → land on `/signup/invite?token=...`.
28. Fill form, submit. Auto-login. Land on `/`. Confirm staff row created with role=manager.
29. Confirm test3 is challenged for MFA setup (because role=manager).

### 15.3 — Close-out checklist

Check every item:

- [ ] Email/password login works.
- [ ] Google OAuth login works (assuming a staff row exists for the Google email).
- [ ] Admin invite end-to-end works.
- [ ] Self-signup with CV upload works; CV is in R2 at `cvs/requests/{requestId}/cv.pdf`.
- [ ] Self-signup without CV works.
- [ ] H-04: duplicate email submission returns ALREADY_PROCESSED.
- [ ] H-04: duplicate email of a soft-deleted user returns ALREADY_PROCESSED.
- [ ] Approve creates Supabase user + staff row + attendance backfill rows (M-02).
- [ ] M-02 transaction atomic: forced approve failure rolls everything back.
- [ ] Reject stores rejection_note in DB; never returns it in any API response (rejection privacy test green).
- [ ] Admin can see rejection_note when viewing the rejected request in `/settings/signup-requests`.
- [ ] Pending poll respects 10s → 30s → 60s schedule; stops at 10 minutes.
- [ ] MFA enroll returns QR code data URL + secret.
- [ ] MFA verify flips `staff.mfa_enrolled` to true.
- [ ] Admin/manager without MFA gets redirected to `/mfa-setup`.
- [ ] Password reset email sent (anti-enumeration: same response for known/unknown email).
- [ ] Password reset link sets a session and allows password update.
- [ ] Session silently refreshes near expiry (check Network tab for refresh requests).
- [ ] Sign out clears Redis cache (verify with `redis-cli GET staff_lookup:<uid>` after sign out — should be empty).
- [ ] Deactivated account is rejected with `ACCOUNT_DEACTIVATED` and signed out.
- [ ] Permission denied returns generic message — no role names leaked.
- [ ] Swagger UI at `/docs` lists every auth route correctly.
- [ ] All vitest tests green.
- [ ] All Playwright tests green.
- [ ] `pnpm typecheck` green.
- [ ] `pnpm lint` green.

### 15.4 — Final commit

```bash
git add .
git status   # review

git commit -m "Sprint 1: auth + signup complete (H-04, M-02, rejection privacy verified)

- Backend: Fastify auth plugin (JWT + Redis cache + RBAC factory)
- Backend: AuthService (invite, self-signup, approve, reject, MFA, sessions)
- Backend: AttendanceService.backfillCurrentPeriod stub (full impl in Sprint 3)
- Frontend: (auth) route group with brand panel, /login, /signup paths,
  /mfa-setup, /forgot-password, /reset-password, middleware, session refresh
- Frontend: /settings/signup-requests admin review panel
- Tests: unit + integration + E2E covering all spec items + audit items
- Verified: H-04 duplicate prevention, M-02 attendance backfill atomicity,
  rejection_note never transmitted to rejected users"

git push
```

Wait for CI to go green. If CI fails on something the local tests passed, it's usually:
- Missing env var in the GitHub Actions workflow → check `.github/workflows/ci.yml`.
- A flaky integration test → fix the flake, don't ignore it.

### 15.5 — Move to Sprint 2

Open `MASTER-BUILD-GUIDE-V2-FINAL.md` → PART 9 → **SPRINT 2 — DATABASE SCHEMA + API SCAFFOLD**.

The Sprint 2 driving prompt assumes:
- Sprint 1 is fully closed (every box above checked).
- `AuditService.log` is currently a placeholder — Sprint 2 builds the real one.
- `NotificationService.create` is currently a placeholder — Sprint 2 builds the real one.
- `AttendanceService.backfillCurrentPeriod` exists as a stub — Sprint 3 fleshes it out, but Sprint 2's RBAC + base service patterns will be referenced by it.

If any close-out box is unchecked, **stop**. Fix that item before Sprint 2 starts. Sprint 2 depends on a clean auth foundation.

---

## DECISIONS TO MAKE BEFORE SPRINT 2

- **T1–T4 branded auth templates (audit B-02):** Did the design lead deliver? If yes, paste HTML into Supabase email templates + restyle the auth pages. If no, log a follow-up issue for Sprint 13 retrofit.
- **Recovery codes table schema:** STEP 8 noted the MFA recovery codes are not stored persistently (no schema column). Decide before Sprint 2: either add a migration 027 to extend `staff` with `mfa_recovery_codes_hashed JSONB` OR document MFA recovery as admin-reset-only in `docs/RUNBOOK-MFA-RECOVERY.md`. Both are valid for MVP.
- **Soft-deleted staff retention policy:** When does a soft-deleted staff row get permanently purged? Sprint 13 hardening question, but the policy decision should be in writing before then. Default proposal: keep indefinitely for audit trail.

---

## TROUBLESHOOTING — SPRINT 1 SPECIFIC

### "JWS Protected Header is invalid" from jose

Usually means the JWKS URL is wrong, or Supabase has rotated keys and the cached JWKS is stale. `createRemoteJWKSet` auto-refreshes every 10 minutes by default. To force refresh during dev, restart `apps/api`.

### "redirect_uri_mismatch" from Google during OAuth

The redirect URI in your Google OAuth client doesn't match the one Supabase sends. Supabase's callback is **always** `https://<project-ref>.supabase.co/auth/v1/callback` — this is what goes in Google's authorized redirect URIs list, NOT `http://localhost:3000/auth/callback`. Common confusion.

### MFA enroll returns "MFA factors per user limit reached"

The user already has an enrolled factor. Use the admin reset endpoint (`PUT /v1/staff/:id/mfa/reset`) to clear it first.

### Self-signup form submits but the request never appears in admin panel

Check:
1. Network tab on Browser B — did `POST /v1/auth/signup/request` return 201? If 5xx, check `apps/api` logs.
2. psql: `SELECT * FROM signup_requests ORDER BY created_at DESC LIMIT 1;` — row present?
3. Admin panel uses TanStack Query with 30s staleTime. Click a column header to force refetch, or close+reopen the tab.

### CV upload succeeds but the CV link in admin panel 404s

The presigned URL endpoint signs against an R2 key; if the bucket name in env doesn't match the bucket the file was actually uploaded to, you get a sign-but-doesn't-exist mismatch. Verify `R2_BUCKET_NAME` matches in both upload and download code paths.

### "Account deactivated" error showing for an active user

The Redis cache might be stale. Invalidate: `docker exec -it skaly-portal-redis-1 redis-cli DEL "staff_lookup:<supabase-uid>"`. Then refresh.

### Middleware infinite-redirect to `/mfa-setup`

The middleware checks `mfaEnrolled` on every request; if the staff row's value is stale (cache or DB), you can get stuck. Pattern: `/mfa-setup` itself is excluded from the MFA redirect check (rule (c) in STEP 14's logic). Verify the exclusion is in place.

### Tests pass locally but fail in CI

Most common: missing env var in `.github/workflows/ci.yml`. Sprint 0 STEP 10 set up the CI workflow with a known env set; Sprint 1 added `SUPABASE_JWKS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — these need to be in the workflow file. For test envs, use mock/fake values, not your real production keys. Add via GitHub repo → Settings → Secrets and variables → Actions.

---

## END OF SPRINT 1 DETAILED GUIDE

When you commit Sprint 1 and CI goes green, you have authentication. Every subsequent sprint depends on the user actually being signed in, having the right role, and the audit chain capturing every action. The foundation you built this week is the spine of everything in the next 12 weeks.

The auth surface is the most-attacked part of any portal. The tests you wrote — especially the rejection-privacy assertion, the H-04 duplicate path, and the M-02 atomicity test — are why this stands up in production. Don't delete those tests when something flaky comes up. Fix the flake.

Sprint 2 starts with `AuditService.log` becoming real and the base service patterns getting locked in. Open `MASTER-BUILD-GUIDE-V2-FINAL.md` PART 9 → Sprint 2 when you're ready.
