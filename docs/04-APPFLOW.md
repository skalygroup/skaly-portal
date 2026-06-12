# 04 — APPLICATION FLOW SPECIFICATION (APPFLOW)
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** PRD §3-4, TRD §7-9, UI/UX §5-21, AUTH-MATRIX §3-5

---

## 1. GLOBAL RULES

### 1.1 Navigation Architecture
All authenticated routes live under the `(portal)` layout. Navigation via sidebar on desktop (1280px+). Sidebar collapses to icon-only on tablet (768–1279px).

### 1.2 Route Map

| Route | Module | Min Role |
|-------|--------|---------|
| `/home` | Home Dashboard | freelancer |
| `/attendance` | Staff Attendance | team_member |
| `/tasks` | Work Allocation | team_member |
| `/shoot-planner` | Shoot Planner | team_member (read-only) |
| `/content-dropper` | Content Dropper | manager |
| `/content-calendar` | Content Calendar | team_member (read-only) |
| `/bot` | AI Management Bot | team_member |
| `/chat` | Common Chat | team_member (freelancer blocked by default) |
| `/dashboard` | Dashboard | team_member |
| `/profile` | Own Profile | freelancer |
| `/settings/*` | Settings & Admin | manager (limited) / admin (full) |

Routes not in a user's access set do not appear in sidebar. Direct URL access returns 403 (not redirect — user sees 403 page at that URL).

### 1.3 Global Behaviour Rules

**Rule 1 — Period in URL:** Every module page carries `?period=YYYY-MM` in the URL. MonthContext initialises from this param. On period change, `router.push` updates URL. Browser back/forward navigates between periods.

**Rule 2 — Locked Month:** If the current period is locked, all grid cells render as `<span>` (not `<input>`). Gold column highlight does not activate. Write API calls return 423. A gold locked banner appears below the page header.

**Rule 3 — Gold Column Highlight:** Any focused editable field in any grid activates the column highlight for that column. Only one column highlighted at a time. Clears on blur unless save in-flight.

**Rule 4 — Optimistic Updates:** All grid mutations apply optimistic updates immediately via TanStack Query. On API failure, the mutation is rolled back and a toast is shown.

**Rule 5 — Role Enforcement:** Frontend restrictions (pointer-events:none, hidden buttons) are UX. API-level checks are the enforceable security boundary. Both must be implemented.

**Rule 6 — Period Global Context:** Changing the period via the sidebar period selector updates ALL modules simultaneously. All TanStack Query cache keys include the period. All module API calls include `?period=YYYY-MM`. A single period state drives the entire portal.

---

## 2. AUTHENTICATION FLOWS

### 2.1 Email/Password Login

```
/login
  → User enters email + password
  → POST /v1/auth/session (Supabase signInWithPassword)

  Branch A — Admin or Manager:
    → Check staff.mfa_enrolled
    → If false: redirect /mfa-setup (enrollment mandatory before /home)
    → If true: show TOTP prompt (6-digit input)
      → On success: redirect /home
      → On fail (attempt 1-2): "Incorrect code"
      → On fail (attempt 3): 15-minute lockout + "Try again in 15 minutes"

  Branch B — Team Member or Freelancer:
    → Direct redirect to /home (no MFA)

  Failure states:
    Wrong credentials: "Incorrect email or password" (no field hint — prevents enumeration)
    Inactive account: "This account has been deactivated. Contact your admin."
    Rate limited: "Too many attempts. Please wait before trying again."
```

### 2.2 Google OAuth Login

```
/login → [Continue with Google]
  → Supabase OAuth redirect to Google consent screen
  → Returns to /auth/callback?code=...
  → POST /v1/auth/session/oauth (exchange code for JWT)
  → Lookup staff row by supabase_uid
  → If no matching staff row: "No portal account found for this Google account. Request access."
  → If found: follow Branch A/B from 2.1
```

### 2.3 MFA Enrollment (First Login — Admin + Manager)

