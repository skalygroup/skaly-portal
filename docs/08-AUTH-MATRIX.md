# 08 — AUTH & AUTHORIZATION MATRIX
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §7, PRD §4, API-CONTRACT §3-5

---

## 1. ROLES

| Role | Code | MFA Required | Description |
|------|------|-------------|-------------|
| Operations Admin | `admin` | ✅ Mandatory | Full system access. Manages staff, clients, rollover, audit log. |
| Content Manager | `manager` | ✅ Mandatory | All operational modules + limited settings. |
| Team Member | `team_member` | ❌ Not required | Own attendance + own tasks + read-only content. |
| Freelance Videographer | `freelancer` | ❌ Not required | Own assigned shoot slots only. |

---

## 2. THREE-LAYER ENFORCEMENT

Every authenticated request passes through three sequential checks. All three must pass.

```
Layer 1 — Next.js Middleware (route protection)
  · Reads JWT from HTTP-only cookie
  · If JWT missing or expired → redirect /login
  · If JWT present and mfa_enrolled = false AND role in [admin,manager] → redirect /mfa-setup

Layer 2 — Fastify Auth Plugin (per-request)
  · Verify JWT with Supabase RS256 public key
  · 401 if invalid signature or expired
  · Look up staff row by supabase_uid (Redis cache: staff_lookup:{uid}, 5-min TTL)
  · 401 with ACCOUNT_DEACTIVATED if staff.active = false
  · Attach request.user = { staffId, role, email, mfaEnrolled }
  · Check request.user.role against route allowedRoles[] → 403 PERMISSION_DENIED if not in list

Layer 3 — Service Layer (per-operation)
  · Load per-user permission overrides: Redis perms:{staffId} (5-min TTL, DB fallback)
  · Merge with role defaults: ROLE_DEFAULTS[role][permission_key]
  · Check: does this user own the record? (attendance column, assigned task, own shoot slot)
  · Check: is target period locked? (returns 423 PERIOD_LOCKED for write operations)
  · Only on successful pass through all three: execute business logic
```

---

## 3. MODULE ACCESS MATRIX

✅ Full R/W · 👁 Read-only · 🔐 Own data only · ❌ No access · 🔧 Configurable (per-user override)

| Module / Route | admin | manager | team_member | freelancer |
|----------------|-------|---------|-------------|-----------|
| `/home` | ✅ | ✅ | ✅ | ✅ (own widgets) |
| `/attendance` | ✅ (all columns) | ✅ (all columns) | 🔐 (own column) | ❌ |
| `/tasks` | ✅ | ✅ | 🔐 (own tasks: status+result) | ❌ |
| `/shoot-planner` | ✅ | ✅ | 👁 + comments | 🔐 (own rows) + comments |
| `/content-dropper` | ✅ | ✅ | ❌ | ❌ |
| `/content-calendar` | ✅ | ✅ | 👁 + comments | ❌ |
| `/bot` | ✅ (all 22 tools) | ✅ (mutation by default) | 🔧 (query only by default) | ❌ |
| `/chat` (common) | ✅ | ✅ | ✅ | 🔧 (blocked by default) |
| `/dashboard` | ✅ (full) | ✅ (operational) | 🔐 (own data) | 🔐 (own shoots) |
| `/profile` | ✅ (own) | ✅ (own) | ✅ (own) | ✅ (own) |
| `/settings/staff` | ✅ | 👁 limited | ❌ | ❌ |
| `/settings/clients` | ✅ | ✅ | ❌ | ❌ |
| `/settings/permissions` | ✅ | ❌ | ❌ | ❌ |
| `/settings/signup-requests` | ✅ | ❌ | ❌ | ❌ |
| `/settings/holidays` | ✅ | ✅ | ❌ | ❌ |
| `/settings/months` | ✅ | ❌ | ❌ | ❌ |
| `/settings/audit-log` | ✅ | ❌ | ❌ | ❌ |
| `/settings/reports` | ✅ | ✅ | ❌ | ❌ |

**Sidebar rendering:** Routes not in a user's access set are not rendered in the sidebar navigation. Direct URL access to a forbidden route returns HTTP 403 (not a redirect).

> **Rate limiting note:** Login rate limits are keyed by `email + IP`, not IP alone. This prevents a shared office IP from blocking all staff simultaneously when 15+ people log in at 9am. See `07-API-CONTRACT.md` §2 for the full rate limit table and `keyGenerator` implementation.

---

## 4. API ENDPOINT PERMISSION MAP

### Attendance
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| GET /v1/attendance | ✅ all | ✅ all | ✅ own row per date | ❌ |
| PATCH /v1/attendance/:id | ✅ | ✅ | 🔐 own staff_id only | ❌ |
| GET/POST/DELETE /v1/holidays | ✅ | ✅ | ❌ | ❌ |

