# 01 — PRODUCT REQUIREMENTS DOCUMENT (PRD)
## Skaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §2, UI/UX §4-18, APPFLOW §2-20, AUTH-MATRIX §3, NFR §1-5

---

## 1. PRODUCT OVERVIEW

### 1.1 Purpose
The Skaly Business Portal is Skaly Group's private internal operations platform. It replaces the current fragmented stack (Google Sheets, WhatsApp, verbal coordination) with a unified, role-aware, real-time system for managing the agency's complete monthly content production cycle.

### 1.2 Problem Statement
Skaly Group currently coordinates operations across multiple clients using:
- **Google Sheets** — attendance tracking, task assignment, shoot scheduling, content pipeline, content calendar
- **WhatsApp** — task assignment, shoot confirmations, ad-hoc coordination
- **No system** — freelancer visibility, audit trail, automated period management

This creates: data inconsistency across sheets, no single source of truth, no access control, no audit trail, manual month setup at every period change, and zero visibility for management into real-time operations status.

### 1.3 Solution
A purpose-built internal portal at **portal.skaly.in** with:
- Five operational modules covering the full monthly cycle
- AI management bot for natural-language operations queries and mutations
- Real-time collaboration via WebSocket
- Autonomous monthly rollover — zero human action required
- Role-based access from Admin down to Freelancer
- Cross-module triggers that encode Skaly's actual production workflow

### 1.4 Success Metrics
| Metric | Target |
|--------|--------|
| Monthly setup time | 0 minutes (fully automated rollover) |
| Data sync delay across modules | < 500ms |
| Time to mark attendance (per staff per day) | < 5 seconds |
| Bot query response — Time to First Token (TTFT) | < 2 seconds |
| Bot query response — Full streaming completion | < 8 seconds |
| Unauthorised access incidents | 0 |
| Shoot-to-calendar trigger accuracy | 100% |

---

## 2. USER PERSONAS

### P-01 — Operations Admin (Gyas)
**Goal:** Full visibility and control over all operations, staff, and clients.
**Portal access:** All modules, all settings, audit log, manual rollover trigger, signup request review.
**Pain point today:** Manually recreates sheets every month, no history, no access control.

### P-02 — Content Manager
**Goal:** Coordinate client content production from shoot to posting.
**Portal access:** All operational modules, limited settings (clients, holidays, reports).
**Pain point today:** Juggling three separate sheets to track one client's production cycle.

### P-03 — Team Member (Sohail, Feroz, Naaz)
**Goal:** Know their daily tasks, mark attendance, see content status.
**Portal access:** Own attendance column, own assigned tasks, read-only content modules, chat.
**Pain point today:** Finds out about task assignments through WhatsApp, no task history.

### P-04 — Freelance Videographer
**Goal:** Know their assigned shoot dates, update when complete.
**Portal access:** Own assigned shoot slots only, minimal home view.
**Pain point today:** Gets shoot details through WhatsApp, no record of past shoots.

---

## 3. PRIORITY FEATURES (PRD AMENDMENTS)

### Amendment 1 — Self-Signup with Admin Approval (FR-SIGNUP-01 through FR-SIGNUP-09)

**Requirement:** Any person who attempts to self-register on the portal must complete a detailed signup form and wait for explicit admin approval before gaining any portal access whatsoever.

**Signup form collects (all required unless marked optional):**
1. Full Name
2. Date of Birth
3. Exact Role (dropdown — Team Member, Manager, Freelancer; Admin excluded from self-selection)
4. Mobile Number (with country code, format: +XX-XXXXXXXXXX)
5. Email Address
6. CV / Resume (optional — PDF or DOC, max 5MB)

**Behaviour:**
- After submission, user sees /signup/pending page with their submitted details
- Admin receives real-time notification on all active admin sessions
- Admin reviews in Settings → Signup Requests: sees all submitted fields including CV download
- Admin can approve (with role assignment, which may differ from role requested) or reject
- On approve: Supabase account created, staff row inserted, user receives login link
- On reject: user receives only the `public_rejection_message` — the admin's internal `rejection_note` is **never** transmitted to the user
- Admin role cannot be self-assigned under any circumstance

