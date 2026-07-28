# 07 — API CONTRACT / ENDPOINT SPECIFICATION
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §5, AUTH-MATRIX §3, ERROR-HANDLING §2-3, BACKEND-SCHEMA §3-5

---

## 1. API CONVENTIONS

**Base URL:** `https://api.skaly.in/v1`
**WebSocket:** `wss://api.skaly.in`
**Protocol:** HTTPS only. HTTP requests are redirected.
**Auth:** `Authorization: Bearer <access_token>` on every protected endpoint.
**Content-Type:** `application/json` for all request and response bodies (except multipart for CV upload).
**Timezone:** All datetime fields are ISO 8601 UTC. Clients convert to IST (UTC+5:30) for display.

### 1.1 Standard Response Envelopes

```json
// Success
{ "data": { ...resource }, "meta": { "version": 3, "updatedAt": "2025-06-01T12:00:00Z" } }

// Success (list)
{ "data": [ ...items ], "meta": { "total": 42, "cursor": "eyJ..." } }

// Error
{ "error": { "code": "MACHINE_CODE", "message": "Human-readable message", "details": {} } }
```
**PATCH Response Standard:**
All PATCH endpoints return the complete updated resource (full row), not just a success flag.
Response format:
```json
{ "data": { ...full updated row including new version number }, "meta": { "updatedAt": "ISO timestamp", "updatedBy": "staffId" } }
```
Frontend clients should replace the cached entry entirely with the returned data. Do not attempt to merge individual fields.

### 1.2 HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Validation failure, business rule violation |
| 401 | JWT missing / invalid / expired |
| 403 | Authenticated but insufficient permissions |
| 404 | Resource not found |
| 409 | Optimistic lock conflict (stale version) |
| 423 | Write to locked period |
| 429 | Rate limit exceeded (`Retry-After` header included) |
| 500 | Unexpected server error |
| 503 | Dependency unavailable (DB, Redis, Anthropic) |

---

## 2. RATE LIMITS

> **Key design note:** The login endpoint must NOT be rate-limited by IP address alone. Skaly Group staff share a single office IP. With 15+ staff logging in after 9am, an IP-keyed limit of 10/15min triggers a blanket 429 for the entire agency. All auth rate limits are keyed by **email address**, not IP.

| Endpoint | Key | Limit | Window |
|----------|-----|-------|--------|
| Global (all endpoints) | IP | 150 requests | 1 minute |
| `POST /v1/auth/signup/invite` | **email + IP** | 10 attempts | 15 minutes |
| `POST /v1/bot/message` | staffId (JWT) | 30 requests | 1 minute |
| `POST /v1/auth/invite` | staffId (JWT) | 5 requests | 1 hour |
| `POST /v1/auth/signup/request` | IP | 3 requests | 24 hours |
| `POST .../attachments/presign` | staffId (JWT) | 20 requests | 1 hour |

**`@fastify/rate-limit` custom key generator for the login route:**
```typescript
// apps/api/src/routes/auth.ts
app.post('/signup/invite', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '15 minutes',
      keyGenerator: (request) => `${(request.body as any)?.email ?? 'unknown'}:${request.ip}`
    }
  }
}, loginHandler);
```
This gives each email address its own 10-attempt bucket, regardless of how many staff share the same office IP.

---

## 3. AUTHENTICATION ENDPOINTS

### POST /v1/auth/invite
Create invite link for a new staff member.
**Auth:** Admin only

**Request:**
```json
{ "name": "Feroz Ahmed", "email": "feroz@skaly.in", "role": "team_member" }
```

**Response 201:**
```json
{
  "data": {
    "inviteId": "uuid",
    "token": "64-char-hex",
    "inviteUrl": "https://portal.skaly.in/signup?token=...",
    "expiresAt": "2025-06-02T12:00:00Z",
    "role": "team_member"
  }
}
```

**Errors:** 400 `INVALID_ROLE` | 403 `PERMISSION_DENIED` | 429 `RATE_LIMIT_EXCEEDED`

---

### POST /v1/auth/signup/invite
Complete an invite-based signup. All 6 profile fields collected here.
**Auth:** Public (requires valid token)

**Request:** `multipart/form-data`
```
token: "64-char-hex"
name: "Feroz Ahmed"
dateOfBirth: "1995-08-20"
mobileNumber: "+91-9876543210"
password: "SecurePass123"
cvFile: [binary — PDF or DOC, max 5MB, optional]
```

