# 02 — TECHNICAL REQUIREMENTS DOCUMENT (TRD)
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** PRD §4, BACKEND-SCHEMA §1-9, AUTH-MATRIX §2-5, API-CONTRACT §1-3, INFRA §1-6

---

## 1. SYSTEM ARCHITECTURE OVERVIEW

The Scaly Business Portal is a three-tier web application: Next.js 15 frontend on Vercel, Fastify 5 API on Railway, and PostgreSQL 16 on Railway as the primary data store. Supabase provides JWT issuance and OAuth only — it is not used for direct database operations.

```
Browser (portal.skaly.in)
    │ HTTPS + WSS
Fastify 5 API (api.skaly.in)
    │ Kysely queries     │ Socket.io rooms     │ Anthropic SDK
PostgreSQL 16        Upstash Redis         Cloudflare R2
(Railway)            (sessions/presence)   (files/PDFs)
    │
Supabase Auth (JWT/OAuth/TOTP — external, token-issuing only)
```

**Phase 2 (post-MVP):**
React Native + Expo mobile apps (Android + iOS) connect to the same API with identical auth and endpoints. Push notifications delivered via FCM (Android) and APNs (iOS) through the NotificationService.

---

## 2. CONFIRMED TECH STACK

### 2.1 Frontend (apps/web)

| Package | Version | Purpose |
|---------|---------|---------|
| Next.js | **15** | App Router, SSR, TypeScript 5 |
| Tailwind CSS | **4** | `@theme` CSS directive (not tailwind.config.js) |
| shadcn/ui | latest | Radix primitives + Tailwind — accessible headless components |
| Framer Motion | **11** | Page transitions, modal animations, card appearances |
| TanStack Query | v5 | All server state — caching, background refetch, optimistic updates |
| TanStack Table | v8 | All five grid modules |
| TanStack Virtual | v3 | Content Calendar (31×N) and Chat history virtualisation |
| Zustand | 5 | Client-only state (column highlight, modal state, UI prefs) |
| Zod | latest | Shared validation schemas — single source for types + forms |
| date-fns | latest | All date operations, IST timezone handling |
| cmdk | latest | CMD+K search palette |
| socket.io-client | v4 | WebSocket client |
| @react-pdf/renderer | latest | **Server-side only — not in frontend bundle** |
| DOMPurify | latest | Client-side HTML sanitisation for chat messages |

**No Electron. No Tauri. No desktop wrapper. Web browser is the desktop client.**

### 2.2 Backend (apps/api)

| Package | Version | Purpose |
|---------|---------|---------|
| Fastify | **5** | API server — plugin-based, TypeScript |
| Kysely | latest | Type-safe PostgreSQL query builder — no ORM |
| socket.io | v4 | Real-time transport (rooms, namespaces, reconnection) |
| @socket.io/redis-adapter | latest | Redis pub/sub sync across API instances (required for Railway rolling deploys) |
| @anthropic-ai/sdk | latest | AI bot — Sonnet 4.6 prod, Haiku 4.5 dev |
| @aws-sdk/client-s3 | v3 | Cloudflare R2 (S3-compatible API) |
| ioredis | latest | Upstash Redis client |
| zod | latest | Shared schemas (same as frontend) |
| pino | latest | Structured logging → Railway log stream |
| node-cron | latest | Rollover scheduler (00:01 IST daily) |
| @fastify/rate-limit | latest | Per-route rate limiting |
| @fastify/helmet | latest | Security headers |
| @fastify/cors | latest | CORS enforcement |
| @fastify/multipart | latest | CV upload at signup only. Task attachments use presigned R2 PUTs (no files through API server). |

### 2.3 AI Models

| Environment | Model | Model String |
|------------|-------|-------------|
| Production | Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Development / Testing | Claude Haiku 4.5 | `claude-haiku-4-5-20251001` |

> **Sprint 8 verification step:** Before wiring the bot, confirm these model strings against `GET https://api.anthropic.com/v1/models` with your API key. Anthropic model strings are version-specific and must match the API registry exactly — a mismatch returns a 400 immediately. These strings are correct as of this document's date; verify before Sprint 8 begins.

**Rationale for Sonnet in production:** The bot's 22 tool definitions require precise parameter extraction from natural language. Sonnet's instruction-following accuracy prevents bad tool calls (wrong client, wrong date) that would corrupt operational data.