### Amendment 2 — Gold Column Highlight on Edit (FR-GRID-01 through FR-GRID-04)

**Requirement:** In every grid module, when a user focuses on any editable cell, the entire column containing that cell illuminates with Skaly gold. This persists during the save operation and clears on successful save.

**Behaviour:**
- Trigger: `onFocus` on any editable field in any grid
- Visual: column background `rgba(253,194,87,0.12)`, column borders `rgba(253,194,87,0.60)`
- Only one column highlighted at a time (last focused wins)
- Persists during save in-flight
- On save success: clears normally
- On save failure: column stays highlighted, dot turns red, clears 1.5s after toast
- Virtual-scrolled grids: overlay approach (positioned div, not per-cell class)
- Locked months: no highlight (all cells render as read-only `<span>`)

---

## 4. FUNCTIONAL REQUIREMENTS

### 4.1 Authentication & User Management

| ID | Requirement |
|----|-------------|
| FR-AUTH-01 | System supports email/password login and Google OAuth via Supabase Auth |
| FR-AUTH-02 | Admin and Manager roles require TOTP MFA before portal access |
| FR-AUTH-03 | MFA enrollment is mandatory on first login for Admin/Manager; blocked until complete |
| FR-AUTH-04 | Access tokens expire after 1 hour; silent refresh via refresh token (7-day lifespan) |
| FR-AUTH-05 | Password reset via email link (1-hour validity); all sessions revoked on reset |
| FR-AUTH-06 | TOTP recovery via admin-initiated MFA reset (Settings → Staff) |
| FR-AUTH-07 | Deactivated accounts are blocked at API layer; active sessions are invalidated immediately |
| FR-AUTH-08 | Admin can invite staff by email (primary) or generate copy-link (fallback, 24hr TTL) |
| FR-SIGNUP-01 | Self-signup form collects: Name, DOB, Exact Role, Mobile, Email, CV (optional) |
| FR-SIGNUP-02 | Self-signup role dropdown excludes 'admin' option |
| FR-SIGNUP-03 | Admin role can only be assigned by another admin at approval or in Settings |
| FR-SIGNUP-04 | Pending user sees /signup/pending with polling (10s→30s→60s→stops at 10min) |
| FR-SIGNUP-05 | Admin receives real-time notification for every new signup request |
| FR-SIGNUP-06 | Admin can approve with any role (not restricted to role_requested) |
| FR-SIGNUP-07 | Admin can reject with internal note (private) and user-facing message (public) |
| FR-SIGNUP-08 | Internal rejection_note is never delivered to or visible to the requesting user |
| FR-SIGNUP-09 | CV stored in R2, accessible via presigned URL by Admin/Manager only |

### 4.2 Staff Attendance

| ID | Requirement |
|----|-------------|
| FR-ATT-01 | Attendance grid is pre-generated at rollover for all working days of the new period |
| FR-ATT-02 | Grid rows = working days (Mon–Sat). Sundays auto-greyed and non-interactive |
| FR-ATT-03 | Holidays display as gold-tinted rows with reason tooltip; non-interactive |
| FR-ATT-04 | Team members can only interact with their own attendance column |
| FR-ATT-05 | Team members see other staff columns as read-only (pointer-events:none; API 403 backstop) |
| FR-ATT-06 | Work log field autosaves with 800ms debounce after last keystroke |
| FR-ATT-07 | Gold column highlight (Amendment 2) applies to all editable cells |
| FR-ATT-08 | Locked months render all cells as static text; no interactions |
| FR-ATT-09 | Manager/Admin can add holidays for any period (affects the attendance grid retroactively) |
| FR-ATT-10 | Holiday removal restores the day to a working day |

### 4.3 Work Allocation — Tasks