```
/mfa-setup (accessible only if mfa_enrolled = false AND role in [admin, manager])
  → Supabase generates TOTP secret
  → Display QR code (200px) + manual entry code
  → "Scan with Google Authenticator, Authy, or 1Password"
  → User enters 6-digit verification code
  → On success:
    → staff.mfa_enrolled = true
    → Show recovery codes (8 codes, single-use)
    → Confirmation modal: "I have saved these recovery codes safely" [checkbox]
    → [Continue to portal] — only enabled when checkbox is checked
    → Redirect /home
  → On failure:
    → "Incorrect code. Check your authenticator app."
    → Allow retry (max 5 attempts before page refresh required)
```

### 2.4 Password Reset

```
/login → [Forgot password?] → /forgot-password
  → User enters email address
  → POST /v1/auth/password-reset { email }
  → Always shows: "If this email is registered, a reset link has been sent." (prevents enumeration)
  → User opens email → clicks link → /reset-password?token=[token]
  → Token validation:
    → If expired (>1hr): "This link has expired. Request a new one." [link to /forgot-password]
    → If valid: show new password form
  → User enters new password + confirm
  → On submit: Supabase updateUser({ password }) → all sessions revoked
  → Redirect /login: "Password updated. Please sign in with your new password."
```

### 2.5 TOTP Recovery (Lost Authenticator)

```
/login → [Use recovery code] (shown after TOTP screen)
  → Input for 8-character recovery code
  → On valid code: code consumed (cannot be reused), redirect /home
  → On invalid: "Recovery code not recognised."
  → If all 8 codes exhausted: "Contact your admin to reset MFA access."
    → Admin path: Settings → Staff → [member] → [Reset MFA] button
      → Confirmation: "Reset [Name]'s MFA? They will need to re-enroll on next login."
      → On confirm: Supabase unenrolls TOTP → staff.mfa_enrolled = false
      → On next login: admin/manager sent to /mfa-setup again
```

### 2.6 Self-Signup Request (PRD Amendment 1)

```
/login → [Request access] → /signup

  PATH A — Google OAuth signup:
    → [Continue with Google] → OAuth flow → name + email pre-filled
    → Complete remaining fields (DOB, Mobile, Role, optional CV)

  PATH B — Email form signup:
    ┌─────────────────────────────────────────────────┐
    │ Full Name         [required]                    │
    │ Email Address     [required]                    │
    │ Date of Birth     [required, date picker]       │
    │ Mobile Number     [required, +CC format]        │
    │ I am applying as  [required, role dropdown]     │
    │   Team Member (default) / Manager / Freelancer  │
    │   (Admin excluded from self-selection)          │
    │ About yourself    [optional, 500 char max]      │
    │ CV / Resume       [optional, PDF/DOC, max 5MB]  │
    └─────────────────────────────────────────────────┘

  On submit:
    → POST /v1/auth/signup/request (multipart if CV attached)
    → signup_requests row created (status: 'pending')
    → CV uploaded to R2: cvs/requests/{requestId}/cv.pdf
    → Redirect /signup/pending

  /signup/pending:
    → Shows: name, email, role_requested, submitted timestamp
    → Text: "Your request is under review. Typically reviewed same working day."
    → Polling: 10s → 30s → 60s → stops at 10min
    → If status = 'approved': auto-redirect /login + toast "Your account is ready!"
    → If status = 'rejected': shows public_rejection_message only
      (rejection_note never transmitted to user)
    → [Back to login] always visible

  Admin notification:
    → All admins receive 'signup_request' notification simultaneously
    → Bell badge + toast: "New access request from [Name]"
    → Clicking navigates to /settings/signup-requests

  Admin review (/settings/signup-requests):
    → Card shows: Name, DOB, Mobile, Email, Role requested, Message, Submitted time
    → [View CV] opens presigned R2 URL (if cv_file_key set)
    → APPROVE:
      → Role dropdown (can differ from role_requested)
      → [Accept] → confirmation → POST /v1/auth/signup-requests/:id/approve { roleAssigned }
      → Supabase user created → staff row created → user notified
      → AttendanceService.backfillCurrentPeriod(newStaffId) — generates attendance
        rows for all working days from the approval date through end of period
        (audit M-02: prevents new mid-month staff from missing the first N days)
    → REJECT:
      → [Reject] → two text fields:
        "Internal note (only you see this)" → rejection_note [internal — NEVER shown to user]
        "Message to user (optional)" → public_rejection_message
      → POST /v1/auth/signup-requests/:id/reject
      → User's pending page shows public_rejection_message only
```

