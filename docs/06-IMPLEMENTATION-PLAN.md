# 06 — IMPLEMENTATION PLAN
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** PRD §3-4, TRD §3, BACKEND-SCHEMA §2, INFRA §3

---

## 1. PROJECT OVERVIEW

**Duration:** 14 sprints (14 weeks)
**Team:** 1 Tech Lead (TL) + 3 Developers (D1, D2, D3)
**Platform:** Web MVP (portal.skaly.in). Mobile Phase 2 (separate timeline).
**Goal:** Portal live at portal.skaly.in, fully autonomous rollover, all 5 operational modules, AI bot, real-time chat, admin settings.

---

## 2. SPRINT SUMMARY

| Sprint | Week | Focus | Owner | Deliverable |
|--------|------|-------|-------|-------------|
| 0 | 1 | Foundation & Design System | ALL 4 | Stack live, DB schema migrated, CSS vars, fonts, highlight hook |
| 1 | 2 | Auth + Signup (all 6 fields + MFA) | TL + D1 | Login, self-signup, invite, TOTP, pending page |
| 2 | 3 | DB Schema + API Scaffold | TL + D2 + D3 | All 20+ tables, base route patterns, RBAC middleware |
| 3 | 4 | Staff Attendance | D1 + D2 | Attendance grid, holidays, toggle, work log |
| 4 | 5 | Work Allocation — Tasks | D1 + D3 | Tasks grid, dependency blocking, file attachments |
| 5 | 6 | Shoot Planner | TL + D2 | Dynamic grid, slot state machine, freelancer assign |
| 6 | 7 | Content Dropper + Trigger 1 | TL + D1 | Pipeline grid, stage sequence, shoot→dropper trigger |
| 7 | 8 | Content Calendar + Trigger 2 | D1 + D2 | 31×N grid, 6 statuses, dropper→calendar trigger |
| 8 | 9 | AI Bot (Query Tools) | TL + D3 | 11 query tools, response cards, session management |
| 9 | 10 | AI Bot (Mutation) + Search | TL + D3 | 11 mutation tools, confirmation flow, CMD+K |
| 10 | 11 | Chat + Notifications | D2 + D3 | Common chat, threads, @mentions, bell system |
| 11 | 12 | Dashboard + Settings | D1 + D2 | All 4 role dashboards, full settings panel |
| 12 | 13 | Rollover + PDF Reports + Comments | TL + D3 | Cron, transaction, retry, PDF, comment boxes |
| 13 | 14 | QA + Performance + Launch | ALL 4 | portal.skaly.in live |

---

## 3. SPRINT 0 — FOUNDATION & DESIGN SYSTEM

**Duration:** Week 1 | **Owner:** All 4 developers

### 3.1 Infrastructure Setup
- [ ] Railway account — provision PostgreSQL 16 (staging + production)
- [ ] Railway cron service configured for rollover (`31 18 * * *` UTC)
- [ ] Vercel project connected to GitHub repository
- [ ] Upstash Redis instances (staging + production)
- [ ] Cloudflare R2 buckets (staging + production) with private access
- [ ] Supabase project — Auth configured (email/password + Google OAuth + TOTP)
- [ ] GitHub repository — branch protection on `main`, PR reviews required
- [ ] GitHub Actions CI workflow: typecheck + lint + Vitest on every PR
- [ ] Vercel preview URLs on every PR (automatic via GitHub integration)
- [ ] Docker Compose working on all 4 developer machines (PostgreSQL 16 + Redis)

### 3.2 Monorepo Scaffolding
- [ ] pnpm workspace configured with `apps/web`, `apps/api`, `apps/mobile` (skeleton), `packages/shared`, `packages/config`
- [ ] TypeScript 5 configured across all packages
- [ ] Shared ESLint config in `packages/config`
- [ ] `packages/shared` with initial Zod schemas and TypeScript types

### 3.3 Frontend Foundation
- [ ] Next.js 15 app created with App Router and TypeScript
- [ ] Tailwind CSS 4 installed — `@theme` directive configured in `globals.css`
- [ ] Three fonts loaded via `next/font/google`: Big Shoulders Display, DM Sans, DM Mono
- [ ] All CSS variables from UI/UX §2.1 added to `globals.css` (single source of truth)
- [ ] shadcn/ui installed — Tailwind 4 compatible configuration
- [ ] Framer Motion 11 installed
- [ ] `useColumnHighlight` hook built and unit tested (Amendment 2)
- [ ] Gold column overlay component built for virtual-scrolled grids
- [ ] Gold column highlight demo on placeholder grid — verified correct