**Response 201:**
```json
{
  "data": {
    "staffId": "uuid",
    "role": "team_member",
    "mfaRequired": false,
    "accessToken": "jwt...",
    "refreshToken": "jwt..."
  }
}
```

**Errors:** 400 `INVITE_EXPIRED` | 400 `INVITE_ALREADY_USED` | 400 `VALIDATION_ERROR` | 400 `INVALID_FILE_TYPE`

---

### POST /v1/auth/signup/request
Submit a self-signup access request with all 6 profile fields.
**Auth:** Public

**Request:** `multipart/form-data`
```
name: "New Person"
email: "new@example.com"
dateOfBirth: "1998-03-15"
mobileNumber: "+91-9988776655"
roleRequested: "team_member"  (admin excluded)
message: "I'm applying for the editor role" (optional)
cvFile: [binary — optional]
```

**Response 201:**
```json
{
  "data": {
    "requestId": "uuid",
    "status": "pending",
    "createdAt": "2025-06-01T08:00:00Z"
  }
}
```

**Errors:** 400 `VALIDATION_ERROR` | 400 `INVALID_ROLE` (admin) | 429 `RATE_LIMIT_EXCEEDED`

---

### POST /v1/auth/signup-requests/:id/approve
Approve a self-signup request, creating the user account.
**Auth:** Admin only

**Request:**
```json
{ "roleAssigned": "team_member" }
```

**Response 200:**
```json
{ "data": { "staffId": "uuid", "name": "New Person", "roleAssigned": "team_member" } }
```

**Errors:** 403 `PERMISSION_DENIED` | 404 `RESOURCE_NOT_FOUND` | 409 `ALREADY_PROCESSED`

---

### POST /v1/auth/signup-requests/:id/reject
Reject a signup request. Internal note and public message are separate fields.
**Auth:** Admin only

**Request:**
```json
{
  "rejectionNote": "Duplicate application from previous staff member",
  "publicRejectionMessage": "Your access request was not approved at this time."
}
```
**Note:** `rejectionNote` is stored in DB but NEVER transmitted to the user. The user receives only `publicRejectionMessage`. If `publicRejectionMessage` is omitted, default is used: "Your access request was not approved at this time."

**Response 200:**
```json
{ "data": { "requestId": "uuid", "status": "rejected" } }
```

---

### POST /v1/auth/password-reset
Initiate password reset. Response is always success to prevent enumeration.
**Auth:** Public

**Request:** `{ "email": "user@skaly.in" }`
**Response 200:** `{ "data": { "message": "If this email is registered, a reset link has been sent." } }`

---

### POST /v1/auth/mfa/verify
Confirm TOTP **enrolment** — flips `staff.mfa_enrolled`.
**Auth:** Authenticated (valid JWT)

**Request:** `{ "factorId": "...", "code": "123456" }`
**Response 204**
**Errors:** 400 `MFA_VERIFY_FAILED` | 403 `MFA_LOCKED` (after 3 failures)

> **The login challenge is not an API call.** `/mfa-challenge` runs Supabase's own
> `challengeAndVerify` against the user's session, because only Supabase can mint the `aal2`
> claim the portal's middleware gates on — the API never sees a login TOTP code. That is why
> a failed login attempt is *reported* (below) rather than counted by the endpoint that
> checked it.

---

### POST /v1/auth/mfa/failure
Report a failed TOTP challenge so it counts against the **shared** MFA failure budget.
**Auth:** Authenticated (valid JWT) — self-inflicted only; the worst a caller can do is lock
themselves out for 15 minutes.

**Response 204**

---

### POST /v1/auth/mfa/recovery
Spend a single-use recovery code. **Sprint 11 STEP 8.**
**Auth:** Authenticated, **aal1 is enough** — this endpoint exists precisely for the caller
who has passed password auth and *cannot* pass the authenticator step. Requiring aal2 would
make it reachable only by people who do not need it.

**Request:** `{ "code": "4f2a9c1e7b" }` — spacing and case are normalised server-side.
**Response 200:** `{ "remainingCodes": 9 }`
**Errors:** 403 `MFA_FAILED` | 403 `MFA_LOCKED`