### 2.7 Invite-Based Signup

```
Admin: Settings → Staff → [Invite New Member]
  → Form: Name, Email, Role
  → POST /v1/auth/invite → invite_links row created (token, 24hr TTL)
  → Supabase inviteUserByEmail() — primary email delivery
  → [Copy link] button — fallback URL for manual sharing

Invitee receives email → opens /signup?token=[token]:
  → Token validated → role extracted and displayed (read-only)
  → Form:
    Full Name (pre-filled, editable)
    Email (pre-filled, read-only)
    Date of Birth (required)
    Mobile Number (required)
    You're joining as: [Role badge — read-only]
    Password (required)
    Confirm Password (required)
    CV / Resume (optional)
  → POST /v1/auth/signup/invite { token, name, dob, mobile, password, cvFileKey? }
  → Supabase user created + staff row created
  → Admin/Manager → /mfa-setup
  → Team Member/Freelancer → /home

Token expired (>24hr):
  → "This invite link has expired."
  → "Contact your admin for a new invite."
  → [Back to login]
```

### 2.8 Sign Out

```
User clicks [Sign out] (sidebar bottom or profile menu):
  1. Socket.io: emit('presence:offline') → socket.disconnect()
  2. DELETE /v1/auth/session (Supabase signOut — invalidates refresh token)
  3. TanStack Query: queryClient.clear()
  4. Zustand stores: all stores reset
  5. router.push('/login')

Steps execute in order. Disconnect before signOut to prevent ghost presence.
```

---

## 3. HOME PAGE FLOW

```
GET /v1/dashboard/home (role-filtered payload)
  → Renders in < 2s (data from materialised views — not raw tables)

Admin: sees all 4 widget areas
Manager: sees ops widgets
Team Member: sees own-data widgets
Freelancer: sees own-shoot widgets

Activity feed: GET /v1/activity-feed?period={period}&limit=10
  → Role-filtered (team member sees own events; admin sees all)
  → NOT /v1/audit-log (which is admin-only and audit-purpose only)

Quick actions: open modals directly. Never navigate away from home.
Period selector: changes URL + re-fetches all widgets via MonthContext
```

---

## 4. ATTENDANCE FLOW

```
Page load:
  → GET /v1/attendance?period={period}
  → Grid renders: rows = working days, columns = all active staff
  → Team member: own column interactive, others pointer-events:none

Toggle (present/absent):
  → User clicks cell
  → Optimistic update (cell toggles immediately)
  → PATCH /v1/attendance/:id { present: !current }
  → Gold column highlight activates
  → On success: highlight clears
  → On failure: value reverts + toast "Failed to save — try again"

Work log:
  → User clicks work log cell
  → Inline text input appears (row height expands)
  → Typing triggers 800ms debounce timer
  → Column highlight stays during debounce + save
  → PATCH /v1/attendance/:id { workLog: value }
  → On success: input collapses to text display
  → On failure: input stays open + toast

Holiday add (manager/admin):
  → Settings → Holidays OR inline [+ Holiday] in attendance toolbar
  → Date picker + holiday name → POST /v1/holidays { period, date, name }
  → Attendance rows for that date: day_type = 'holiday', gold tint applied
  → Real-time broadcast to all connected users (grid rows update)

Locked period:
  → All cells render as <span> text
  → No toggle, no work log edit, no column highlight
  → "June 2025 is locked" gold banner shown
```

---

## 5. TASKS FLOW