### 3.4 Backend Foundation
- [ ] Fastify 5 app structure created with all route plugin stubs
- [ ] Kysely configured with PostgreSQL connection and pool settings (min: 2, max: 20)
- [ ] All 20+ table migrations written and run on Docker local PostgreSQL
- [ ] All 20+ table migrations run on Railway staging PostgreSQL
- [ ] System actor seed record created (`00000000-0000-0000-0000-000000000000`)
- [ ] `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` configured
- [ ] `GET /v1/health` endpoint returning DB + Redis status
- [ ] Pino logger configured with Railway log stream format
- [ ] Upstash Redis connected and ping-tested
- [ ] `@socket.io/redis-adapter` installed and configured (Sprint 0, NOT Phase 2)
  - Railway rolling deploys run two instances simultaneously — without this, broadcasts split during every deploy
  - 4 lines of code using existing Upstash Redis connection: pubClient + subClient + `io.adapter(createAdapter(...))`

### 3.5 Sprint 0 Definition of Done (ALL required before Sprint 1)
```
✅ All infrastructure provisioned (Railway, Vercel, R2, Upstash, Supabase)
✅ GitHub Actions CI passes on a test PR
✅ Docker Compose runs on all 4 machines without errors
✅ All 20+ DB tables migrated to Railway staging
✅ pg_trgm extension enabled on staging PostgreSQL
✅ globals.css CSS variables live in Next.js
✅ All three fonts loading correctly in browser
✅ Framer Motion 11 installed
✅ useColumnHighlight hook with passing Vitest unit tests
✅ Gold overlay approach working in a demo grid
✅ GET /v1/health returns { status: 'ok' } from Railway staging
✅ Socket.io Redis adapter (@socket.io/redis-adapter) configured on Socket.io server
✅ Internal routes use X-Internal-Secret header (not Authorization: CRON_SECRET)
✅ T1-T4 template files received from design lead and reviewed
✅ Skaly lion logo SVG received (or placeholder confirmed for dev)
```
**If any item is unchecked at end of Week 1: Sprint 1 does not begin.**

---

## 4. SPRINT 1 — AUTH + SIGNUP

**Duration:** Week 2 | **Owner:** TL + D1

### 4.1 Backend
- [ ] Fastify auth plugin: Supabase JWT verification (RS256 public key)
- [ ] JWT enrichment: `supabase_uid` → staff row lookup, cached in Redis `staff_lookup:{uid}` (5-min TTL)
- [ ] RBAC plugin: route-level role check + service-layer permission override check
- [ ] `POST /v1/auth/invite` — creates invite_links row + Supabase inviteUserByEmail
- [ ] `POST /v1/auth/signup/invite` — validates token, creates Supabase user + staff row (with all 6 fields)
- [ ] `POST /v1/auth/signup/request` — creates signup_requests row + uploads CV to R2
- [ ] **Audit H-04:** Service rejects signup if email already exists in staff (active OR soft-deleted) — returns `ALREADY_PROCESSED`. Partial unique index on `signup_requests(email) WHERE status='pending'` enforces no duplicate pending requests at DB level.
- [ ] **Audit M-02:** On signup approval, `AttendanceService.backfillCurrentPeriod(newStaffId)` runs immediately after staff row creation.
- [ ] `POST /v1/auth/signup-requests/:id/approve` — creates user + staff + notification
- [ ] `POST /v1/auth/signup-requests/:id/reject` — updates status + notification (rejection_note never transmitted to user)
- [ ] `GET /v1/settings/signup-requests` — admin only
- [ ] Password reset: `POST /v1/auth/password-reset`, `POST /v1/auth/password-reset/confirm`
- [ ] Session: `POST /v1/auth/refresh`, `DELETE /v1/auth/session`
- [ ] MFA: `POST /v1/auth/mfa/enroll`, `POST /v1/auth/mfa/verify`

### 4.2 Frontend
- [ ] `/login` page — email/password + Google OAuth buttons
- [ ] `/signup` page — dual path (Google OAuth pre-fill + email form) with all 6 required fields
- [ ] Role dropdown excludes 'admin' in self-signup
- [ ] `/signup/pending` page — polling (10s→30s→60s→stops at 10min) + handles rejection
- [ ] `/mfa-setup` page — QR code, manual entry code, verification, recovery codes with confirmation checkbox
- [ ] MFA enforcement guard: admin/manager redirected to /mfa-setup if `mfa_enrolled = false`
- [ ] `/forgot-password` and `/reset-password` pages
- [ ] Next.js middleware — route protection for `(portal)` group
- [ ] Session management: silent refresh at 55-minute mark
- [ ] Deactivated account error handling: "Account deactivated. Contact your admin."