On success the code is consumed (single use, enforced by the DB), the Supabase factor is
deleted, and `staff.mfa_enrolled` becomes `false` — so the caller lands on `/mfa-setup` to
enrol a new authenticator. **The other codes survive**, unlike an admin `mfa/reset`: someone
who abandons enrolment halfway must not have spent their one way back in. Audited distinctly
from a TOTP login (`event: 'mfa_recovery_code_redeemed'`, `changed_by_source: 'user'`).

### GET /v1/auth/mfa/recovery
Remaining unconsumed codes. **The count only** — no endpoint returns a code.
**Response 200:** `{ "remainingCodes": 7 }`

### POST /v1/auth/mfa/recovery/regenerate
Invalidate every existing code and issue a fresh set, returned **once**.
**Auth:** Authenticated **+ aal2** — unlike redeem. Issuing codes from a session that never
cleared the authenticator step would let a stolen password mint its own recovery codes and
invalidate the real owner's.

**Response 200:** `{ "recoveryCodes": ["...", … 10 total] }`
**Errors:** 403 `MFA_REQUIRED`

---

## 4. STAFF ENDPOINTS

### GET /v1/staff
Returns limited fields for all authenticated roles. Used for task assignment dropdowns and @mention autocomplete.
**Auth:** All roles

**Response:**
```json
{
  "data": [
    { "id": "uuid", "name": "Sohail Khan", "role": "team_member", "avatarUrl": "...", "isOnline": true }
  ]
}
```

---

### GET /v1/staff/:id
Full profile. Admin and Manager can view any staff. Own profile available to all.
**Auth:** admin, manager, own staff