```
Page load:
  → GET /v1/tasks?period={period}
  → Results grouped by date, collapsible headers

Create task (manager/admin):
  → [+ Add task] → right-panel slide-in form
  → Fields: Date, Description, Client, Assignees, Priority, Dependency, Deadline, Remark
  → POST /v1/tasks → task row inserted → assignees notified

Update status (team member — own tasks):
  → Click status chip → status dropdown
  → If attempting Done on task with unresolved dependency:
    → Frontend shows "Blocked by: [description]" before API call
    → API also returns 400 { code: 'DEPENDENCY_UNRESOLVED' }
  → PATCH /v1/tasks/:id { status }

File attachment:
  → Click paperclip icon → attachment panel opens (right side)
  → Drag file or click to browse
  → POST /v1/tasks/:id/attachments/presign → presignedUrl
  → Browser PUTs to presignedUrl (progress bar shown)
  → POST /v1/tasks/:id/attachments/confirm → row created
  → Attachment appears in panel list

Soft delete (manager/admin):
  → ⋯ menu → [Delete task] → confirmation dialog
  → DELETE /v1/tasks/:id → deleted_at set
  → Row disappears from grid (filtered WHERE deleted_at IS NULL)
```

---

## 6. SHOOT PLANNER FLOW

```
Page load:
  → GET /v1/shoot-planner?period={period}
  → Dynamic column count = max(clients.shoot_slots_per_month)
  → Clients with fewer slots: N/A cells rendered (opacity 0.15, disabled)
  → Week groupings computed from slot_date via date-fns

Schedule slot (Unset → Scheduled):
  → Click Unset cell → popover opens below cell
  → Date picker + pieces stepper (default: client.pieces_per_visit)
  → Optionally: assign freelancer from dropdown (staff WHERE role='freelancer')
  → [Schedule] button → PATCH /v1/shoot-planner/:id { slotDate, slotStatus:'Scheduled', ... }
  → Cell updates to Scheduled chip + date (DM Mono)

Confirm slot (Scheduled → Confirmed):
  → Click Scheduled cell → popover with current date pre-filled
  → Can change date if needed
  → [Confirm] button → PATCH /v1/shoot-planner/:id { slotStatus: 'Confirmed', ... }
  ★ TRIGGER EVENT: eventBus.emit('shoot:confirmed', { clientId, period, slotDate })
    → Content Dropper: coming_shoot_date = slotDate, source = 'trigger'
    → Toast: "Shoot confirmed. Content Dropper updated."
  → Freelancer (if assigned): receives 'shoot_confirmed' notification

Complete slot (Confirmed → Completed):
  → Click Confirmed cell → popover: "Mark as Completed?"
  → [Complete] → PATCH /v1/shoot-planner/:id { slotStatus: 'Completed' }

Reset slot (Completed → Unset):
  → ⋯ cell menu → [Reset slot] → confirmation dialog
  → POST /v1/shoot-planner/:id/reset { confirm: true }
  → confirm:true is mandatory in API body — 400 if absent
```

---

## 7. CONTENT DROPPER FLOW

```
Page load:
  → GET /v1/content-dropper?period={period}
  → Pipeline status derived at query time (no stored field)

Mark stage (Manager/Admin):
  → Click empty stage cell (RAW / Finals / Posted)
  → Sequence check:
    → Finals requires raw_received_at set → if not: toast "Mark RAW first" + cell shakes
    → Posted requires finals_ready_at set → if not: toast "Mark Finals first" + cell shakes
  → PATCH /v1/content-dropper/:id/stage { stage: 'raw' | 'finals' | 'posted', timestamp: now }

Posted stage fires Trigger 2:
  ★ TRIGGER EVENT: eventBus.emit('pipeline:posted', { clientId, period, postedAt })
    → Content Calendar: cell for clientId + today → status = 'Posted', source = 'pipeline_trigger'
    → Toast: "Posted! Content Calendar updated automatically."
    → WebSocket broadcast: grid refresh for all connected users

Client name edit:
  → Click client name cell → inline input appears
  → 800ms debounce autosave → PATCH /v1/clients/:id { name }
  → TanStack Query: invalidate all queries containing this clientId
  → Toast: "Client name updated — reflected across all modules."
```