### 4.3 Settings (Admin)
- [ ] `/settings/signup-requests` — review panel with CV download button
- [ ] Approve flow with role assignment dropdown
- [ ] Reject flow with internal note + public message fields

### 4.4 Tests
- [ ] Unit: Zod schema validation for signup_requests fields
- [ ] Integration: full invite flow (create → use → staff row exists)
- [ ] Integration: self-signup → admin approves → staff can login
- [ ] Integration: admin-only endpoints return 403 for non-admin roles
- [ ] Integration: rejection_note never included in rejection notification payload

---

## 5. SPRINT 2 — DATABASE SCHEMA + API SCAFFOLD

**Duration:** Week 3 | **Owner:** TL + D2 + D3

- [ ] Complete Kysely type definitions for all 20+ tables (generated from schema)
- [ ] Base service pattern established: validation → ownership check → month lock check → write → audit → event emit
- [ ] `AuditService.log()` utility function — used in all subsequent service methods
- [ ] `NotificationService.create()` — writes to DB + broadcasts via Socket.io
- [ ] `EventBus` module with shoot:confirmed and pipeline:posted event definitions
- [ ] Socket.io server configured: 3 namespaces, JWT auth on handshake, room assignment on connect
- [ ] Redis presence model implemented (SET presence:{staffId} 1 EX 60, 30s heartbeat)
- [ ] Month lock check utility: `assertPeriodNotLocked(period, trx)` — used in all write service methods
- [ ] `GET /v1/clients` — active clients list
- [ ] `GET /v1/months` + `GET /v1/months/current`
- [ ] `GET /v1/staff` — limited fields for all roles
- [ ] `GET /v1/staff/:id` — full profile for admin/manager/own
- [ ] **Audit C-02:** Attendance service includes optimistic lock version check on every PATCH — service rejects mismatched version with HTTP 409 STALE_DATA. Schema comment confirms "version" is active, not future.
- [ ] **Audit C-04:** Audit log service uses System Actor UUID (00000000-0000-0000-0000-000000000000) for all automated entries. Never NULL staff_id.
- [ ] Presigned URL utilities for R2 (upload + download)

---

## 6. SPRINT 3 — STAFF ATTENDANCE

**Duration:** Week 4 | **Owner:** D1 + D2

- [ ] `GET /v1/attendance?period=` — full grid for admin/manager; own-column data for team_member
- [ ] `PATCH /v1/attendance/:id` — ownership enforced: team_member can only update own rows (API 403 backstop)
- [ ] `GET /v1/holidays?period=`, `POST /v1/holidays`, `DELETE /v1/holidays/:id`
- [ ] Holiday addition triggers Socket.io broadcast: `io.to('org:all').emit('attendance:holiday_added')`
- [ ] Mid-month new staff backfill: attendance rows generated from hire date to end of period
- [ ] Frontend: full-width grid with TanStack Table v8
- [ ] Row types: working (interactive), sunday (greyed), holiday (gold tint)
- [ ] Team member: `pointer-events: none` on other staff columns, CSS only (no JS)
- [ ] Gold column highlight (Amendment 2): `useColumnHighlight` applied to all editable cells
- [ ] Work log: 800ms debounce autosave
- [ ] Locked period: all cells render as `<span>`, banner shown
- [ ] Footer row: per-column total days present

---

## 7. SPRINT 4 — WORK ALLOCATION — TASKS

**Duration:** Week 5 | **Owner:** D1 + D3

- [ ] `GET /v1/tasks?period=&date=&status=&clientId=&assigneeId=` with role-filtered results
- [ ] `POST /v1/tasks` — admin/manager only
- [ ] `PATCH /v1/tasks/:id` — team_member restricted to status+result on own assigned tasks
- [ ] `DELETE /v1/tasks/:id` — soft delete (deleted_at); admin/manager only
- [ ] `POST /v1/tasks/:id/assignees` — creates task_assignees rows + notifications
- [ ] `POST /v1/tasks/:id/attachments/presign`, `confirm`, `download`, `DELETE`
- [ ] Dependency blocking: service validates dependency.status === 'Done' before allowing Done transition
- [ ] Task notification: `task_assigned` sent to each assignee on task creation or reassignment
- [ ] Frontend: TanStack Table grid grouped by date (collapsible headers)
- [ ] Date group collapse: Zustand + sessionStorage persistence
- [ ] Right-panel slide-in form for task creation
- [ ] Attachment panel component: drag-and-drop upload, progress bar, file list
- [ ] Dependency badge: "Blocked by: [description]" when unresolved
- [ ] Gold column highlight on all editable cells