**Response:**
```json
{
  "data": {
    "id": "uuid", "name": "Sohail Khan", "email": "sohail@skaly.in",
    "role": "team_member", "dateOfBirth": "1998-05-10", "mobileNumber": "+91-9876543210",
    "cvFileKey": "cvs/uuid/cv.pdf", "avatarUrl": "...", "active": true, "mfaEnrolled": false,
    "createdAt": "2025-01-15T10:00:00Z"
  }
}
```
### GET /v1/staff/me
Returns the authenticated user's own full profile. No parameters needed.
**Auth:** All roles (authenticated)

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Sohail Khan",
    "email": "sohail@skaly.in",
    "role": "team_member",
    "dateOfBirth": "1998-05-10",
    "mobileNumber": "+91-9876543210",
    "cvFileKey": "cvs/uuid/cv.pdf",
    "avatarUrl": null,
    "active": true,
    "mfaEnrolled": false,
    "createdAt": "2025-01-15T10:00:00Z"
  }
}
```

**Notes:** This is identical to `GET /v1/staff/:id` with `:id = your own staffId`. The JWT is used to look up the staffId — frontend does not need to know the staffId before calling this.

---

### GET /v1/staff/:id/profile
Public-safe profile. Used when Team Member/Freelancer clicks a search result for a staff member.
**Auth:** All roles

**Response:** `{ "data": { "id": "uuid", "name": "Sohail Khan", "role": "team_member", "avatarUrl": "..." } }`

---

### GET /v1/staff/:id/permissions
Returns all per-user permission overrides for a staff member. Used by Settings → Permissions panel.
**Auth:** admin only

**Response:**
```json
{
  "data": {
    "staffId": "uuid",
    "role": "team_member",
    "overrides": [
      { "permissionKey": "bot.tool.create_task", "value": true, "setBy": "uuid", "setAt": "..." },
      { "permissionKey": "chat.access", "value": true, "setBy": "uuid", "setAt": "..." }
    ]
  }
}
```

---

### PUT /v1/staff/:id/permissions/:key
Set or update a single per-user permission override.
**Auth:** admin only

**Param `:key`:** permission key string (e.g., `bot.tool.create_task`, `chat.access`, `months.unlock`)

**Request:**
```json
{ "value": true }
```

**Response 200:**
```json
{
  "data": {
    "staffId": "uuid",
    "permissionKey": "bot.tool.create_task",
    "value": true,
    "setBy": "admin-uuid",
    "updatedAt": "2025-06-01T10:00:00Z"
  }
}
```

**Errors:** 403 `PERMISSION_DENIED` | 400 `INVALID_PERMISSION_KEY` | 404 `STAFF_NOT_FOUND`

---

### DELETE /v1/staff/:id/permissions/:key
Remove a per-user override, reverting to role default.
**Auth:** admin only

**Response 200:** `{ "data": { "removed": true, "revertedToRoleDefault": true } }`

---

### PATCH /v1/staff/me/push-token
Register or clear mobile push token (Phase 2 mobile app).
**Auth:** Authenticated

**Request:** `{ "pushToken": "ExponentPushToken[xxx]", "platform": "android" }` (or `"pushToken": null` to clear)
**Response 200:** `{ "data": { "updated": true } }`

---

### PUT /v1/staff/:id/reactivate
Restore a previously deactivated staff member. Re-enables their portal access.
**Auth:** Admin only

> **Audit M-01 — Reactivation flow:** Deactivation sets `active=false, deleted_at=NOW()`. This endpoint reverses that: sets `active=true, deleted_at=NULL`. The staff member's original UUID, `supabase_uid`, and historical audit log references are all preserved. This is the canonical way to re-onboard a previously deactivated employee without creating a duplicate row (which would otherwise be blocked by the email uniqueness constraint on `staff.email`).

**Request:** `{}` (empty body — single action)

**Response 200:**
```json
{
  "data": {
    "staffId": "uuid",
    "name": "Sohail Khan",
    "active": true,
    "reactivatedAt": "2026-08-15T10:30:00Z",
    "reactivatedBy": "admin-uuid"
  }
}
```

**Errors:**
- 404 `STAFF_NOT_FOUND` — staffId does not exist
- 400 `ALREADY_ACTIVE` — staff is already active (no action needed)
- 403 `PERMISSION_DENIED` — caller is not admin

**Side effects:** Audit log entry written (`action='UPDATE'`, `changed_by_source='user'`). Staff member receives an `account_reactivated` notification on next login.

---

## 5. MODULE ENDPOINTS

### Attendance

**GET /v1/attendance?period=YYYY-MM**
Returns the full grid data in a single request. Team members can view all rows (read-only) but can only mutate their own row via PATCH.
**Auth:** admin, manager, team_member

**Response 200:**
```json
{
  "data": {
    "attendanceLogs": [
      {
        "id": "uuid",
        "period": "2025-06",
        "staffId": "uuid",
        "date": "2025-06-03",
        "dayType": "working",
        "present": true,
        "workLog": "Edited Naaz Furniture reel — final cut",
        "version": 2,
        "updatedAt": "2025-06-03T18:45:12Z",
        "updatedBy": "uuid"
      }
    ],
    "holidays": [
      { "id": "uuid", "date": "2025-06-09", "name": "Eid al-Adha" }
    ],
    "staffList": [
      { "id": "uuid", "name": "Sohail Khan", "role": "team_member", "avatarUrl": "..." }
    ]
  }
}
```

**Field-level notes (audit M-06):**
- `dayType`: `"working"` | `"sunday"` | `"holiday"` — controls cell interactivity in the grid
- `version`: REQUIRED on PATCH; service-layer optimistic lock check
- `staffList` ordering matches column order in the grid (alphabetical by name)

**PATCH /v1/attendance/:id**
**Auth:** admin, manager, team_member (own rows only — 403 if different staff_id)
```json
{ "present": true, "workLog": "Edited the Naaz Furniture reel", "version": 1 }
```
**Errors:** 423 `PERIOD_LOCKED` | 403 `PERMISSION_DENIED` (team_member on other's row)

---

### Tasks

> **Multi-assignee semantics (audit H-03):** Tasks support multiple assignees via the `task_assignees` junction table. The `?assigneeId=` query parameter returns all tasks where the given staffId appears in `task_assignees` (matches one of potentially many assignees). On task creation or assignment change, ONE `task_assigned` notification fires PER assignee — never combined. Each notification carries `{ taskId, taskDescription, assignedBy, dueDate }`.

**GET /v1/tasks?period=&date=&status=&clientId=&assigneeId=&priority=**
**Auth:** admin, manager, team_member
**Filter semantics:** `assigneeId` returns tasks where that staffId is one of the assignees (not the only assignee).

**POST /v1/tasks**
**Auth:** admin, manager only
```json
{
  "period": "2025-06", "date": "2025-06-10", "clientId": "uuid",
  "description": "Edit the Naaz Furniture reel",
  "assigneeIds": ["uuid1", "uuid2"], "priority": "High",
  "dependencyId": "uuid3", "deadline": "2025-06-12"
}
```
**Response 201:** `{ "data": { task object with all fields } }`

**PATCH /v1/tasks/:id**
**Auth:** admin, manager; team_member (status + result on own assigned tasks only)
```json
{ "status": "Done", "result": "Completed and uploaded to drive", "version": 2 }
```
**Errors:** 400 `DEPENDENCY_UNRESOLVED` | 403 `PERMISSION_DENIED` | 423 `PERIOD_LOCKED`

**DELETE /v1/tasks/:id**
Soft delete. Sets deleted_at. **Auth:** admin, manager.
**Response 200:** `{ "data": { "deleted": true } }`

**POST /v1/tasks/:id/attachments/presign**
```json
{ "fileName": "final_reel.mp4", "mimeType": "video/mp4", "fileSize": 52428800 }
```
**Response 200:** `{ "data": { "presignedUrl": "https://r2...", "fileKey": "attachments/..." } }`
**Errors:** 400 `FILE_TOO_LARGE` | 400 `INVALID_FILE_TYPE` | 400 `TASK_ATTACHMENT_LIMIT_EXCEEDED`

**POST /v1/tasks/:id/attachments/confirm**
```json
{ "fileKey": "attachments/...", "fileName": "final_reel.mp4", "mimeType": "video/mp4", "fileSize": 52428800 }
```
**Response 201:** `{ "data": { attachment object } }`

**GET /v1/tasks/:id/attachments/:aid/download**
**Response 200:** `{ "data": { "downloadUrl": "https://r2... (1hr expiry)" } }`

---

> **Phase 2 — Task time tracking (audit L-05 advisory):** The `task_time_logs` table exists in the schema but no API endpoints are implemented in MVP. When Phase 2 adds the UI, the intended API shape is:
> ```
> POST   /v1/tasks/:id/time-logs        body: { startedAt, endedAt? }      → start a session
> PATCH  /v1/tasks/:id/time-logs/:logId body: { endedAt }                  → stop a session
> POST   /v1/tasks/:id/time-logs/manual body: { manualMins, note }         → manual entry
> GET    /v1/tasks/:id/time-logs                                            → list for task
> ```
> Documenting this here prevents the Phase 2 design from being ad-hoc.

---

### Shoot Planner

**GET /v1/shoot-planner?period=**
Freelancers receive only rows where `freelancer_id = staff.id`.
**Auth:** All roles (freelancer: scoped)

**PATCH /v1/shoot-planner/:id**
**Auth:** admin, manager
```json
{ "slotStatus": "Confirmed", "slotDate": "2025-06-20", "piecesExpected": 3, "freelancerId": "uuid" }
```
**Fires cross-module trigger** when `slotStatus = "Confirmed"`: coming_shoot_date updated in content_pipelines.
**Errors:** 423 `PERIOD_LOCKED`

**POST /v1/shoot-planner/:id/reset**
**Auth:** admin, manager
```json
{ "confirm": true }
```
**Errors:** 400 `SHOOT_RESET_CONFIRMATION_REQUIRED` (if `confirm` is absent or false)

---

### Content Dropper

**GET /v1/content-dropper?period=**
**Auth:** admin, manager

**PATCH /v1/content-dropper/:id/stage**
**Auth:** admin, manager
```json
{ "stage": "raw" | "finals" | "posted", "timestamp": "2025-06-15T09:30:00Z" }
```
Stage sequence enforced at service layer — Finals requires raw; Posted requires finals.
Posted stage **fires cross-module trigger**: content_calendar updated.
**Errors:** 400 `STAGE_SEQUENCE_VIOLATION` | 423 `PERIOD_LOCKED`

---

### Content Calendar

**GET /v1/content-calendar?period=**
**Auth:** admin, manager, team_member

**PATCH /v1/content-calendar/:id**
**Auth:** admin, manager
```json
{ "status": "Ready", "note": "Scheduled for 6pm post", "version": 2 }
```
Version is required. Returns 409 `STALE_DATA` with `details.currentVersion` and `details.updatedBy` on mismatch.

> **Service-layer auto-reset (audit M-04):** Any manual PATCH on a cell with `source = 'pipeline_trigger'` automatically resets `source = 'manual'` in the same UPDATE statement. The frontend never sends the `source` field — the service layer handles it. This is what removes the gold pipeline-trigger dot indicator after a manual edit.

**Errors:** 409 `STALE_DATA` | 423 `PERIOD_LOCKED`

---

### AI Bot

**POST /v1/bot/message**
**Auth:** All roles (tool permissions applied per-user)

> **Contract clarification (audit C-01):** The HTTP response acknowledges receipt only. The bot's actual response — including streaming tokens, tool results, and final metadata — is delivered exclusively via Socket.io `bot:message` events to the `user:{staffId}` room. The HTTP body never contains `content` or `card`.

**Request:**
```json
{ "content": "How many tasks are overdue this week?" }
```

**Response 202 Accepted (immediate):**
```json
{ "data": { "messageId": "uuid", "sessionId": "uuid" } }
```
The `messageId` is the user's message row in the `messages` table. The bot's response will be delivered via Socket.io with the same `sessionId`.

**Socket.io `bot:message` event flow (delivered to `user:{staffId}` room):**
```json
// Streaming token events (multiple)
{ "messageId": "uuid", "sessionId": "uuid", "chunk": "There are ", "done": false }
{ "messageId": "uuid", "sessionId": "uuid", "chunk": "3 overdue ", "done": false }
{ "messageId": "uuid", "sessionId": "uuid", "chunk": "tasks this week:", "done": false }