---

## 8. CONTENT CALENDAR FLOW

```
Page load:
  → GET /v1/content-calendar?period={period}
  → Today's row: gold/06 background, auto-scroll to today
  → Virtual scroll: TanStack Virtual v3 (31 rows × N columns)

Edit cell (Manager/Admin):
  → Click cell → popover opens (200px) below cell
  → Status dropdown (6 options) + Note textarea
  → 800ms debounce on note input
  → PATCH /v1/content-calendar/:id { status, note, version }
  → If version mismatch (409): inline message "Updated by [Name] — [Refresh row →]"
  → Popover closes on outside click
  → Gold column highlight activates on any interaction

Pipeline-triggered cells:
  → Show 6px gold dot at chip top-right
  → Tooltip: "Auto-updated from Content Dropper"
  → Manual edit: dot removed, source changes to 'manual'
```

---

## 9. AI BOT FLOW

```
Page load:
  → GET /v1/bot/session/current → load last 50 turns (if session exists)
  → Display existing conversation or empty state

Send message:
  → User types in chat input → [Send] or Enter
  → POST /v1/bot/message { content }
  → "Thinking..." indicator (animated dots)
  → Response streams via Socket.io ('bot:message' event)
  → Tool-response cards render based on tool type

Mutation confirmation (mandatory for ALL mutation tools):
  Turn 1 — Bot presents summary:
    "I'll [action]:
     [Entity summary]
     Shall I go ahead?"
    User sees [Confirm] and [Cancel] inline buttons

  Turn 2 — User confirms:
    POST /v1/bot/message { content: "yes" } (or button click)
    → Tool call executes
    → Result displayed + deep link to affected record

  Cancel path:
    [Cancel] → "Okay, no changes made."

Permission denied:
  → "I don't have permission to [action] on your behalf.
     Ask an admin to update your bot access settings."
  → (Never states which role level is required)

New conversation:
  → [New conversation] icon → "Clear your conversation history?" dialog
  → On confirm: DELETE /v1/bot/session/current → Redis key deleted
  → Chat panel clears → empty state shown
```

---

## 10. CHAT FLOW

```
Page load:
  → GET /v1/chat/messages?channel=common&limit=50
  → FlatList / infinite scroll (cursor-based)

Send message:
  → User types → Enter or [Send]
  → POST /v1/chat/messages { channel: 'common', content }
  → Socket.io broadcasts to org:all room
  → All connected users receive instantly

@Mention:
  → Type @ → popover with staff list (fuzzy search as user types)
  → Select → inserts @Name, creates message_mentions row on send
  → Mentioned user receives 'mention' notification

Thread reply:
  → Hover/press message → [Reply] action
  → Thread panel slides in from right
  → GET /v1/chat/threads/:parentId → load thread messages
  → Thread reply: POST /v1/chat/messages { channel, content, parentId }

Typing indicator:
  → onChangeText fires → emit 'chat:typing' event to Socket.io
  → Other users see "[Name] is typing..."
  → Auto-expires 5s after last event

Scroll position:
  → "N new messages ↓" pill when user is scrolled up and new message arrives
  → Click pill: smooth scroll to bottom
```

---

## 11. NOTIFICATIONS FLOW

```
Real-time delivery:
  → Service writes notification row
  → Socket.io: io.to('user:{staffId}').emit('notify:new', notification)
  → Bell badge increments
  → Toast appears (auto-dismiss 3s, except rollover_failed)

Open notification panel:
  → Click bell icon → panel slides down (380px)
  → GET /v1/notifications (if not already loaded)
  → Unread items: slightly elevated background
  → Click notification: PUT /v1/notifications/:id/read → navigate to payload.link

Mark all read:
  → [Mark all read] button → PUT /v1/notifications/read-all
  → All items fade to read state (animated)
  → Bell returns to outlined (default) state

rollover_failed notification:
  → Full height (no truncation), red/10 tint
  → Inline [Manual rollover] gold button
  → Clicking opens Settings → Months → confirm manual trigger
  → Never auto-dismisses
```