---

## 8. SPRINT 5 — SHOOT PLANNER

**Duration:** Week 6 | **Owner:** TL + D2

- [ ] `GET /v1/shoot-planner?period=` — freelancer: own rows only via freelancer_id filter
- [ ] `PATCH /v1/shoot-planner/:id` — all fields: slotStatus, slotDate, piecesExpected, freelancerId
- [ ] `POST /v1/shoot-planner/:id/reset` — requires `{ confirm: true }` in body; 400 if absent
- [ ] Trigger 1: shoot:confirmed event → ContentDropperService.setComingShootDate
- [ ] Freelancer assignment: `PATCH /v1/shoot-planner/:id { freelancerId }` + notification
- [ ] Mid-month new client backfill: shoot slots generated for remaining weeks
- [ ] **Audit H-03:** Multi-assignee notification — `task_assigned` fires ONCE PER assignee (not combined). Verified by integration test asserting N notifications for N assignees on task creation.
- [ ] Frontend: TanStack Table with dynamic column count
- [ ] Week groupings: computed from slot_date via `date-fns getISOWeek()` at render time
- [ ] N/A cells: `opacity: 0.15`, `pointer-events: none`, "—" display text
- [ ] Slot popover: date picker + pieces stepper + freelancer dropdown + CTA
- [ ] Gold column highlight on all slot cells

---

## 9. SPRINT 6 — CONTENT DROPPER + TRIGGER 1

**Duration:** Week 7 | **Owner:** TL + D1

- [ ] `GET /v1/content-dropper?period=`
- [ ] `PATCH /v1/content-dropper/:id/stage { stage }` — stage sequence validated at service layer
- [ ] Trigger 2: pipeline:posted event → ContentCalendarService.updateCell
- [ ] Client name inline edit: `PATCH /v1/clients/:id { name }` + TanStack Query invalidation
- [ ] **Audit H-02:** Trigger 2 (`pipeline:posted` → calendar update) uses server `CURRENT_DATE` in IST as the cell date. This is an accepted MVP limitation documented in PRD §6 and APPFLOW §15. No `posted_date` field is added in MVP.
- [ ] Frontend: grid with stage cells (timestamp display), progress bar, coming_shoot_date indicator
- [ ] Sequence violation: toast + shake animation before API call
- [ ] Trigger 1 response: toast "Shoot confirmed. Content Dropper updated." + ↑ indicator
- [ ] Gold column highlight on all editable stage cells

---

## 10. SPRINT 7 — CONTENT CALENDAR + TRIGGER 2

**Duration:** Week 8 | **Owner:** D1 + D2

- [ ] `GET /v1/content-calendar?period=` — all 31 days × all active clients
- [ ] `PATCH /v1/content-calendar/:id { status, note, version }` — optimistic locking
- [ ] 409 conflict response handler: inline "Updated by [Name] — [Refresh row →]" message
- [ ] Frontend: TanStack Table + TanStack Virtual v3 (column virtualisation for 620+ cells)
- [ ] Today's row: gold/06 background, auto-scroll on page load
- [ ] Status chips with 6-value vocabulary and colour mapping
- [ ] Pipeline-trigger indicator: 6px gold dot + tooltip
- [ ] Inline popover editor: 200px, status dropdown + note textarea, close on outside click
- [ ] Gold column highlight: overlay approach for virtual-scrolled grid (positioned div)
- [ ] Team member: `pointer-events: none` grid, comment box remains interactive

---

## 11. SPRINT 8 — AI BOT (QUERY TOOLS)

**Duration:** Week 9 | **Owner:** TL + D3