| ID | Requirement |
|----|-------------|
| FR-TASK-01 | Tasks are created by Manager or Admin only |
| FR-TASK-02 | Tasks have: Date, Client (optional), Description, Assignees, Status, Priority, Dependency, Deadline, Remark, Result, Attachments |
| FR-TASK-03 | Status transitions: To Do → In Progress → Done / Blocked / Cancelled |
| FR-TASK-04 | Task with an unresolved dependency cannot be set to Done (blocked at frontend and API) |
| FR-TASK-05 | Team members can update Status and Result on their assigned tasks only |
| FR-TASK-06 | Tasks are soft-deleted only (deleted_at timestamp); never hard-deleted |
| FR-TASK-07 | File attachments: presigned R2 URL flow; no files pass through the API server |
| FR-TASK-08 | File limits: 50MB per attachment, 200MB total per task; allowed types: PDF, JPG, PNG, MP4, MOV |
| FR-TASK-09 | Date group headers in task grid are collapsible; state persists in session |
| FR-TASK-10 | Gold column highlight (Amendment 2) applies to all editable cells |

### 4.4 Shoot Planner

| ID | Requirement |
|----|-------------|
| FR-SHOOT-01 | Grid rows = all active non-internal clients; columns = dynamic slot count (max across all clients) |
| FR-SHOOT-02 | Clients with fewer slots than the column maximum receive N/A cells (disabled, 15% opacity) |
| FR-SHOOT-03 | Slot state machine: Unset → Scheduled → Confirmed → Completed |
| FR-SHOOT-04 | Confirmed status fires cross-module trigger: sets content_pipelines.coming_shoot_date |
| FR-SHOOT-05 | Shoot slot reset requires explicit confirm:true flag in API body |
| FR-SHOOT-06 | Manager can assign a freelancer to any shoot slot |
| FR-SHOOT-07 | Freelancer assigned to a slot receives a real-time notification |
| FR-SHOOT-08 | Freelancers see only rows where shoot_schedules.freelancer_id = their staff.id |
| FR-SHOOT-09 | Week groupings in UI are computed from slot_date at render time using date-fns; not stored |
| FR-SHOOT-10 | Gold column highlight (Amendment 2) applies to all editable cells |

### 4.5 Content Dropper — Pipeline

| ID | Requirement |
|----|-------------|
| FR-PIPE-01 | Pipeline stages: RAW, Finals, Posted — stored as timestamps, not a status field |
| FR-PIPE-02 | Stage sequence is enforced: Finals requires RAW set; Posted requires Finals set |
| FR-PIPE-03 | Setting Posted fires cross-module trigger: updates content_calendar to 'Posted' |
| FR-PIPE-04 | Coming Shoot Date is auto-populated from shoot planner trigger (source='trigger') |
| FR-PIPE-05 | Manual edit of Coming Shoot Date changes source to 'manual' and removes trigger indicator |
| FR-PIPE-06 | Pipeline status is derived from timestamps at query time; never stored as a field |
| FR-PIPE-07 | Client name inline edit propagates across all modules via TanStack Query invalidation |
| FR-PIPE-08 | Gold column highlight (Amendment 2) applies to all editable cells |

### 4.6 Content Calendar

| ID | Requirement |
|----|-------------|
| FR-CAL-01 | Calendar status vocabulary (6 values): No Activity, Under Progress, Ready, Posted, Pending, Rescheduled |
| FR-CAL-02 | Grid: 31 rows (calendar days) × N client columns |
| FR-CAL-03 | Today's row has gold/06 background and auto-scrolls to view on page load |
| FR-CAL-04 | Pipeline-triggered cells show a 6px gold dot indicator at chip top-right |
| FR-CAL-05 | Optimistic locking: every PATCH includes version number; 409 shows "Updated by [name]" inline |
| FR-CAL-06 | Team members: read-only grid with comment box access |
| FR-CAL-07 | Gold column highlight (Amendment 2) applies to all editable cells |

### 4.7 AI Management Bot