### 2.4 Data Infrastructure

| Service | Purpose | Provider |
|---------|---------|---------|
| PostgreSQL 16 | Primary data store | Railway managed |
| Upstash Redis | Bot sessions, presence, permission cache, rate limit state | Upstash |
| Cloudflare R2 | Task attachments, staff CVs, generated PDFs, DB backups | Cloudflare |
| Supabase Auth | JWT issuance, Google OAuth, TOTP/MFA | Supabase |

### 2.5 Typography — Three-Font Stack (All Required)

| Font | Role | Load Method |
|------|------|------------|
| **Big Shoulders Display** | Brand/display — all headings, module titles, stat numbers | `next/font/google` |
| **DM Sans** | UI/body — all labels, descriptions, messages, button text | `next/font/google` |
| **DM Mono** | Data — timestamps, IDs, table cell values, code, file names | `next/font/google` |

```typescript
// app/layout.tsx
import { Big_Shoulders_Display, DM_Sans, DM_Mono } from 'next/font/google'
const bigShoulders = Big_Shoulders_Display({ subsets: ['latin'], display: 'swap',
  weight: ['400','600','700'],  // matches UI/UX type scale — audit L-01
  variable: '--font-display' })
const dmSans = DM_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-body' })
const dmMono = DM_Mono({ subsets: ['latin'], display: 'swap', weight: ['400','500'],
  variable: '--font-mono' })
```

---

## 3. MONOREPO STRUCTURE

```
skaly-portal/
├── apps/
│   ├── web/                    Next.js 15 — portal.skaly.in
│   │   ├── app/
│   │   │   ├── (auth)/         login, signup, mfa-setup, forgot-password, reset-password
│   │   │   ├── (portal)/       all authenticated module routes
│   │   │   │   ├── home/
│   │   │   │   ├── attendance/
│   │   │   │   ├── tasks/
│   │   │   │   ├── shoot-planner/
│   │   │   │   ├── content-dropper/
│   │   │   │   ├── content-calendar/
│   │   │   │   ├── chat/
│   │   │   │   ├── bot/
│   │   │   │   ├── dashboard/
│   │   │   │   └── settings/
│   │   ├── components/
│   │   │   ├── ui/             shadcn/ui base components
│   │   │   ├── modules/        module-specific grid and panel components
│   │   │   ├── templates/      T1-T4 design template components
│   │   │   └── shared/         Nav, Header, NotificationBell, SearchPalette
│   │   ├── hooks/
│   │   │   ├── useColumnHighlight.ts   Amendment 2 implementation
│   │   │   ├── useMonthContext.ts      period state + URL sync
│   │   │   └── usePresence.ts
│   │   ├── lib/                api client, auth helpers, utils
│   │   └── store/              Zustand stores
│   └── api/                    Fastify 5 — api.skaly.in
│       └── src/
│           ├── routes/         per-domain route plugins
│           ├── services/       business logic layer
│           ├── middleware/      auth, rbac, rate-limit plugins
│           ├── bot/            AI agent, tool definitions, permission guard
│           ├── jobs/           rollover scheduler, backup, view refresh
│           └── events/         EventEmitter bus for cross-module triggers
├── packages/
│   ├── shared/                 Zod schemas, TypeScript types, constants
│   └── config/                 ESLint, TypeScript, Prettier configs
├── database/
│   ├── migrations/             Kysely migration files (source of truth)
│   └── seeds/                  system actor seed, default permissions
└── docker-compose.yml          local dev: PostgreSQL 16 + Redis
```

---

## 4. FRONTEND ARCHITECTURE

### 4.1 Routing
Next.js 15 App Router. All authenticated routes wrapped in a layout that:
1. Reads JWT from HTTP-only cookie
2. Validates against Supabase Auth
3. Checks `mfa_enrolled` — if false for admin/manager → redirect to /mfa-setup
4. Checks `active` flag — if false → redirect to /login with 'ACCOUNT_DEACTIVATED' code

### 4.2 Server State (TanStack Query v5)
All API data managed via TanStack Query. Key patterns:
- Query keys always include `period` parameter: `['attendance', period, staffId]`
- Optimistic updates on grid mutations
- `invalidateQueries` used after bot mutations to sync UI
- `staleTime: 30_000` for module grids (30s before background refetch)