// Final event with metadata and tool results
{
  "messageId": "uuid",
  "sessionId": "uuid",
  "chunk": "",
  "done": true,
  "toolsUsed": ["list_overdue_tasks"],
  "card": { "type": "task_list", "tasks": [...] }
}
```

**Errors:** 403 `BOT_TOOL_DENIED` | 503 `ANTHROPIC_ERROR` | 423 `PERIOD_LOCKED` (mutations only) | 429 `RATE_LIMIT_EXCEEDED`

---

**GET /v1/bot/session/current**
Load the current bot session's conversation history. Used by the frontend to restore conversation state on page load.
**Auth:** Authenticated

**Response 200 (active session exists):**
```json
{
  "data": {
    "sessionId": "uuid",
    "messages": [
      { "id": "uuid", "role": "user", "content": "...", "createdAt": "2025-06-01T09:00:00Z" },
      { "id": "uuid", "role": "assistant", "content": "...", "card": null, "createdAt": "2025-06-01T09:00:02Z" }
    ],
    "turnCount": 23,
    "lastActivityAt": "2025-06-01T09:00:02Z"
  }
}
```

**Response 200 (no active session):**
```json
{ "data": { "sessionId": null, "messages": [], "turnCount": 0, "lastActivityAt": null } }
```

---

**DELETE /v1/bot/session/current**
Clears active bot session from Redis. Next message starts a new session.
**Auth:** Authenticated
**Response 200:** `{ "data": { "cleared": true } }`

---

### Chat

**GET /v1/chat/messages?channel=common&limit=50&cursor=**
**Auth:** admin, manager, team_member (freelancer: 403 by default)

**Response:**
```json
{
  "data": [
    {
      "id": "uuid", "channel": "common", "senderId": "uuid",
      "senderName": "Naaz Ali", "senderAvatar": "...",
      "content": "The Hyatt reel is ready for review",
      "parentId": null, "replyCount": 2,
      "createdAt": "2025-06-01T09:15:00Z"
    }
  ],
  "meta": { "cursor": "eyJ...", "hasMore": true }
}
```

**POST /v1/chat/messages**
```json
{ "channel": "common", "content": "Finishing the edit by EOD", "parentId": null }
```
Broadcasts to Socket.io `org:all` room after DB insert.
**Response 201:** `{ "data": { message object } }`

**GET /v1/chat/threads/:parentId**
Returns all replies to a parent message.
**Response:** Same format as messages list.

---

### Notifications

**GET /v1/notifications**
Returns the most recent 50 notifications for the authenticated user. Ordered newest first.

> **Pagination policy (audit L-07):** No pagination cursor in MVP. The `last 50` window is intentional — older notifications remain in the DB (auditable, queryable for analytics) but are not surfaced in the bell panel. A nightly cleanup job (Phase 2) will archive notifications older than 90 days. This decision is correct for 50-user scale; revisit if user count exceeds ~500.

**Response:**
```json
{
  "data": [ ...notifications ],
  "meta": { "unreadCount": 3, "totalReturned": 50, "limit": 50 }
}
```

**PUT /v1/notifications/:id/read**
**Response 200:** `{ "data": { "read": true } }`

**PUT /v1/notifications/read-all**
Marks all user's notifications as read.
**Response 200:** `{ "data": { "updatedCount": 7 } }`

---

### Comments

**GET /v1/comments?module=&recordId=&period=**
Returns comments with visibility rules applied (team_member sees own + manager/admin replies).
**Auth:** All relevant roles

**POST /v1/comments**
```json
{
  "module": "shoot_planner",
  "recordId": "uuid",
  "period": "2025-06",
  "content": "Please confirm if this shoot date works for the Hyatt team"
}
```
`record_context` is auto-populated server-side ("Hyatt Hotels / Shoot Planner").

> **Soft-referential record_id (audit H-06):** `comments.record_id` is a UUID that references one of three tables (`shoot_schedules.client_id`, `content_pipelines.client_id`, or `content_calendar.client_id`) depending on the `module` value. Because the target table varies, this is NOT a database FK — it is a soft reference. The service layer MUST validate before INSERT that the record exists in the appropriate table for the given module, returning 404 `RESOURCE_NOT_FOUND` if not. The `record_context` text preserves human-readable reference even if the underlying record is later soft-deleted.

**Response 201:** `{ "data": { comment object } }`
**Errors:** 404 `RESOURCE_NOT_FOUND` (record_id doesn't exist for the given module)

**PATCH /v1/comments/:id/acknowledge**
**Auth:** admin, manager
```json
{ "acknowledged": true }
```
**Response 200:** `{ "data": { "acknowledgedBy": "uuid", "acknowledgedAt": "..." } }`

---

### Search & Activity Feed

**GET /v1/search?q=naaz&scope=current**
`scope`: `current` (default, uses active period) | `all_time` (no period filter)
Returns 4 category groups. Debounce: 200ms on frontend.

**Response:**
```json
{
  "data": {
    "tasks":   [ { "id": "uuid", "description": "...", "period": "2025-06" } ],
    "clients": [ { "id": "uuid", "name": "Naaz Furniture" } ],
    "staff":   [ { "id": "uuid", "name": "Naaz Ali", "role": "team_member" } ],
    "comments": [ { "id": "uuid", "content": "...", "module": "shoot_planner", "recordContext": "..." } ]
  }
}
```

**GET /v1/activity-feed?period=&limit=10**
Role-filtered event feed for home page. NOT the admin audit log.
**Auth:** All roles

---

### Reports

> **Report generation is ASYNCHRONOUS — superseded by ADR-027 (Sprint 11).** This section
> previously documented a synchronous contract: one call that rendered the PDF, uploaded it,
> and returned a presigned `downloadUrl` in a 201. That shape is unimplementable as written —
> it requires the render to finish inside the request, and a PDF render is CPU-bound on a
> single-core Railway instance, so month-end requests block the event loop and take the API
> down with them (the health check queues behind the render and Railway restarts the box).
> The render now runs in a worker thread and the endpoint returns **202 + `reportId`**;
> the client polls `GET /v1/reports/:id`. The old `GET /v1/reports/:id/download` is folded
> into that poll — it returned a fresh presigned URL and nothing else, and one endpoint
> cannot disagree with itself about whether a report is downloadable.

**POST /v1/reports/generate**
**Auth:** admin, manager
```json
{ "type": "client_monthly", "clientId": "uuid", "period": "2025-06" }
```
Creates a `reports` row with `status: 'pending'` and dispatches the render to a worker thread.
Returns immediately — **no PDF, no link**. `clientId` is required for `client_monthly` and
rejected for `org_monthly`.
**Response 202:**
```json
{ "data": { "reportId": "uuid", "status": "pending" } }
```

**GET /v1/reports/:id**
The poll. Returns the row's current `status` (`pending` → `ready` | `failed`), and once
`ready`, a **freshly presigned** `downloadUrl`. The URL is generated from `file_key` on every
read and never stored — a stored URL is a URL that expires in the database. `downloadUrl` is
`null` for any status but `ready`; a `failed` report carries `errorMessage`.
**Response 200:**
```json
{ "data": { "id": "uuid", "type": "client_monthly", "period": "2025-06", "clientId": "uuid",
            "clientName": "Acme", "status": "ready", "errorMessage": null,
            "requestedAt": "...", "completedAt": "...", "requestedBy": "uuid",
            "downloadUrl": "https://r2... (24hr expiry)" } }