| ID | Requirement |
|----|-------------|
| FR-BOT-01 | Bot accepts natural language for both queries and operational mutations |
| FR-BOT-02 | Every mutation requires a 2-turn confirmation flow before the tool call fires |
| FR-BOT-03 | Bot has access to 22 tools: 11 query tools (default all roles) + 11 mutation tools (default manager/admin) |
| FR-BOT-04 | Tool permissions are configurable per-user via admin permission overrides |
| FR-BOT-05 | Bot uses claude-sonnet-4-6 in production; claude-haiku-4-5-20251001 in dev/test |
| FR-BOT-06 | Bot session history: last 50 turns in Redis, 12-hour TTL |
| FR-BOT-07 | All bot messages are archived to the messages table (channel='bot') |
| FR-BOT-08 | Bot cannot mutate data in locked periods |
| FR-BOT-09 | Bot permission denial message never reveals role hierarchy ("ask admin to update bot access") |
| FR-BOT-10 | User can clear bot session via "New conversation" action |

### 4.8 Common Chat

| ID | Requirement |
|----|-------------|
| FR-CHAT-01 | Infinite scroll chat with cursor-based pagination (50 messages per page) |
| FR-CHAT-02 | Thread replies via parent_id; thread panel slides in from right |
| FR-CHAT-03 | @Mention autocomplete on @ keystroke; mention creates notification for mentioned staff |
| FR-CHAT-04 | Typing indicators via Socket.io event; auto-expire 5s after last event |
| FR-CHAT-05 | Staff online/offline presence via Redis (60s TTL, 30s client heartbeat) |
| FR-CHAT-06 | Full-text search on message content via PostgreSQL GIN index |
| FR-CHAT-07 | "New message ↓" pill when user is scrolled up and new message arrives |
| FR-CHAT-08 | Freelancer role blocked from chat by default (admin configurable per-user) |

### 4.9 Notifications

| ID | Requirement |
|----|-------------|
| FR-NOTIF-01 | In-app notifications delivered via Socket.io to connected sessions; stored in DB for offline delivery |
| FR-NOTIF-02 | All 14 event types produce notifications (see TRD §10 for full type list) |
| FR-NOTIF-03 | Bell icon uses Skaly lion logo mark SVG in outlined/filled states |
| FR-NOTIF-04 | rollover_failed notifications display in full (no truncation) with inline action button |
| FR-NOTIF-05 | "Mark all read" action via PUT /notifications/read-all with animated fade |
| FR-NOTIF-06 | Phase 2: push notifications via FCM (Android) and APNs (iOS) |

### 4.10 Search

| ID | Requirement |
|----|-------------|
| FR-SEARCH-01 | CMD+K / Ctrl+K triggers search palette from any portal page |
| FR-SEARCH-02 | 200ms debounce after last keystroke before search fires |
| FR-SEARCH-03 | Four result categories: Tasks, Clients, Staff, Comments |
| FR-SEARCH-04 | Scope toggle: [This month] (default) and [All time] |
| FR-SEARCH-05 | All-time results include period label inline |
| FR-SEARCH-06 | Staff result navigation: Admin/Manager → full profile; Team Member/Freelancer → public profile modal |

### 4.11 Reports & Dashboard

| ID | Requirement |
|----|-------------|
| FR-REPORT-01 | Reports generated server-side using @react-pdf/renderer (backend only) |
| FR-REPORT-02 | Report types: client_monthly and org_monthly |
| FR-REPORT-03 | Generated reports stored in R2; accessible via presigned URL |
| FR-REPORT-04 | Reports older than 30 days: R2 cleaned up, [Regenerate] button shown |
| FR-DASH-01 | Dashboard data sourced exclusively from materialised views; never raw tables at render |
| FR-DASH-02 | Each role receives a distinct dashboard layout (Admin / Manager / Team Member / Freelancer) |

### 4.12 Monthly Rollover

