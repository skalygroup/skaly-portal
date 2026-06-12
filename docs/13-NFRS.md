# 13 — NON-FUNCTIONAL REQUIREMENTS (NFRs)
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §14, IMPL-PLAN §16, TESTING-STRATEGY §7, INFRA §8

---

## 1. PERFORMANCE REQUIREMENTS

All measurements are taken on the production environment with 50 concurrent authenticated users unless noted otherwise.

### 1.1 Page Load Times

| Page | Target (First Contentful Paint) | Target (Time to Interactive) | Measurement |
|------|--------------------------------|------------------------------|-------------|
| Home Page | < 1.5 seconds | < 2.0 seconds | Core Web Vitals (Vercel analytics) |
| Attendance Grid | < 1.0 seconds | < 1.5 seconds | TanStack Query stale time = 30s |
| Tasks Grid | < 1.0 seconds | < 1.5 seconds | Materialised view for dashboard |
| Shoot Planner | < 1.0 seconds | < 1.5 seconds | |
| Content Calendar (31×20 cells) | < 1.5 seconds | < 2.0 seconds | TanStack Virtual required |
| Dashboard | < 1.0 seconds | < 1.5 seconds | Materialised views only |

### 1.2 API Response Times (p95 at 50 concurrent users)

| Endpoint Category | p95 Target | p99 Target |
|------------------|-----------|-----------|
| GET module data (e.g., content calendar) | < 300ms | < 500ms |
| PATCH single cell (attendance, calendar) | < 200ms | < 300ms |
| POST create task | < 300ms | < 500ms |
| GET search results | < 150ms | < 250ms |
| GET notifications | < 100ms | < 200ms |
| GET dashboard/home | < 200ms | < 400ms |
| POST bot/message — **Time to First Token (TTFT)** | < 2000ms | < 3000ms |
| POST bot/message — **Full streaming completion** | < 8000ms | < 12000ms |
| POST reports/generate | < 10000ms | < 20000ms |
| POST internal/rollover | < 60000ms | < 90000ms |

### 1.3 Real-Time Performance

| Signal | Target |
|--------|--------|
| WebSocket message delivery (producer → consumer, same room) | < 500ms |
| Presence update propagation | < 2 seconds |
| Reconnection after disconnect | < 30 seconds (satisfies PRD NFR-8.2) |
| Cross-module trigger (shoot confirmed → dropper updated) | < 1 second |
| Grid update after bot mutation (via TanStack Query invalidation) | < 2 seconds |

> **Bot latency metric clarification (Gemini audit):** The portal uses **streaming** (`stream: true` in the Anthropic SDK). Users see the first token of a response within 2s — the perceived wait time. The full message body finishes generating within 8s for a 1024-token response at Sonnet throughput. Measuring total response time against a hard 4s threshold would be incorrect because it conflates TTFT with generation time. The frontend must use `stream: true` and render tokens incrementally — do not buffer the full response before displaying.

### 1.4 Frontend Rendering

| Measure | Target |
|---------|--------|
| Content Calendar scroll performance | 60fps while scrolling |
| Task grid re-render on status update | < 16ms (single frame) |
| CMD+K search input lag | < 16ms |
| Column highlight activation latency | < 80ms |
| Page route transition (Framer Motion) | 200ms |

---

## 2. SCALE REQUIREMENTS

### 2.1 Concurrent Usage (MVP Scale)

| Metric | Value | Notes |
|--------|-------|-------|
| Maximum concurrent portal users | 50 | Full Skaly Group team size |
| Maximum active WebSocket connections | 50 | All staff online simultaneously |
| Maximum bot sessions per minute | 30 | Rate-limited per user |
| Database connection pool | min: 2, max: 20 | Kysely pg pool |

### 2.2 Data Volume (After 12 Months at MVP Scale)