### 4.3 Grid Implementation (TanStack Table v8 + TanStack Virtual v3)
All five operational grids use TanStack Table. TanStack Virtual applied on:
- **Content Calendar:** rows virtualised (31 rows × N columns — largest grid)
- **Chat:** message list virtualised (unbounded history)

### 4.4 Client State (Zustand 5)
```typescript
// Column Highlight Store (Amendment 2)
interface ColumnHighlightStore {
  activeColumnId: string | null;
  setActiveColumn: (id: string | null) => void;
  clearActiveColumn: () => void;
}

// Month Context Store
interface MonthContextStore {
  period: string;           // 'YYYY-MM'
  setPeriod: (p: string) => void;
}
// Period ALWAYS reflected in URL: ?period=YYYY-MM
// On period change: router.push updates URL, all module queries re-keyed
```

---

## 5. BACKEND ARCHITECTURE

### 5.1 Fastify Plugin Architecture
```
server.ts
├── @fastify/helmet
├── @fastify/cors         (portal.skaly.in + localhost:3000 only)
├── @fastify/rate-limit
├── authPlugin            (JWT verification via Supabase public key)
├── rbacPlugin            (role check + per-user permission override from Redis)
├── routes/auth           /v1/auth/*
├── routes/staff          /v1/staff/*
├── routes/clients        /v1/clients/*
├── routes/months         /v1/months/*
├── routes/attendance     /v1/attendance/*
├── routes/tasks          /v1/tasks/*
├── routes/shoot-planner  /v1/shoot-planner/*
├── routes/content-dropper/v1/content-dropper/*
├── routes/content-calendar /v1/content-calendar/*
├── routes/bot            /v1/bot/*
├── routes/chat           /v1/chat/*
├── routes/notifications  /v1/notifications/*
├── routes/comments       /v1/comments/*
├── routes/search         /v1/search
├── routes/reports        /v1/reports/*
├── routes/dashboard      /v1/dashboard/*
├── routes/settings       /v1/settings/*
└── routes/internal       /v1/internal/*   (X-Internal-Secret header — separate from JWT auth plugin)
```

### 5.2 Service Layer Pattern
```typescript
// Business logic never lives in route handlers
// Route handler → Service method → Kysely query
// Example:
class ShootPlannerService {
  async confirmSlot(id: string, staffId: string, trx?: Transaction): Promise<ShootSlot> {
    // 1. Check month not locked (423 if locked)
    // 2. Update shoot_schedules row
    // 3. COMMIT
    // 4. Emit cross-module trigger event
    // 5. Notify freelancer if assigned
  }
}
```

### 5.3 Cross-Module Event Bus
```typescript
// apps/api/src/events/event-bus.ts
import { EventEmitter } from 'events';
export const eventBus = new EventEmitter();

// Trigger 1: Shoot Confirmed → Content Dropper
eventBus.on('shoot:confirmed', async ({ clientId, period, slotDate }) => {
  await ContentDropperService.setComingShootDate(clientId, period, slotDate, 'trigger');
  io.to('org:all').emit('content-dropper:updated', { clientId, period });
});

// Trigger 2: Pipeline Posted → Content Calendar
eventBus.on('pipeline:posted', async ({ clientId, period, postedAt }) => {
  await ContentCalendarService.updateCell(clientId, period, postedAt, 'Posted', 'pipeline_trigger');
  io.to('org:all').emit('content-calendar:updated', { clientId, period });
});
```

---

## 6. DATABASE DESIGN

Full schema in **05-BACKEND-SCHEMA.md**. Summary of key architectural decisions:

| Decision | Rationale |
|----------|-----------|
| `pipeline_status` removed from content_pipelines | Derived from timestamps via CASE expression — stored field creates sync corruption risk |
| `week_number` removed from shoot_schedules | Flat `slot_index` (1..N). Week grouping computed at render from `slot_date` via `date-fns getISOWeek()` |
| `shoot_slots_per_month` has no DEFAULT | Explicit value required at client creation — prevents misconfiguration |
| `audit_log.staff_id` nullable | System-generated events (rollover) have no user; uses System Actor UUID `00000000-0000-0000-0000-000000000000` |
| `changed_by_source` enum in audit_log | Distinguishes user / system / bot actions without nullable FK ambiguity |
| Rollover lock INSIDE transaction | New month creation + prior month lock commit atomically or both roll back |
| Optimistic locking on content_calendar | `version` column — PATCH includes version; 409 on mismatch |