| ID | Requirement |
|----|-------------|
| FR-ROLLOVER-01 | Cron fires daily at 00:01 IST (31 18 * * * UTC) |
| FR-ROLLOVER-02 | Idempotency: system checks if target period exists before any DB operations |
| FR-ROLLOVER-03 | New month creation AND prior month lock execute inside a single transaction |
| FR-ROLLOVER-04 | Rollover generates attendance rows, pipeline rows, shoot slots, calendar cells |
| FR-ROLLOVER-05 | Rollover retries 3 times at 5-minute intervals on failure |
| FR-ROLLOVER-06 | After 3 failures: AI generates plain-language summary; all admins notified |
| FR-ROLLOVER-07 | Materialised views refreshed (CONCURRENTLY) after successful rollover |
| FR-ROLLOVER-08 | Admin can trigger manual rollover from Settings → Months |

### 4.13 Audit & Settings

| ID | Requirement |
|----|-------------|
| FR-AUDIT-01 | Every write operation across all tables is logged to audit_log (append-only) |
| FR-AUDIT-02 | changed_by_source differentiates user, system, and bot actions |
| FR-AUDIT-03 | Admin audit log viewer: filters, row expansion (JSON diff), CSV export |
| FR-AUDIT-04 | No admin can delete or modify audit log rows |
| FR-SET-01 | Admin can lock and unlock periods; unlock requires a reason (stored in months.unlock_reason) |
| FR-SET-02 | Locked period: all grid cells render as read-only; API returns 423 for write attempts |
| FR-SET-03 | Admin can deactivate staff; deactivation invalidates all active sessions immediately |
| FR-SET-04 | Admin can configure per-user permission overrides (any capability, any user) |
| FR-SET-05 | Comment boxes available in: Shoot Planner, Content Dropper, Content Calendar only |
| FR-SET-06 | Comment visibility: team member sees own comments + manager/admin replies in same record |
| FR-SET-07 | Activity feed on home page sourced from /activity-feed (role-filtered); not from /audit-log |

---

## 5. NON-FUNCTIONAL REQUIREMENTS (Summary)

Full specification in **13-NFRS.md**.

| Category | Key Target |
|----------|-----------|
| Page load | < 2s for dashboard; < 1.5s for module grids |
| API response | < 300ms for reads; < 500ms for writes |
| Bot response | TTFT (first words) < 2s; full streaming completion < 8s |
| Concurrent users | 50 simultaneous (full Skaly team) |
| Uptime | 99.5% monthly (Railway + Vercel) |
| Reconnect | WebSocket reconnects within 30s max (PRD NFR-8.2) |
| Data retention | Audit log: 2 years. Reports R2: 30 days. Bot sessions: 12 hours |

---

## 6. OUT OF SCOPE — MVP

| Feature | Notes |
|---------|-------|
| Transactional email notifications | All operational notifications (task_assigned, signup_approved, report_ready, etc.) are in-app only via Socket.io + notification bell. Supabase handles auth emails (invite, password reset) only. |
| Client-facing portal | Internal only |
| Social media posting (direct publish) | Portal tracks status; posting is manual |
| Mobile app (Android/iOS) | Architecture ready; Phase 2 build |
| Push notifications (FCM/APNs) | Requires mobile app; Phase 2 |
| Time tracking UI | Schema included; UI post-MVP |
| WhatsApp Business API | Architecture-ready; post-MVP |
| Google Calendar sync | Future integration |
| AI image / content generation | Not in scope |
| Multi-organisation tenancy | Single org (Skaly Group) |

---

## 7. OPEN DECISIONS

> **OD-01 CLOSED:** Comment acknowledgment (`acknowledged_by`, `acknowledged_at`) is **confirmed in-scope for MVP**. The database schema (`05-BACKEND-SCHEMA.md` §5), API endpoint (`07-API-CONTRACT.md` — `PATCH /v1/comments/:id/acknowledge`), and APPFLOW interactions (`04-APPFLOW.md` §13) are all fully defined. This is not deferred.

| ID | Decision | Deadline |
|----|----------|----------|
| OD-02 | Google Sheets migration plan: manual entry, CSV import, or migration script? | Before Sprint 13 |
| OD-03 | Skaly lion logo SVG: must be received for notification bell design | Before Sprint 10 |
| OD-04 | T1–T4 template component files: must be shared with tech team | Before Sprint 1 |
| OD-05 | Per-client shoot slot counts: must be provided by operations | Before Sprint 5 |