| Table | Estimated Rows at 12 Months |
|-------|---------------------------|
| attendance_logs | ~7,500 rows (10 staff × 25 days × 30 months) |
| tasks | ~3,000 rows (100 tasks/month × 30 months) |
| content_calendar | ~7,200 rows (20 clients × 31 days × 12 months) |
| content_pipelines | ~240 rows (20 clients × 12 months) |
| shoot_schedules | ~2,400 rows (20 clients × 10 slots × 12 months) |
| messages | ~15,000 rows (50 messages/day × 300 working days) |
| audit_log | ~50,000 rows (all writes from all modules) |
| notifications | ~10,000 rows |

No table will approach PostgreSQL performance limits at MVP scale. No partitioning is required for the 14-week MVP.

### 2.3 File Storage

| File Type | Expected Monthly Volume | 12-Month Total |
|-----------|------------------------|---------------|
| Task attachments | ~500MB | ~6GB |
| Staff CVs | ~50MB one-time | ~50MB |
| Generated PDF reports | ~100MB | ~1.2GB |
| Database backups | ~100MB/day | ~3GB (30 days retention) |

Cloudflare R2 pay-per-use pricing makes this negligible at this scale.

---

## 3. AVAILABILITY REQUIREMENTS

| Component | Uptime Target | Measurement Window |
|-----------|-------------|-------------------|
| Web app (portal.skaly.in) | 99.5% | Monthly |
| API server (api.skaly.in) | 99.5% | Monthly |
| Database (Railway PostgreSQL) | 99.9% | Monthly (Railway SLA) |
| Auth (Supabase) | 99.9% | Monthly (Supabase SLA) |
| File storage (Cloudflare R2) | 99.9% | Monthly (Cloudflare SLA) |

**99.5% monthly = maximum 3.6 hours of unplanned downtime per month.**

### 3.1 Planned Maintenance
- Database migration windows: Kysely migrations run with zero downtime (additive changes only in MVP)
- Breaking schema changes (if ever required post-MVP): maintenance window, communicated 48hr in advance
- Rollover execution: 00:01–00:05 IST daily (expected < 5 minutes, API fully operational during this window)

### 3.2 Recovery Objectives
| Scenario | RTO | RPO |
|----------|-----|-----|
| API server crash | < 5 minutes (Railway auto-restart) | 0 (DB is separate) |
| Database failure | < 2 hours | < 24 hours (daily backup) |
| R2 file loss | < 1 hour (versioning enabled) | < write time of last version |

---

## 4. SECURITY REQUIREMENTS

### 4.1 Authentication & Session Security
- All JWTs use RS256 algorithm (Supabase public key verification)
- Access tokens expire after 1 hour — no exceptions
- Refresh tokens expire after 7 days
- MFA (TOTP) mandatory for Admin and Manager roles before first portal access
- Maximum 3 failed TOTP attempts before 15-minute lockout
- Password minimum: 8 characters, 1 uppercase, 1 number
- Password reset invalidates all active sessions for that user

### 4.2 Data Security
- All data at rest: encrypted by Railway PostgreSQL (AES-256)
- All data in transit: TLS 1.2+ (Vercel + Railway enforce HTTPS)
- R2 files: stored with private access only — all access via time-limited presigned URLs
- Staff CVs: accessible to Admin, Manager, **and the staff member who uploaded their own CV** via presigned URLs (1-hour expiry). The API endpoint `GET /v1/staff/:id` returns `cvFileKey` for the user's own profile — this is intentional. Staff should be able to retrieve a document they submitted.
- Internal rejection notes: stored in DB but never transmitted to users in any API response
- Audit log: append-only enforced at database role level (`REVOKE UPDATE, DELETE ON audit_log`)

### 4.3 Input Validation
- All API inputs validated with Zod schemas (both frontend and backend use identical shared schemas)
- SQL injection: impossible via Kysely parameterised queries (no raw SQL with user input)
- XSS: DOMPurify applied to all chat message content rendered in browser
- File uploads: MIME type validation + file size limits at service layer (not just frontend)
- Rate limiting: prevents brute-force on login (10/15min), signup abuse (3/24hr), bot spam (30/min)