- [ ] **Audit C-01:** `POST /v1/bot/message` returns HTTP 202 with `{ messageId, sessionId }` immediately. Bot tokens delivered EXCLUSIVELY via Socket.io `bot:message` events. HTTP body NEVER contains `content` or `card`.
- [ ] **Audit H-01:** `GET /v1/bot/session/current` returns `{ sessionId, messages, turnCount, lastActivityAt }` per API Contract spec.
- [ ] `DELETE /v1/bot/session/current` clears Redis session
- [ ] All 11 query tool definitions with Zod input schemas
- [ ] System prompt: IST date + period + role + anti-hallucination directive
- [ ] Tool permission filtering: load perms:{staffId} from Redis, filter tool list
- [ ] Bot session management: Redis bot:session:{staffId} (50 turns, 12hr TTL)
- [ ] Bot message archival to messages table (channel='bot')
- [ ] Response card registry: all 11 query tool card types implemented in frontend
- [ ] Frontend: chat-style bot interface, card rendering per tool type
- [ ] Bot model: env-driven — `claude-sonnet-4-6` prod, `claude-haiku-4-5-20251001` dev/test
- [ ] **Verify model strings against Anthropic API** (`GET /v1/models`) before wiring — strings must match API registry exactly (400 on mismatch)
- [ ] [New conversation] control → DELETE session → UI reset

---

## 12. SPRINT 9 — AI BOT (MUTATION) + SEARCH

**Duration:** Week 10 | **Owner:** TL + D3

- [ ] All 11 mutation tool definitions with Zod input schemas
- [ ] Mutation confirmation protocol: bot presents summary + asks for confirmation before tool fires
- [ ] Month lock check in bot: mutation tools return PERIOD_LOCKED in plain language
- [ ] Permission denial message: never reveals role requirement, always says "ask admin"
- [ ] `GET /v1/search?q=&scope=current|all_time` — 4 categories: tasks, clients, staff, comments
- [ ] Search: 200ms debounce on frontend
- [ ] Scope toggle in search palette: [This month] / [All time]
- [ ] Staff result navigation: admin/manager → profile page; team_member/freelancer → public profile modal
- [ ] `GET /v1/activity-feed?period=&limit=10` — separate from audit-log, role-filtered
- [ ] Frontend: CMD+K palette with cmdk, 4 category sections, keyboard navigation
- [ ] Mutation confirmation UI: inline [Confirm] [Cancel] buttons in bot message

---

## 13. SPRINT 10 — CHAT + NOTIFICATIONS

**Duration:** Week 11 | **Owner:** D2 + D3

- [ ] `GET /v1/chat/messages?channel=&limit=&cursor=` — cursor-based pagination
- [ ] `POST /v1/chat/messages { channel, content, parentId? }`
- [ ] `GET /v1/chat/threads/:parentId`
- [ ] `GET /v1/chat/search?q=&channel=`
- [ ] Socket.io: `chat:message`, `chat:typing`, `chat:stop_typing`, `chat:presence` events
- [ ] **Audit H-05:** Socket.io connection handler joins `user:{staffId}`, `role:{role}`, and `org:all` rooms on EVERY authenticated connect. Verified by integration test that admin connecting receives a broadcast sent to `role:admin`.
- [ ] `GET /v1/notifications`, `PUT /v1/notifications/:id/read`, `PUT /v1/notifications/read-all`
- [ ] Full notification type coverage (all 14 types tested)
- [ ] rollover_failed notification: full-height, no truncation, inline action button
- [ ] Frontend: infinite scroll chat (TanStack Virtual), thread panel, @mention autocomplete
- [ ] Typing indicator: 5s auto-expire
- [ ] "New message ↓" pill: scroll-position detection
- [ ] Notification panel: bell icon (Skaly SVG), unread badge, 380px panel, mark-all-read

---

## 14. SPRINT 11 — DASHBOARD + SETTINGS

**Duration:** Week 12 | **Owner:** D1 + D2

- [ ] `GET /v1/dashboard/home` — role-filtered payload (materialised views)
- [ ] `GET /v1/dashboard/stats?period=`
- [ ] All 4 role-specific dashboard layouts (Admin, Manager, Team Member, Freelancer)
- [ ] `PUT /v1/staff/:id/deactivate` + session invalidation
- [ ] **Audit M-01:** `PUT /v1/staff/:id/reactivate` — clears `active=true, deleted_at=NULL` on a previously deactivated staff row. Admin-only. Allows re-onboarding a previously deactivated staff member without creating a duplicate row. Available in Settings → Staff → [Reactivate] button on deactivated rows.
- [ ] `PUT /v1/staff/:id/permissions/:key` — per-user override
- [ ] `PUT /v1/staff/:id/mfa/reset`
- [ ] `PATCH /v1/staff/me/push-token` (Phase 2 mobile registration)
- [ ] Month lock/unlock endpoints with reason enforcement
- [ ] Settings panel: Staff, Clients, Permissions, Signup Requests, Holidays, Months, Audit Log, Reports, Profile
- [ ] Audit log viewer: filters, row expansion (JSON diff), CSV export
- [ ] Per-staff permission override toggles in Settings → Permissions