```
**410 `RESOURCE_EXPIRED`** for reports past R2's 30-day lifecycle rule — the row is still
readable, the object is gone. Distinct from 404 so the panel can offer `[Regenerate]` rather
than "not found".

> **report_ready notification link target (audit M-08):** The `report_ready` notification's
> link MUST be `/settings/reports?reportId={id}` (a portal route), NEVER a presigned R2 URL.
> The presigned URL expires in 24 hours and the notification row does not, so a baked-in link
> is a bell that stops working overnight while still looking clickable. `/settings/reports`
> calls `GET /v1/reports/:id` for a fresh URL on open. This is enforced for **all 18** types
> by the registry link-durability test, not just for `report_ready`.

**GET /v1/reports?period=**
Lists reports for the period. A manager sees their own; an admin sees everyone's.

---

### Dashboard

**GET /v1/dashboard/home**
Role-filtered dashboard payload. Sourced from materialised views.
**Auth:** All roles
**Response:** Content varies by role (Admin / Manager / Team Member / Freelancer).

---

### Months

**POST /v1/months/:period/lock**
**Auth:** admin
**Request:** `{}` (no body required)
**Response 200:** `{ "data": { "period": "2025-05", "locked": true, "lockedAt": "..." } }`

**DELETE /v1/months/:period/lock**
**Auth:** admin
```json
{ "reason": "Correcting Sohail's attendance for May 28" }
```
`reason` is required. Returns 400 `UNLOCK_REASON_REQUIRED` if missing.
**Response 200:** `{ "data": { "period": "2025-05", "locked": false, "unlockReason": "..." } }`

---

### Audit Log

**GET /v1/audit-log?staffId=&table=&action=&from=&to=&limit=50&cursor=&format=json**
**Auth:** admin only
Supports streaming CSV export via `?format=csv`.

---

### Internal (CRON_SECRET protected)

**POST /v1/internal/rollover**
**Header:** `X-Internal-Secret: <CRON_SECRET>` — handled by `internalAuthPlugin`, not the JWT middleware
Triggers rollover. Idempotency guard prevents double-run.
**Response 200:** `{ "data": { "period": "2025-07", "status": "completed" } }`
**Response 200** (already done): `{ "data": { "period": "2025-07", "status": "already_complete" } }`

**POST /v1/internal/rollover/manual**
**Auth:** admin JWT (different from CRON_SECRET)
Same logic as cron-triggered rollover. Used from Settings → Months → Manual trigger.

---

## 6. WEBSOCKET EVENTS

**Connection:** `wss://api.skaly.in/ws/notify` (or `/ws/chat`, `/ws/presence`)
**Auth:** Token in `socket.handshake.auth.token`