---

## 7. AUTHENTICATION ARCHITECTURE

See **08-AUTH-MATRIX.md** for full specification. Summary:

**Three-layer enforcement:**
1. **Next.js Middleware** — Route protection; redirects to /login if JWT absent or expired
2. **Fastify Auth Plugin** — JWT verification via Supabase RS256 public key; role check per route
3. **Service Layer** — Per-user permission override from Redis `perms:{staffId}` (5-min TTL); month lock check; record ownership check

**Staff lookup:** JWT contains `sub` (Supabase UID). Backend looks up `staff` row by `supabase_uid` → cached in Redis `staff_lookup:{supabaseUid}` (5-min TTL).

**MFA:** TOTP via Supabase Auth. Mandatory for admin and manager roles before any portal access.

---

## 8. REAL-TIME ARCHITECTURE

**Transport:** Socket.io v4 on Fastify HTTP server. Three namespaces:
- `/ws/chat` — chat messages and typing indicators
- `/ws/presence` — staff online/offline state
- `/ws/notify` — notification delivery and live grid updates

**Redis Adapter — configured in Sprint 0, not Phase 2:**
Railway performs zero-downtime rolling deployments, meaning two API instances run concurrently during every deploy. Without the Redis adapter, broadcasts fired on the new instance will not reach clients connected to the old instance — chat messages and pipeline triggers will silently drop. Since Upstash Redis is already in the stack, this is a 4-line change with no new dependencies:
```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

const pubClient = new Redis(process.env.REDIS_URL, { tls: {} });
const subClient = pubClient.duplicate();
io.adapter(createAdapter(pubClient, subClient));
```
Add `@socket.io/redis-adapter` to `apps/api/package.json`. This is part of Sprint 0 Definition of Done.

**Reconnection config (satisfies PRD NFR — max 30s between attempts):**
```javascript
const socket = io(WS_URL, {
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
  reconnectionAttempts: Infinity
});
```

**Presence model:**
- Client connects → `SET presence:{staffId} 1 EX 60` (Redis key, 60s TTL)
- Client sends `ping` every 30s → `EXPIRE presence:{staffId} 60` (TTL reset)
- Client disconnects → Redis key expires naturally within 60s
- `GET /chat` load → `KEYS presence:*` → online staff list

**Room joining (audit H-05) — connection handler runs this on every authenticated socket connect:**
```typescript
io.on('connection', (socket) => {
  const { staffId, role } = socket.handshake.auth;  // populated by JWT validation
  
  // Personal room — always
  socket.join(`user:${staffId}`);
  
  // Role-specific rooms (for role:admin and role:manager broadcasts)
  // Note: role:team_member and role:freelancer rooms are not currently used,
  //       but joining them is harmless and future-proofs the architecture.
  socket.join(`role:${role}`);
  
  // Org-wide room — every authenticated user joins this
  // (carries grid updates, month rollover events, calendar changes, presence)
  socket.join('org:all');
});
```

**Room broadcast patterns:**

| Room | Scope | Joined By |
|------|-------|----------|
| `user:{staffId}` | Personal notifications, task assignments, bot:message tokens | Owner only |
| `role:admin` | New signup requests, rollover failures, month_ready alerts | All admins on connect |
| `role:manager` | (reserved for future manager-only broadcasts) | All managers on connect |
| `org:all` | Grid updates, month rollover, calendar changes, presence | Every authenticated user |

---

## 9. AI BOT ARCHITECTURE

### 9.1 Request Pipeline
```
POST /v1/bot/message { content: "..." }
  → Load Redis session bot:session:{staffId} (50 turns, 12hr TTL)
  → Build system prompt:
      - Current IST date + period
      - User role + staff name
      - Anti-hallucination: "Only use provided tools. If data is unavailable, say so."
  → Filter tool list to permitted tools for this staff member
  → Call Anthropic API (claude-sonnet-4-6, max_tokens: 1024, stream: true)  ← delivers tokens incrementally; TTFT target < 2s
  → If tool_use blocks in response:
      - Validate tool in user's permitted list
      - Validate month not locked (for mutation tools)
      - Execute service method (same validation as direct REST API call)
      - Collect tool_result
      - Second Anthropic call with tool_results → final text response
  → Stream final response via Socket.io to client
  → Update Redis session (append new turns)
  → Archive both user message and bot response to messages table (channel='bot')
```