### Tasks
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| GET /v1/tasks | ✅ all | ✅ all | ✅ (can read all; edits restricted) | ❌ |
| POST /v1/tasks | ✅ | ✅ | ❌ | ❌ |
| PATCH /v1/tasks/:id | ✅ all fields | ✅ all fields | 🔐 status+result on assigned only | ❌ |
| DELETE /v1/tasks/:id | ✅ | ✅ | ❌ | ❌ |
| Task attachments | ✅ | ✅ | 🔐 own assigned tasks | ❌ |

### Shoot Planner
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| GET /v1/shoot-planner | ✅ all | ✅ all | ✅ all (read) | 🔐 own rows only |
| PATCH /v1/shoot-planner/:id | ✅ | ✅ | ❌ | ❌ |
| POST /v1/shoot-planner/:id/reset | ✅ | ✅ | ❌ | ❌ |

### Content Dropper
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| GET /v1/content-dropper | ✅ | ✅ | ❌ | ❌ |
| PATCH /v1/content-dropper/:id/stage | ✅ | ✅ | ❌ | ❌ |

### Content Calendar
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| GET /v1/content-calendar | ✅ | ✅ | ✅ (read) | ❌ |
| PATCH /v1/content-calendar/:id | ✅ | ✅ | ❌ | ❌ |

### Settings & Admin
| Endpoint | admin | manager | team_member | freelancer |
|----------|-------|---------|-------------|-----------|
| POST /v1/auth/invite | ✅ | ❌ | ❌ | ❌ |
| GET /v1/settings/signup-requests | ✅ | ❌ | ❌ | ❌ |
| POST .../approve / .../reject | ✅ | ❌ | ❌ | ❌ |
| POST .../signup-requests/:id/reinstate | ✅ | ❌ | ❌ | ❌ |
| PUT /v1/staff/:id/deactivate | ✅ | ❌ | ❌ | ❌ |
| PUT /v1/staff/:id/reactivate | ✅ | ❌ | ❌ | ❌ |
| GET /v1/staff/:id/permissions | ✅ | ❌ | ❌ | ❌ |
| PUT /v1/staff/:id/permissions/:key | ✅ | ❌ | ❌ | ❌ |
| DELETE /v1/staff/:id/permissions/:key | ✅ | ❌ | ❌ | ❌ |
| PUT /v1/staff/:id/mfa/reset | ✅ | ❌ | ❌ | ❌ |
| POST/DELETE /v1/months/:period/lock | ✅ | ❌ | ❌ | ❌ |
| GET /v1/audit-log | ✅ | ❌ | ❌ | ❌ |
| POST /v1/reports/generate | ✅ | ✅ | ❌ | ❌ |

---

## 5. BOT TOOL PERMISSION MATRIX

Default permissions by role. Admin can override any value for any user via Settings → Permissions.

| Tool Name | admin | manager | team_member | freelancer |
|-----------|-------|---------|-------------|-----------|
| `get_project_status` | ✅ | ✅ | ✅ | ❌ |
| `list_tasks` | ✅ | ✅ | 🔐 own | ❌ |
| `list_overdue_tasks` | ✅ | ✅ | 🔐 own | ❌ |
| `get_user_workload` | ✅ | ✅ | 🔐 own | ❌ |
| `get_attendance` | ✅ | ✅ | 🔐 own | ❌ |
| `get_shoot_schedule` | ✅ | ✅ | ✅ | 🔐 own |
| `get_content_pipeline` | ✅ | ✅ | ❌ | ❌ |
| `get_content_calendar` | ✅ | ✅ | ✅ | ❌ |
| `get_audit_log` | ✅ | ❌ | ❌ | ❌ |
| `get_holiday_list` | ✅ | ✅ | ✅ | ❌ |
| `get_client_summary` | ✅ | ✅ | ❌ | ❌ |
| `update_task_status` | ✅ | ✅ | 🔧 | ❌ |
| `update_pipeline_stage` | ✅ | ✅ | ❌ | ❌ |
| `update_shoot_slot` | ✅ | ✅ | ❌ | ❌ |
| `create_task` | ✅ | ✅ | ❌ | ❌ |
| `set_deadline` | ✅ | ✅ | ❌ | ❌ |
| `add_holiday` | ✅ | ✅ | ❌ | ❌ |
| `remove_holiday` | ✅ | ✅ | ❌ | ❌ |
| `assign_task` | ✅ | ✅ | ❌ | ❌ |
| `update_calendar_cell` | ✅ | ✅ | ❌ | ❌ |
| `add_client` | ✅ | ✅ | ❌ | ❌ |
| `deactivate_client` | ✅ | ❌ | ❌ | ❌ |