---

## 12. SEARCH FLOW

```
Trigger: CMD+K / Ctrl+K from any page
  → Full-page overlay appears (Framer Motion, 180ms)
  → Focus lands on search input

User types:
  → 200ms debounce fires
  → GET /v1/search?q={query}&scope={current|all_time}
  → Results render in 4 categories: Tasks, Clients, Staff, Comments

Scope toggle:
  → [This month ✓] default — period filter applied
  → [All time] — no period filter, results include period label (DM Mono)

Navigation from result:
  → Task → /tasks?period={period}&highlight={taskId} → row highlighted gold 2s
  → Client → /content-dropper?period={period} → client row in view
  → Staff (admin/manager) → /settings/staff/{id}
  → Staff (team member/freelancer) → public profile modal opens (no navigation)
  → Comment → module page + opens comment box for that record

Close: Escape or outside click
```

---

## 13. COMMENTS FLOW

```
Comment notification recipients (for new_comment notification type):
  - ALL staff with role 'admin' or 'manager' always receive new_comment notifications
  - If module = 'shoot_planner' AND the slot has a freelancer_id: also notify that freelancer
  - Team members are NOT notified of comments on other records (they see replies to their own)

Implementation: broadcast to Socket.io room 'role:admin' and 'role:manager'.
Additional freelancer: io.to('user:{freelancerId}').emit('notify:new', notification)

Available in: /shoot-planner, /content-dropper, /content-calendar ONLY

Open comments:
  → Click 💬 icon at end of grid row
  → Non-virtual grids: row expansion (row pushes down, siblings shift)
  → Virtual grid (content-calendar): portal-anchored overlay below row

Load comments:
  → GET /v1/comments?module={module}&recordId={id}&period={period}
  → Team member sees: own comments + all manager/admin replies in same record
  → Manager/Admin sees: all comments

Post comment:
  → Textarea → [Post] → POST /v1/comments { module, recordId, period, content }
  → Service auto-populates record_context ("Naaz Furniture / Shoot Planner")
  → Owner of record receives 'new_comment' notification

Acknowledge (manager/admin):
  → [✓ Noted] button on team member comment
  → PATCH /v1/comments/:id/acknowledge
  → Comment shows "✓ Acknowledged by [Name]" (green ✓ badge)
  → Team member sees acknowledgment status on their comment
```

---

## 14. SETTINGS FLOWS

### 14.1 Staff Management
```
/settings/staff:
  → GET /v1/staff (admin: full list; manager: limited)
  → Table: Name · Role · Status · Joined · Actions
  → [Invite New Member] → modal form → POST /v1/auth/invite

Staff detail (/settings/staff/:id):
  → Profile fields (read-only with edit icon)
  → Permissions tab: toggle per permission_key (per-user overrides)
  → [Deactivate] → confirmation → PUT /v1/staff/:id/deactivate
  → [Reset MFA] (if admin/manager with mfa_enrolled) → confirmation
```

### 14.2 Month Lock/Unlock
```
Lock (end of period):
  /settings/months → period row → [Lock period]
  → Confirmation: "Lock June 2025? This prevents all edits."
  → POST /v1/months/{period}/lock
  → All connected users: Socket.io broadcast 'month:locked'
  → Banner appears on all module pages for that period

Unlock (correction):
  → [Unlock period] → modal with required reason textarea
  → Reason cannot be blank
  → DELETE /v1/months/{period}/lock { reason }
  → months.unlock_reason stored + audit log entry
```

### 14.3 Manual Rollover
```
/settings/months → [Trigger rollover for {month}]
  → Confirmation: "Manually initialise {month}? This cannot be undone."
  → POST /v1/internal/rollover/manual
  → Progress indicator: "Creating attendance rows... Creating shoot slots... Done!"
  → Redirect to new period
```