---

## 15. SPRINT 12 — ROLLOVER + PDF + COMMENTS

**Duration:** Week 13 | **Owner:** TL + D3

- [ ] RolloverJob.run(): idempotency check + full transaction (new month + lock + all row generation)
- [ ] **Audit M-05:** Rollover sets `months.locked_by = SYSTEM_ACTOR_UUID` (NOT NULL) when locking the prior month.
- [ ] **Audit C-03:** Migration 024 (materialised views) ends with non-CONCURRENTLY REFRESH so views are populated immediately.
- [ ] Retry logic: 3 attempts at 5-minute intervals
- [ ] Failure summary: Claude Sonnet generates plain-language message → admin notification
- [ ] `POST /v1/internal/rollover` (header: X-Internal-Secret, handled by `internalAuthPlugin`) + `POST /v1/internal/rollover/manual` (admin JWT)
- [ ] REFRESH MATERIALISED VIEW CONCURRENTLY after successful rollover
- [ ] `POST /v1/reports/generate`, `GET /v1/reports/:id/download`, `GET /v1/reports`
- [ ] @react-pdf/renderer PDF template (Skaly branding: logo, gold accents, white background)
- [ ] `GET /v1/comments`, `POST /v1/comments`, `PATCH /v1/comments/:id/acknowledge`
- [ ] Comment visibility enforcement: team_member sees own + manager/admin replies
- [ ] record_context auto-populated at write time
- [ ] Comment expansion in all 3 eligible modules (shoot_planner, content_dropper, content_calendar)
- [ ] Virtual grid (content_calendar): portal-anchored comment overlay

---

## 16. SPRINT 13 — QA + PERFORMANCE + LAUNCH

**Duration:** Week 14 | **Owner:** All 4

- [ ] Full Playwright E2E suite: all critical user journeys
- [ ] k6 performance tests: p95 < 500ms for all module grids at 50 concurrent users
- [ ] k6 rollover test: execution < 60 seconds
- [ ] k6 bot query test: p95 < 4 seconds
- [ ] Accessibility audit: WCAG 2.1 AA — all grids, all forms
- [ ] Security review: rate limits, CORS, auth headers, presigned URL expiry
- [ ] Production environment variables validated in Railway + Vercel
- [ ] Database backup tested: restore drill from R2 backup
- [ ] Rollover tested manually on production-equivalent staging
- [ ] First-month data migration: client roster and team roster manually entered
- [ ] DNS: portal.skaly.in → Vercel, api.skaly.in → Railway
- [ ] SSL certificates confirmed active on both domains
- [ ] [LAUNCH] Portal live at portal.skaly.in

---

## 17. RISK REGISTER

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| T1–T4 templates not delivered on time | Medium | High — blocks auth UI (Sprint 1) | Have fallback: build auth UI without template, retrofit later |
| Skaly lion SVG not received | Medium | Medium — blocks notification bell | Use placeholder outline icon; swap when received |
| Anthropic API rate limits during bot development | Low | Medium | Use claude-haiku-4-5-20251001 in dev/test throughout |
| Content Calendar virtual scroll + column highlight conflict | Medium | High — core feature | Resolve in Sprint 0 prototype before Sprint 7 depends on it |
| Rollover transaction timing on Railway shared PostgreSQL | Low | High | Test with production-scale data in staging before Sprint 12 |
| Team members not providing shoot slot counts | High | Medium — blocks Sprint 5 | Use placeholder value of 4; update before first production rollover |

---

## 18. EXTERNAL DEPENDENCY TRACKING

| Item | Needed By | Responsible | Status |
|------|-----------|------------|--------|
| Skaly lion logo SVG (outlined + filled) | Sprint 10 | Skaly Group design | ⏳ Pending |
| T1–T4 template component files | Sprint 1 | Design Lead | ⏳ Pending |
| Per-client shoot slot counts | Sprint 5 | Skaly Group operations | ⏳ Pending |
| Comment acknowledgment: MVP or post-MVP | Sprint 7 | Product decision | ⏳ Pending |
| Google Sheets migration plan | Sprint 13 | Skaly Group + TL | ⏳ Pending |