### 9.2 Mutation Confirmation Protocol
**Every mutation requires explicit user confirmation before the tool call fires.**
```
Turn 1 (no tool call):
  Bot presents: action, entity, values, "Shall I proceed?"
Turn 2 (user confirms):
  Bot executes tool call → action performed → confirmation with deep link
```
If user says anything other than clear affirmative on turn 2, bot cancels and asks for clarification.

### 9.3 Tool Registry

**Query Tools (11) — permitted for all roles by default:**
`get_project_status`, `list_tasks`, `list_overdue_tasks`, `get_user_workload`,
`get_attendance`, `get_shoot_schedule`, `get_content_pipeline`,
`get_content_calendar`, `get_audit_log`, `get_holiday_list`, `get_client_summary`

**Mutation Tools (11) — permitted for manager/admin by default (configurable):**
`update_task_status`, `update_pipeline_stage`, `update_shoot_slot`, `create_task`,
`set_deadline`, `add_holiday`, `remove_holiday`, `assign_task`,
`update_calendar_cell`, `add_client`, `deactivate_client`

### 9.4 Session Management
- Active session: Redis `bot:session:{staffId}` — serialised conversation array, 50-turn limit, 12hr TTL
- Persistent archive: `messages` table, `channel = 'bot'`
- Clear: `DELETE /v1/bot/session/current` — removes Redis key; next message starts fresh session

---

## 10. NOTIFICATION SYSTEM

### 10.1 Notification Types
```typescript
type NotificationType =
  | 'month_ready' | 'task_assigned' | 'task_overdue' | 'dependency_resolved'
  | 'shoot_confirmed' | 'holiday_added' | 'holiday_removed'
  | 'rollover_failed' | 'rollover_success' | 'rollover_view_refresh_failed'
  | 'new_comment' | 'mention'
  | 'signup_request' | 'signup_approved' | 'signup_rejected'
  | 'client_updated' | 'report_ready'
  | 'account_reactivated';
```

### 10.2 Delivery Flow
```
1. Service writes notification row to DB
2. Socket.io: io.to('user:{staffId}').emit('notify:new', notification)
3. If user online: bell badge increments + toast (3s auto-dismiss, except rollover_failed)
4. If user offline: stored in DB; fetched on next GET /v1/notifications
```

### 10.3 Special Handling
- `rollover_failed`: full-height notification (no truncation), red tint, [Manual rollover] inline CTA, never auto-dismisses
- `signup_request`: delivered to `role:admin` room — all connected admins receive simultaneously

---

## 11. FILE STORAGE (CLOUDFLARE R2)

### 11.1 Storage Paths
```
Task attachments:    attachments/{taskId}/{uuid}-{filename}
Staff CVs:           cvs/{staffId}/cv.pdf
Signup request CVs:  cvs/requests/{requestId}/cv.pdf
Generated reports:   reports/{period}/{type}-{uuid}.pdf
Database backups:    backups/{YYYY-MM-DD}/dump.sql.gz
```

### 11.2 Upload Flows
**Task attachments (presigned URL — no files through API server):**
1. `POST /v1/tasks/:id/attachments/presign` → returns `{ presignedUrl, fileKey }`
2. Browser PUTs file directly to R2 presigned URL (progress tracked client-side)
3. `POST /v1/tasks/:id/attachments/confirm` → creates `task_attachments` row

**CV upload at signup:** `@fastify/multipart` → validation → R2 upload → fileKey stored in `signup_requests.cv_file_key` or `staff.cv_file_key`

---

## 12. MOBILE ARCHITECTURE (PHASE 2 — REACT NATIVE + EXPO)

**No desktop app. No Electron. No Tauri. The web browser is the desktop client.**

### 12.1 Tech Stack (Phase 2)
```
React Native + Expo (managed workflow, SDK 51+)
Expo Router v3           file-based navigation
NativeWind v4            Tailwind-class styling for React Native
@supabase/supabase-js    auth with react-native-async-storage
socket.io-client         same real-time connection as web
Expo Notifications       push token registration and receipt
Expo SecureStore         JWT token storage (replaces HTTP-only cookie)
React Native Reanimated  animations
```