### 14.4 Staff Deactivation
```
/settings/staff/:id → [Deactivate account]
  → Confirmation: "Deactivate {Name}? Their access will end immediately."
  → PUT /v1/staff/:id/deactivate
  → staff.active = false, deleted_at = NOW()
  → Supabase: user session revoked
  → Socket.io: 'auth:deactivated' broadcast to user:{staffId} room
  → User's next API call: 401 with code: 'ACCOUNT_DEACTIVATED'
  → User sees: "Your account has been deactivated. Contact your admin."
  → Audit log: action='DEACTIVATE', table_name='staff'
```

---

## 15. CROSS-MODULE TRIGGERS

### Trigger 1 — Shoot Confirmed → Content Dropper
```
Event: shoot_schedules.slot_status updated to 'Confirmed'
Handler (eventBus 'shoot:confirmed'):
  → ContentDropperService.setComingShootDate(clientId, period, slotDate, 'trigger')
  → PATCH content_pipelines: { coming_shoot_date: slotDate, coming_shoot_source: 'trigger' }
  → io.to('org:all').emit('content-dropper:updated', { clientId, period })
  → TanStack Query: invalidate ['content-dropper', period] on all connected clients

Visual result:
  → Content Dropper: "Coming Shoot Date" cell shows slotDate + ↑ indicator
  → Tooltip on ↑: "Set by Shoot Planner"
```

### Trigger 2 — Pipeline Posted → Content Calendar

> **Trigger date semantics (audit H-02):** The trigger uses `today` (server-side `CURRENT_DATE` in IST) — the date the manager clicked "Mark Posted" — NOT the actual social media post date. This is an accepted MVP limitation. If the manager marks a post as "Posted" 3 days late, the calendar will show "Posted" on the day they clicked, not the actual post day. The PRD §6 lists this as a known constraint. A future enhancement could add a `posted_date` field to `content_pipelines` accepting an optional override; not in MVP scope. Managers should mark "Posted" on the same day the content is actually posted.

```
Event: content_pipelines.posted_at updated (not null)
Handler (eventBus 'pipeline:posted'):
  → ContentCalendarService.updateCell(clientId, period, today, 'Posted', 'pipeline_trigger')
  → INSERT or UPDATE content_calendar: { status: 'Posted', source: 'pipeline_trigger', updated_at: now }
  → io.to('org:all').emit('content-calendar:updated', { clientId, period })
  → TanStack Query: invalidate ['content-calendar', period] on all connected clients

Visual result:
  → Content Calendar: cell for clientId + today shows 'Posted' chip + 6px gold dot
  → Tooltip on dot: "Auto-updated from Content Dropper"
```

---

## 16. MONTHLY ROLLOVER FLOW (AUTOMATED)

```
Railway Cron: 31 18 * * * UTC (= 00:01 IST)
  → POST /v1/internal/rollover (header: X-Internal-Secret: <CRON_SECRET>)

RolloverService.run(targetPeriod):

  [STEP 0 — IDEMPOTENCY CHECK — before any DB operation]
  → SELECT * FROM months WHERE period = targetPeriod
  → If exists: log "Already initialised" → return (no error, no notification)

  [STEPS 1-7 — INSIDE SINGLE TRANSACTION]
  BEGIN;
    Step 1: INSERT months { period, label }
    Step 2: UPDATE months SET locked=true WHERE period = prevPeriod
            ← INSIDE transaction: new month + lock are ATOMIC
    Step 3: INSERT attendance_logs for all active staff × all working days
    Step 4: INSERT content_pipelines for all active non-internal clients
    Step 5: INSERT shoot_schedules for all active non-internal clients
            (slot_index 1..shoot_slots_per_month per client)
    Step 6: INSERT content_calendar for all active non-internal clients × 31 days
    Step 7: INSERT audit_log (staff_id=NULL, changed_by_source='system')
  COMMIT;
  ← If any step fails: full ROLLBACK (no partial state)

  [STEP 8 — OUTSIDE transaction — CONCURRENTLY requires this]
  Retry block (separate from transaction retry — up to 3 attempts, 2s backoff):
    REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_org_stats;
    REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_staff_task_stats;

  If view refresh fails after 3 retries:
    → Rollover is NOT marked as failed (the data transaction succeeded — period exists)
    → Admin notification: 'rollover_view_refresh_failed'
      Message: "Rollover succeeded, but the dashboard view refresh failed.
                Dashboard data may be stale. Retry from Settings → Months → [Refresh Dashboard Views]."
    → Log error with full context for debugging
    → Portal remains fully operational; only dashboard stats show prior period's data

  [STEP 9 — AFTER successful commit]
  → NotificationService.notifyAdmins('month_ready', { period: targetPeriod })

Failure handling:
  → Attempt fails → ROLLBACK → wait 5min → retry (max 3 attempts)
  → After 3 failures:
    → BotService.generateRolloverSummary(error) → 3-5 plain-language sentences
    → NotificationService.notifyAdmins('rollover_failed', { summary, period, error })
    → rollover_failed notification: full height, red tint, [Manual rollover] button
```