### Server → Client Events

| Event | Room | Payload |
|-------|------|---------|
| `notify:new` | `user:{staffId}` | `{ notification }` |
| `module:updated` | `org:all` | `{ module, period, clientId }` |
| `attendance:holiday_added` | `org:all` | `{ period, date, name }` |
| `shoot:slot_updated` | `org:all` | `{ slotId, clientId, status }` |
| `content-dropper:updated` | `org:all` | `{ clientId, period }` |
| `content-calendar:updated` | `org:all` | `{ clientId, period, date }` |
| `chat:message` | `org:all` | `{ message }` |
| `chat:typing` | `org:all` | `{ staffId, name, channel }` |
| `chat:presence` | `org:all` | `{ staffId, isOnline }` |
| `bot:message` | `user:{staffId}` | `{ content, card?, toolsUsed? }` |
| `system:month_locked` | `org:all` | `{ period }` |
| `system:month_ready` | `role:admin` | `{ period, label }` |
| `system:rollover_failed` | `role:admin` | `{ period, summary, attempt }` |
| `client:name_updated` | `org:all` | `{ clientId, name }` |
| `signup:new_request` | `role:admin` | `{ requestId, name }` |

### Client → Server Events

| Event | Payload |
|-------|---------|
| `presence:ping` | `{}` |
| `chat:typing` | `{ channel }` |
| `chat:stop_typing` | `{ channel }` |