### 12.2 Monorepo Integration
```
apps/mobile/
├── app/              Expo Router file-based routes
│   ├── (auth)/       login, signup screens
│   ├── (tabs)/
│   │   ├── index.tsx      Home tab
│   │   ├── tasks.tsx      Tasks tab
│   │   ├── calendar.tsx   Calendar tab
│   │   ├── chat.tsx       Chat tab
│   │   └── profile.tsx    Profile tab
├── components/
├── hooks/
└── lib/              api client (same base URL as web: api.skaly.in/v1)
```

Mobile apps share the same `packages/shared` Zod schemas and TypeScript types as the web app. API base URL is identical. JWT auth flow is identical except tokens stored in Expo SecureStore instead of HTTP-only cookies.

### 12.3 Navigation (5 Bottom Tabs)
```
Home | Tasks | Calendar | Chat | Profile
```
Additional modules accessible from Home via quick-link cards. No sidebar navigation on mobile.

### 12.4 API Compatibility
The existing REST API and WebSocket server require zero changes to support mobile clients. All mobile requests include the same `Authorization: Bearer <token>` header. Socket.io client is identical.

---

## 13. PUSH NOTIFICATION ARCHITECTURE (PHASE 2)

### 13.1 Database Changes Required
```sql
-- Already included in staff table schema
push_token     TEXT  NULL  -- FCM registration token or APNs device token
push_platform  VARCHAR(10) NULL CHECK (push_platform IN ('ios','android'))
```

### 13.2 Push Token Registration
```
Mobile app launch:
  → Expo Notifications.requestPermissionsAsync()
  → If granted: Expo Notifications.getExpoPushTokenAsync({ projectId: EXPO_PROJECT_ID })
  → PATCH /v1/staff/me/push-token { pushToken, platform }
  → staff.push_token and staff.push_platform updated
  
Token expiry/rotation:
  → If FCM returns DeviceNotRegistered → clear push_token and push_platform in DB
```

### 13.3 Server-Side Dispatch
```typescript
// apps/api/src/services/notification.service.ts
async function sendPush(staffId: string, payload: PushPayload): Promise<void> {
  const staff = await getStaffById(staffId);
  if (!staff.pushToken) return; // no token — skip push (in-app only)
  
  if (staff.pushPlatform === 'android') {
    await fcm.send({ token: staff.pushToken, notification: payload });
  } else if (staff.pushPlatform === 'ios') {
    await apns.send({ deviceToken: staff.pushToken, notification: payload });
  }
}
```

### 13.4 Environment Variables (Phase 2)
```
EXPO_PROJECT_ID=
FCM_SERVER_KEY=
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_KEY_PATH=
APNS_BUNDLE_ID=in.skaly.portal
```

---

## 14. SECURITY

| Control | Implementation |
|---------|---------------|
| JWT verification | RS256 — Supabase public key; never trust client-provided claims |
| CORS | Restricted to portal.skaly.in + localhost:3000 |
| Rate limiting | See API-CONTRACT §5 for per-route limits |
| HTTPS | Enforced by Vercel + Railway; HTTP → HTTPS redirect |
| SQL injection | Impossible via Kysely parameterised queries |
| XSS | DOMPurify on all chat message content; shadcn/ui uses safe rendering |
| File upload | MIME type validation + file size limits enforced at service layer |
| Audit trail | All writes logged; append-only; no admin can delete rows |
| Secrets | Never in code; all in environment variables; Railway + Vercel secrets vaults |
| Month locking | Locked period: API returns 423; frontend blocks are UX only |

---

## 15. ENVIRONMENT VARIABLES

### Web App (Vercel)
```
NEXT_PUBLIC_API_URL=https://api.skaly.in/v1
NEXT_PUBLIC_WS_URL=wss://api.skaly.in
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### API Server (Railway)
```
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://...  (Railway managed)
REDIS_URL=rediss://...         (Upstash TLS)
SUPABASE_JWT_SECRET=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_MODEL_DEV=claude-haiku-4-5-20251001
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=skaly-portal
R2_PUBLIC_URL=          (only if CDN enabled; otherwise presigned URLs only)
CRON_SECRET=            (for /internal/* routes — sent as X-Internal-Secret: <value> header, not Bearer JWT)
```