---

## 17. AUDIT LOG VIEWER FLOW

```
/settings/audit-log (admin only):
  → GET /v1/audit-log?limit=50 (defaults to last 50 entries)
  → Table: Timestamp (DM Mono) · Actor · Source · Table · Action · Record ID

Filter:
  → Staff dropdown, Table dropdown, Action dropdown, Date range picker
  → All filters combine with AND logic
  → Results update with each filter change

Row expansion:
  → Click row → inline expansion
  → Shows: old_value vs new_value (JSON diff, changed fields highlighted)
  → DM Mono for JSON values

CSV export:
  → [Export CSV] button → GET /v1/audit-log?format=csv&[same filters]
  → Streaming response → browser downloads file
  → File name: audit-log-{YYYY-MM-DD}.csv
```

---

## 18. RBAC NAVIGATION MAP

```
Admin:
  Home → Attendance → Tasks → Shoot Planner → Content Dropper →
  Content Calendar → Bot → Chat → Dashboard → Settings (full) → Profile

Manager:
  Home → Attendance → Tasks → Shoot Planner → Content Dropper →
  Content Calendar → Bot → Chat → Dashboard → Settings (clients, holidays, reports) → Profile

Team Member:
  Home → Attendance (own col) → Tasks (own) → Shoot Planner (read+comment) →
  Content Calendar (read+comment) → Bot → Chat → Dashboard (own) → Profile

Freelancer:
  Home (own shoots) → Shoot Planner (own rows only) → Profile

> **Profile route (audit L-06):** Profile is accessible to ALL roles and MUST appear in
> every sidebar navigation regardless of role. The route is `/profile` for all users —
> never role-prefixed, never hidden.
```

---

## 19. ERROR & RECOVERY FLOWS

```
API 401 (session expired):
  → Attempt silent refresh via refresh token
  → If refresh succeeds: retry original request
  → If refresh fails: redirect /login + "Session expired. Please sign in again."
  → After login: return to pre-login page (sessionStorage URL)

API 403 (forbidden):
  → Toast: "You don't have permission for that action."
  → Log to console (never expose endpoint path to user)

API 409 (version conflict):
  → Calendar: inline "Updated by [Name] — [Refresh row →]" gold link
  → Other grids: toast "Changes conflict with recent update. Refreshing..."
  → TanStack Query: invalidate affected query

API 423 (locked period):
  → Toast: "June 2025 is locked. Contact an admin to make changes."
  → No retry — locked state is intentional

API 429 (rate limited):
  → Toast: "Too many requests. Please slow down."
  → Retry after: read from Retry-After response header

API 500 (server error):
  → Toast: "Something went wrong. Try again or contact support."
  → Error logged to console with request ID (from X-Request-ID header)

Bot Anthropic API failure:
  → Toast: "Bot is unavailable. Try again in a moment."
  → No retry for chat messages (user can resend)

WebSocket disconnection:
  → Reconnect with backoff (1s → 2s → 4s... max 30s)
  → Reconnect banner: "Reconnecting..." (amber badge in topbar)
  → On reconnect: TanStack Query refetches all stale data
  → Banner clears
```