### 4.4 CORS Policy
- Strictly limited to: `https://portal.skaly.in` and `http://localhost:3000`
- No wildcard origins permitted

### 4.5 Secrets Management
- Zero secrets in source code or committed files
- All secrets in platform environment variables (Railway secrets vault, Vercel env vars)
- CRON_SECRET: minimum 32 character random string, rotated at least annually
- Anthropic API key: only in Railway env vars, never in frontend bundle or client code
- R2 keys: only in Railway env vars

---

## 5. COMPLIANCE REQUIREMENTS

### 5.1 Data Privacy
- Personal data collected (name, email, DOB, mobile, CV): minimum necessary for portal operation
- CV files: accessible to Admin, Manager, and the uploading staff member themselves. A staff member may download their own CV via their profile. They cannot view other staff members' CVs.
- Data is stored in Railway infrastructure (EU/US regions) — acceptable for Skaly Group operations
- Staff can request data export via Profile settings (manual process in MVP)
- Account deactivation: staff row soft-deleted (`deleted_at`); historical operational data retained

### 5.2 Data Retention
| Data Type | Retention Period | Action After |
|-----------|-----------------|-------------|
| Audit log records | 2 years | Archive to R2 cold storage |
| Bot messages (messages table) | 12 months | Auto-delete via scheduled job |
| Generated PDF reports (R2) | 30 days | R2 lifecycle rule auto-deletes |
| Database backups (R2) | 30 days | R2 lifecycle rule auto-deletes |
| Bot session history (Redis) | 12 hours | Redis TTL auto-expires |

### 5.3 Audit Requirements
- Every data write (INSERT, UPDATE, DELETE) is logged to `audit_log` within the same database transaction
- Audit log records include: who (staff_id or system actor), what (table + record + action), when (timestamp), old and new values (JSONB), and source IP
- Audit log is accessible to Admin via the portal UI with full filter + export capability
- The audit log cannot be modified or deleted by any application user or role

---

## 6. BROWSER & DEVICE REQUIREMENTS

### 6.1 Web App (Supported Browsers)

| Browser | Minimum Version | Level |
|---------|----------------|-------|
| Chrome | 120+ | ✅ Full support |
| Firefox | 121+ | ✅ Full support |
| Safari | 17+ | ✅ Full support |
| Edge (Chromium) | 120+ | ✅ Full support |

**Minimum screen width:** 1280px. Below 1280px, sidebar collapses to icon-only mode. Below 768px, the web app is not supported — use the mobile app (Phase 2).

### 6.2 Mobile App (Phase 2 Targets)

| Platform | Minimum OS | Notes |
|----------|-----------|-------|
| iOS | iOS 16+ | Covers ~95% of active iPhones |
| Android | Android 10+ (API 29) | Covers ~90% of active Android devices |

**Connection requirements:** Portal requires an active internet connection. Offline mode is limited to read-only display of last-cached data (Phase 2 enhancement).

---

## 7. ACCESSIBILITY REQUIREMENTS

All web app pages must meet **WCAG 2.1 Level AA** standards:

| Criterion | Requirement |
|-----------|-------------|
| Contrast ratio (text) | Minimum 4.5:1 for normal text, 3:1 for large text |
| Contrast ratio (UI components) | Minimum 3:1 for status chips, icons, borders |
| Keyboard navigation | All interactive elements reachable and operable via keyboard |
| Focus indicators | `outline: 2px solid #FDC257` on all focused elements |
| Screen reader support | Semantic HTML, ARIA roles/labels on all grid components |
| Status communication | Status is never conveyed by colour alone (always paired with text or icon) |
| Touch targets | Minimum 44×44px for all interactive elements |
| Error messages | Errors are associated with the input field via `aria-describedby` |

**Audit tool:** axe-core (via `@axe-core/playwright`) run as part of E2E test suite on every production deploy.