🔧 = admin can grant this to specific team members via per-user override

---

## 6. PERMISSION OVERRIDE SYSTEM

### 6.1 Precedence Rule
```
1. Check user_permissions table for explicit override:
   · value = TRUE  → ALLOW regardless of role default
   · value = FALSE → DENY regardless of role default
   · No row found → fall through to role default

2. Apply role default from ROLE_DEFAULTS constant in packages/shared/constants/permissions.ts

Result: per-user overrides always win over role defaults
```

### 6.2 Permission Key Naming Convention
```
bot.tool.{tool_name}           Bot AI tool access (e.g., bot.tool.create_task)
module.{module}.read           Module read access override
module.{module}.write          Module write access override
chat.access                    Common chat access (for freelancers)
report.generate                Report generation capability
months.unlock                  Month unlock capability
```

### 6.3 Redis Cache
```
Key:    perms:{staffId}
Value:  JSON array — [{ permissionKey: string, value: boolean }, ...]
TTL:    5 minutes
Invalidation: immediately on any user_permissions INSERT/UPDATE for this staffId
              Admin changes permission → Redis key deleted → next request re-loads from DB
```

---

## 7. ATTENDANCE COLUMN OWNERSHIP

Team members can edit only their own attendance column.

**Frontend (UX layer):**
```css
/* Applied to all cells where column.staffId !== currentUser.staffId */
pointer-events: none;
cursor: default;
opacity: 0.6;
```
No click event fires. No API call is made. No visual feedback for click attempts.

**Backend (security layer):**
```typescript
if (request.user.role === 'team_member') {
  const log = await db.selectFrom('attendance_logs').where('id', '=', logId).executeTakeFirstOrThrow();
  if (log.staff_id !== request.user.staffId) {
    throw new ForbiddenError('PERMISSION_DENIED', 'You can only update your own attendance');
  }
}
```
Frontend restriction is UX. Backend check is the enforceable boundary.

---

## 8. FREELANCER DATA ISOLATION

Freelancers must never see data they are not assigned to. Enforced at query level.

```typescript
// Shoot planner query — freelancer gets only assigned rows
let query = db.selectFrom('shoot_schedules').where('period', '=', period);
if (request.user.role === 'freelancer') {
  query = query.where('freelancer_id', '=', request.user.staffId);
}
const slots = await query.selectAll().execute();
```
This is not a post-fetch filter. The WHERE clause is added before the query executes.

---

## 9. JWT CLAIMS

Supabase JWT payload:
```json
{
  "sub": "supabase-user-uuid",
  "email": "sohail@skaly.in",
  "aud": "authenticated",
  "iat": 1717200000,
  "exp": 1717203600,
  "role": "authenticated"
}
```
**Note:** The `role` field in Supabase JWT is always `"authenticated"`. The portal role (`admin`, `manager`, etc.) is stored in the `staff` table and looked up via `supabase_uid` → `staff.role`.

---

## 10. MFA ENFORCEMENT

| Scenario | Behaviour |
|----------|-----------|
| Admin/Manager — first login, mfa_enrolled = false | Redirect to /mfa-setup before any portal route |
| Admin/Manager — login, mfa_enrolled = true | Redirected to TOTP verification screen after password auth |
| Team Member / Freelancer — any login | No MFA required; direct to /home |
| Admin/Manager — 3 failed MFA attempts | 15-minute lockout with code `MFA_LOCKED`. **One budget for every credential type** — TOTP and recovery-code failures share the counter (Sprint 11 STEP 8) |
| Lost authenticator | Use a recovery code at `/mfa-challenge` → *"Lost your authenticator?"*. Spending one clears the factor and routes to `/mfa-setup` to enrol a new authenticator; the remaining codes survive. If exhausted, another admin resets via Settings |
| Admin resets MFA for a user | staff.mfa_enrolled = false; user re-enrolls on next login |

> **Why a recovery code cannot simply let you in.** The portal's MFA gate reads the `aal2`
> claim on the Supabase token, and only Supabase's own challenge+verify mints it — the API
> never sees a TOTP code and cannot forge the claim. So the redeem path proves account
> ownership and clears the factor rather than "completing the session". Enrolling a new
> authenticator is also what losing the device actually requires. The rejected alternative was
> a server-side flag the middleware accepts *instead of* aal2, i.e. a second way past the MFA
> gate — and a second way past a gate is a second thing to get wrong.
>
> This closes the hole that made the row above dishonest: recovery codes had been generated
> and stored since Sprint 8 with no endpoint that could spend them, so "use recovery codes"
> resolved to "ask another admin" — which is no answer when the locked-out person is the only
> admin.
