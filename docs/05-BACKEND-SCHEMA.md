# 05 — BACKEND SCHEMA
## Scaly Business Portal
**Version:** 2.1 | **Date:** June 2026 | **Status:** Final — Locked
**Cross-refs:** TRD §6, API-CONTRACT §2, AUTH-MATRIX §2, IMPLEMENTATION-PLAN §3

---

## 1. EXTENSIONS

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
```

---

## 2. MIGRATION ORDER

Run migrations in this sequence. Each file is a Kysely migration in `database/migrations/`.

```
001_extensions.ts
002_months.ts
003_staff.ts
004_user_permissions.ts
005_clients.ts
006_invite_links.ts
007_signup_requests.ts
008_holidays.ts
009_attendance_logs.ts
010_tasks.ts
011_task_assignees.ts
012_task_attachments.ts
013_task_time_logs.ts
014_shoot_schedules.ts
015_content_pipelines.ts
016_content_calendar.ts
017_reports.ts
018_messages.ts
019_message_mentions.ts
020_bot_sessions.ts
021_notifications.ts
022_comments.ts
023_audit_log.ts
024_materialised_views.ts
025_search_indexes.ts
seeds/001_system_actor.ts
```

---

## 3. FOUNDATION TABLES

```sql
-- ─── 002: MONTHS ──────────────────────────────────────────────────────────────
CREATE TABLE months (
  period        CHAR(7)      NOT NULL,             -- 'YYYY-MM', e.g. '2025-06'
  label         VARCHAR(20)  NOT NULL,             -- 'June 2025'
  locked        BOOLEAN      NOT NULL DEFAULT FALSE,
  locked_at     TIMESTAMPTZ,
  locked_by     UUID         REFERENCES staff(id), -- System Actor UUID when locked by rollover (NOT NULL)
  unlocked_at   TIMESTAMPTZ,
  unlocked_by   UUID         REFERENCES staff(id),
  unlock_reason TEXT,                              -- required when admin unlocks
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT months_pkey PRIMARY KEY (period),
  CONSTRAINT months_period_format CHECK (period ~ '^\d{4}-\d{2}$')
);

-- ─── 003: STAFF ───────────────────────────────────────────────────────────────
CREATE TABLE staff (
  id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  supabase_uid    UUID          UNIQUE,             -- links to Supabase auth.users
  name            VARCHAR(255)  NOT NULL,
  email           VARCHAR(255)  NOT NULL,
  role            VARCHAR(30)   NOT NULL,
  date_of_birth   DATE          NULL,               -- collected at signup
  mobile_number   VARCHAR(20)   NULL,               -- format: +91-9876543210
  cv_file_key     TEXT          NULL,               -- R2: cvs/{staffId}/cv.pdf
  avatar_url      TEXT,
  active          BOOLEAN       NOT NULL DEFAULT TRUE,
  mfa_enrolled    BOOLEAN       NOT NULL DEFAULT FALSE,
  push_token      TEXT          NULL,               -- Phase 2: FCM/APNs token
  push_platform   VARCHAR(10)   NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT staff_pkey           PRIMARY KEY (id),
  CONSTRAINT staff_email_unique   UNIQUE (email),
  CONSTRAINT staff_role_check     CHECK (role IN ('admin','manager','team_member','freelancer')),
  CONSTRAINT staff_push_platform  CHECK (push_platform IN ('ios','android') OR push_platform IS NULL)
);
CREATE INDEX idx_staff_role_active ON staff(role) WHERE active = TRUE AND deleted_at IS NULL;
CREATE INDEX idx_staff_email       ON staff(email);
CREATE INDEX idx_staff_supabase    ON staff(supabase_uid) WHERE supabase_uid IS NOT NULL;

-- ─── 004: USER_PERMISSIONS ────────────────────────────────────────────────────
CREATE TABLE user_permissions (
  id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  staff_id        UUID          NOT NULL REFERENCES staff(id),
  permission_key  VARCHAR(100)  NOT NULL,
  value           BOOLEAN       NOT NULL,
  set_by          UUID          REFERENCES staff(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT user_permissions_pkey   PRIMARY KEY (id),
  CONSTRAINT user_permissions_unique UNIQUE (staff_id, permission_key)
);

-- ─── 005: CLIENTS ─────────────────────────────────────────────────────────────
CREATE TABLE clients (
  id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  name                  VARCHAR(255)  NOT NULL,
  is_internal           BOOLEAN       NOT NULL DEFAULT FALSE,
  active                BOOLEAN       NOT NULL DEFAULT TRUE,
  shoot_slots_per_month INTEGER       NOT NULL,  -- NO DEFAULT — must be explicit at creation
  pieces_per_visit      INTEGER       NOT NULL DEFAULT 1,
  whatsapp_number       VARCHAR(20),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT clients_pkey             PRIMARY KEY (id),
  CONSTRAINT clients_slots_positive   CHECK (shoot_slots_per_month > 0),
  CONSTRAINT clients_pieces_positive  CHECK (pieces_per_visit > 0)
);

-- ─── 006: INVITE_LINKS ────────────────────────────────────────────────────────
CREATE TABLE invite_links (
  id           UUID          NOT NULL DEFAULT gen_random_uuid(),
  token        TEXT          NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  email        VARCHAR(255)  NULL,                  -- if generated for specific email
  role         VARCHAR(30)   NOT NULL,
  created_by   UUID          NOT NULL REFERENCES staff(id),
  expires_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  used_at      TIMESTAMPTZ,
  used_by      UUID          REFERENCES staff(id),
  CONSTRAINT invite_links_pkey         PRIMARY KEY (id),
  CONSTRAINT invite_links_token_unique UNIQUE (token),
  CONSTRAINT invite_links_role_check   CHECK (role IN ('admin','manager','team_member','freelancer'))
);

-- ─── 007: SIGNUP_REQUESTS ─────────────────────────────────────────────────────
-- PRD Amendment 1: all self-signup requests flow through this table
CREATE TABLE signup_requests (
  id                       UUID          NOT NULL DEFAULT gen_random_uuid(),
  name                     VARCHAR(255)  NOT NULL,
  email                    VARCHAR(255)  NOT NULL,
  date_of_birth            DATE          NOT NULL,
  mobile_number            VARCHAR(20)   NOT NULL,
  role_requested           VARCHAR(30)   NOT NULL,  -- user's declared role
  cv_file_key              TEXT          NULL,        -- R2: cvs/requests/{requestId}/cv.pdf
  message                  TEXT          NULL,        -- optional message to admin
  google_uid               TEXT          NULL,        -- if signed up via Google OAuth
  status                   VARCHAR(20)   NOT NULL DEFAULT 'pending',
  role_assigned            VARCHAR(30)   NULL,        -- set by admin at approval
  rejection_note           TEXT          NULL,        -- INTERNAL ONLY — never transmitted to user
  public_rejection_message VARCHAR(300)  NULL,        -- shown to user if rejected
  reviewed_at              TIMESTAMPTZ,
  reviewed_by              UUID          REFERENCES staff(id),
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT signup_requests_pkey           PRIMARY KEY (id),
  CONSTRAINT signup_requests_role_check     CHECK (role_requested IN ('manager','team_member','freelancer')),
  CONSTRAINT signup_requests_status_check   CHECK (status IN ('pending','approved','rejected'))
);
CREATE INDEX idx_signup_requests_status ON signup_requests(status, created_at DESC);
-- Prevents duplicate pending signup submissions for the same email address.
-- Allows multiple historical rejected/approved rows for the same email (e.g. one
-- person reapplies after rejection) — only one pending row at a time.
CREATE UNIQUE INDEX idx_signup_requests_email_pending
  ON signup_requests(email)
  WHERE status = 'pending';
-- Service-layer check (in SignupService.createRequest before INSERT):
-- 1. SELECT 1 FROM staff WHERE email = $1 — reject if already in staff table
--    (active OR soft-deleted). Returning ALREADY_PROCESSED error code.
-- 2. The partial unique index above blocks duplicate pending rows.
```

---

## 4. OPERATIONAL MODULE TABLES

```sql
-- ─── 008: HOLIDAYS ────────────────────────────────────────────────────────────
CREATE TABLE holidays (
  id         UUID          NOT NULL DEFAULT gen_random_uuid(),
  period     CHAR(7)       NOT NULL REFERENCES months(period),
  date       DATE          NOT NULL,
  name       VARCHAR(100)  NOT NULL,
  active     BOOLEAN       NOT NULL DEFAULT TRUE,
  added_by   UUID          NOT NULL REFERENCES staff(id),
  removed_by UUID          REFERENCES staff(id),
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT holidays_pkey        PRIMARY KEY (id),
  CONSTRAINT holidays_date_unique UNIQUE (period, date)
);

-- ─── 009: ATTENDANCE_LOGS ─────────────────────────────────────────────────────
CREATE TABLE attendance_logs (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  period      CHAR(7)     NOT NULL REFERENCES months(period),
  staff_id    UUID        NOT NULL REFERENCES staff(id),
  date        DATE        NOT NULL,
  day_type    VARCHAR(10) NOT NULL DEFAULT 'working',
  present     BOOLEAN     NOT NULL DEFAULT FALSE,
  work_log    TEXT,                                 -- max 2000 chars enforced in service layer
  updated_at  TIMESTAMPTZ,
  updated_by  UUID        REFERENCES staff(id),
  version     INTEGER     NOT NULL DEFAULT 1,       -- optimistic locking — REQUIRED on every PATCH /v1/attendance/:id
  CONSTRAINT attendance_pkey      PRIMARY KEY (id),
  CONSTRAINT attendance_unique    UNIQUE (period, staff_id, date),
  CONSTRAINT attendance_day_type  CHECK (day_type IN ('working','sunday','holiday'))
);
CREATE INDEX idx_att_period_date  ON attendance_logs(period, date);
CREATE INDEX idx_att_period_staff ON attendance_logs(period, staff_id);

-- ─── 010: TASKS ───────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  period          CHAR(7)     NOT NULL REFERENCES months(period),
  date            DATE        NOT NULL,
  client_id       UUID        REFERENCES clients(id),
  description     TEXT        NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'To Do',
  priority        VARCHAR(10) NULL,
  dependency_id   UUID        REFERENCES tasks(id),
  remark          TEXT,
  deadline        DATE,
  result          TEXT,
  created_by      UUID        NOT NULL REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT tasks_pkey            PRIMARY KEY (id),
  CONSTRAINT tasks_status_check    CHECK (status IN ('To Do','In Progress','Blocked','Done','Cancelled')),
  CONSTRAINT tasks_priority_check  CHECK (priority IN ('Low','Medium','High','Urgent') OR priority IS NULL),
  CONSTRAINT tasks_no_self_dep     CHECK (dependency_id IS DISTINCT FROM id)
);
-- Full-text search column (GENERATED ALWAYS — auto-maintained)
ALTER TABLE tasks ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('english', description || ' ' || COALESCE(result, '') || ' ' || COALESCE(remark, ''))
  ) STORED;
CREATE INDEX idx_tasks_period_date   ON tasks(period, date)   WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_period_status ON tasks(period, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_search        ON tasks USING GIN(search_vector);

CREATE TABLE task_assignees (
  task_id     UUID NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
  staff_id    UUID NOT NULL REFERENCES staff(id),
  assigned_by UUID REFERENCES staff(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_assignees_pkey PRIMARY KEY (task_id, staff_id)
);

CREATE TABLE task_attachments (
  id           UUID          NOT NULL DEFAULT gen_random_uuid(),
  task_id      UUID          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name    VARCHAR(255)  NOT NULL,
  file_key     TEXT          NOT NULL,              -- R2 object key
  file_size    BIGINT        NOT NULL,
  mime_type    VARCHAR(100),
  uploaded_by  UUID          NOT NULL REFERENCES staff(id),
  uploaded_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT task_attachments_pkey PRIMARY KEY (id)
);

-- Schema ready; UI deferred to post-MVP
CREATE TABLE task_time_logs (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  task_id     UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  staff_id    UUID        NOT NULL REFERENCES staff(id),
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  manual_mins INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_time_logs_pkey PRIMARY KEY (id)
);

-- ─── 014: SHOOT_SCHEDULES ─────────────────────────────────────────────────────
-- week_number deliberately omitted — computed from slot_date at render time
-- via date-fns getISOWeek(). Flat slot_index only.
CREATE TABLE shoot_schedules (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  period          CHAR(7)     NOT NULL REFERENCES months(period),
  client_id       UUID        NOT NULL REFERENCES clients(id),
  slot_index      SMALLINT    NOT NULL,              -- 1 through shoot_slots_per_month
  slot_status     VARCHAR(15) NOT NULL DEFAULT 'Unset',
  slot_date       DATE,
  pieces_expected INTEGER     NOT NULL DEFAULT 1,
  freelancer_id   UUID        NULL REFERENCES staff(id),  -- assigned freelancer
  updated_by      UUID        REFERENCES staff(id),
  updated_at      TIMESTAMPTZ,
  CONSTRAINT shoot_schedules_pkey     PRIMARY KEY (id),
  CONSTRAINT shoot_schedules_unique   UNIQUE (period, client_id, slot_index),
  CONSTRAINT shoot_schedules_slot_idx CHECK (slot_index >= 1),
  CONSTRAINT shoot_schedules_status   CHECK (slot_status IN ('Unset','Scheduled','Confirmed','Completed'))
);
CREATE INDEX idx_shoots_period_client ON shoot_schedules(period, client_id);
CREATE INDEX idx_shoots_freelancer    ON shoot_schedules(freelancer_id) WHERE freelancer_id IS NOT NULL;

-- ─── 015: CONTENT_PIPELINES ───────────────────────────────────────────────────
-- pipeline_status field deliberately omitted.
-- Status is DERIVED at query time:
--   CASE WHEN posted_at IS NOT NULL       THEN 'Posted'
--        WHEN finals_ready_at IS NOT NULL THEN 'Finals Ready'
--        WHEN raw_received_at IS NOT NULL THEN 'Raw Received'
--        WHEN coming_shoot_date IS NOT NULL THEN 'Shoot Scheduled'
--        ELSE 'Not Started' END
CREATE TABLE content_pipelines (
  id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  period                CHAR(7)       NOT NULL REFERENCES months(period),
  client_id             UUID          NOT NULL REFERENCES clients(id),
  visit_type            VARCHAR(50),
  last_shoot_date       DATE,
  raw_received_at       TIMESTAMPTZ,
  finals_ready_at       TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  coming_shoot_date     DATE,
  coming_shoot_source   VARCHAR(10),                 -- 'trigger' | 'manual'
  updated_by            UUID          REFERENCES staff(id),
  version               INTEGER       NOT NULL DEFAULT 1,
  CONSTRAINT content_pipelines_pkey           PRIMARY KEY (id),
  CONSTRAINT content_pipelines_unique         UNIQUE (period, client_id),
  CONSTRAINT content_pipelines_shoot_source   CHECK (coming_shoot_source IN ('trigger','manual') OR coming_shoot_source IS NULL)
);

-- ─── 016: CONTENT_CALENDAR ────────────────────────────────────────────────────
-- 6-status vocabulary — confirmed from Skaly's actual workflow
CREATE TABLE content_calendar (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  period      CHAR(7)     NOT NULL REFERENCES months(period),
  client_id   UUID        NOT NULL REFERENCES clients(id),
  date        DATE        NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'No Activity',
  note        TEXT,
  source      VARCHAR(20) NULL,                      -- 'manual' | 'pipeline_trigger'
  updated_by  UUID        REFERENCES staff(id),
  updated_at  TIMESTAMPTZ,
  version     INTEGER     NOT NULL DEFAULT 1,
  CONSTRAINT content_calendar_pkey     PRIMARY KEY (id),
  CONSTRAINT content_calendar_unique   UNIQUE (period, client_id, date),
  CONSTRAINT content_calendar_status   CHECK (status IN
    ('No Activity','Under Progress','Ready','Posted','Pending','Rescheduled')),
  CONSTRAINT content_calendar_source   CHECK (source IN ('manual','pipeline_trigger') OR source IS NULL)
);
CREATE INDEX idx_calendar_period_date   ON content_calendar(period, date);
CREATE INDEX idx_calendar_period_client ON content_calendar(period, client_id);

-- ─── 017: REPORTS ─────────────────────────────────────────────────────────────
CREATE TABLE reports (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  period        CHAR(7)     NOT NULL REFERENCES months(period),
  type          VARCHAR(30) NOT NULL,
  client_id     UUID        REFERENCES clients(id),   -- NULL for org-wide reports
  file_key      TEXT        NOT NULL,                  -- R2 object key
  generated_by  UUID        NOT NULL REFERENCES staff(id),
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reports_pkey        PRIMARY KEY (id),
  CONSTRAINT reports_type_check  CHECK (type IN ('client_monthly','org_monthly'))
);
CREATE INDEX idx_reports_period ON reports(period, generated_at DESC);
```

---

## 5. COMMUNICATION TABLES

```sql
-- ─── 018: MESSAGES ────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  channel       VARCHAR(10) NOT NULL,
  sender_id     UUID        REFERENCES staff(id),       -- NULL for bot assistant messages
  sender_type   VARCHAR(10) NOT NULL DEFAULT 'user',
  content       TEXT        NOT NULL,
  content_type  VARCHAR(15) NOT NULL DEFAULT 'text',
  parent_id     UUID        REFERENCES messages(id),    -- thread reply
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at     TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT messages_pkey           PRIMARY KEY (id),
  CONSTRAINT messages_channel_check  CHECK (channel IN ('common','bot')),
  CONSTRAINT messages_type_check     CHECK (sender_type IN ('user','bot','system')),
  CONSTRAINT messages_content_check  CHECK (content_type IN ('text','tool_result','system'))
);
ALTER TABLE messages ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_messages_channel   ON messages(channel, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_parent    ON messages(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_messages_search    ON messages USING GIN(search_vector);

CREATE TABLE message_mentions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  staff_id   UUID NOT NULL REFERENCES staff(id),
  CONSTRAINT message_mentions_pkey PRIMARY KEY (message_id, staff_id)
);

-- ─── 020: BOT_SESSIONS ────────────────────────────────────────────────────────
CREATE TABLE bot_sessions (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  staff_id         UUID        NOT NULL REFERENCES staff(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_sessions_pkey PRIMARY KEY (id)
);

-- ─── 021: NOTIFICATIONS ───────────────────────────────────────────────────────
CREATE TABLE notifications (
  id          UUID          NOT NULL DEFAULT gen_random_uuid(),
  staff_id    UUID          NOT NULL REFERENCES staff(id),
  type        VARCHAR(40)   NOT NULL,
  title       VARCHAR(150)  NOT NULL,
  message     VARCHAR(500),
  payload     JSONB         NOT NULL DEFAULT '{}',
  is_read     BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_pkey       PRIMARY KEY (id),
  CONSTRAINT notifications_type_check CHECK (type IN (
    'month_ready','task_assigned','task_overdue','dependency_resolved',
    'shoot_confirmed','holiday_added','holiday_removed',
    'rollover_failed','rollover_success','rollover_view_refresh_failed',
    'new_comment','mention',
    'signup_request','signup_approved','signup_rejected',
    'client_updated','report_ready',
    'account_reactivated'  -- audit M-01: notify staff when re-onboarded
  ))
);
CREATE INDEX idx_notif_staff_unread ON notifications(staff_id, is_read, created_at DESC);

-- ─── 022: COMMENTS ────────────────────────────────────────────────────────────
-- Only in: shoot_planner, content_dropper, content_calendar
CREATE TABLE comments (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  module           VARCHAR(25) NOT NULL,
  record_id        UUID        NOT NULL,
  period           CHAR(7)     NOT NULL REFERENCES months(period),
  staff_id         UUID        NOT NULL REFERENCES staff(id),
  content          TEXT        NOT NULL,
  record_context   TEXT        NOT NULL,  -- "Naaz Furniture / Shoot Planner" — always populated at write time
  acknowledged_by  UUID        REFERENCES staff(id),
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comments_pkey          PRIMARY KEY (id),
  CONSTRAINT comments_module_check  CHECK (module IN ('shoot_planner','content_dropper','content_calendar'))
);
CREATE INDEX idx_comments_record ON comments(module, record_id, period);
```

---

## 6. AUDIT LOG

```sql
-- ─── 023: AUDIT_LOG ───────────────────────────────────────────────────────────
-- APPEND-ONLY. Never UPDATE or DELETE rows from this table.
-- staff_id is ALWAYS populated:
--   · For user actions: the authenticated staff member's UUID
--   · For automated system actions: the System Actor UUID '00000000-0000-0000-0000-000000000000'
--   · For bot actions: the staff member on whose behalf the bot acted (NOT the system actor)
-- This eliminates ambiguity: every audit row has a non-NULL staff_id.
-- The changed_by_source enum ('user' | 'system' | 'bot') distinguishes the action source.
CREATE TABLE audit_log (
  id                 UUID        NOT NULL DEFAULT gen_random_uuid(),
  staff_id           UUID        NOT NULL REFERENCES staff(id),  -- system events use System Actor UUID
  changed_by_source  VARCHAR(10) NOT NULL DEFAULT 'user',
  table_name         VARCHAR(50) NOT NULL,
  record_id          UUID,
  action             VARCHAR(15) NOT NULL,
  old_value          JSONB,
  new_value          JSONB,
  ip_address         INET,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_log_pkey        PRIMARY KEY (id),
  CONSTRAINT audit_log_source_check CHECK (changed_by_source IN ('user','system','bot')),
  CONSTRAINT audit_log_action_check CHECK (action IN ('INSERT','UPDATE','DELETE','LOCK','UNLOCK','DEACTIVATE'))
);
CREATE INDEX idx_audit_staff_time ON audit_log(staff_id, created_at DESC);
CREATE INDEX idx_audit_table      ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_time       ON audit_log(created_at DESC);
-- API role must have REVOKE UPDATE, DELETE ON audit_log
```

---

## 7. MATERIALISED VIEWS

```sql
-- ─── 024: MATERIALISED VIEWS ──────────────────────────────────────────────────
CREATE MATERIALIZED VIEW dashboard_org_stats AS
SELECT
  period,
  ROUND(
    100.0 * SUM(CASE WHEN present THEN 1 ELSE 0 END) /
    NULLIF(COUNT(*) FILTER (WHERE day_type = 'working'), 0),
    1
  ) AS attendance_pct,
  COUNT(DISTINCT staff_id) AS active_staff_count
FROM attendance_logs
GROUP BY period;
CREATE UNIQUE INDEX ON dashboard_org_stats(period);

CREATE MATERIALIZED VIEW dashboard_staff_task_stats AS
SELECT
  t.period,
  ta.staff_id,
  COUNT(*)                                                     AS total_assigned,
  COUNT(*) FILTER (WHERE t.status = 'Done')                   AS tasks_done,
  COUNT(*) FILTER (WHERE t.status NOT IN ('Done','Cancelled')) AS tasks_pending,
  COUNT(*) FILTER (WHERE t.deadline < CURRENT_DATE
    AND t.status NOT IN ('Done','Cancelled'))                  AS tasks_overdue
FROM tasks t
JOIN task_assignees ta ON ta.task_id = t.id
WHERE t.deleted_at IS NULL
GROUP BY t.period, ta.staff_id;
CREATE UNIQUE INDEX ON dashboard_staff_task_stats(period, staff_id);

-- Refresh after rollover and on significant data changes:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_org_stats;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_staff_task_stats;
-- NOTE: CONCURRENTLY requires the unique index to exist. Must be OUTSIDE transaction.

-- CRITICAL: Initial population at migration time (NON-CONCURRENTLY).
-- CONCURRENTLY is not allowed on an empty materialised view. Without this
-- initial refresh, the first dashboard query after migration returns null data
-- because the view has been created but never populated.
REFRESH MATERIALIZED VIEW dashboard_org_stats;
REFRESH MATERIALIZED VIEW dashboard_staff_task_stats;
```

---

## 8. SEARCH INDEXES

```sql
-- ─── 025: SEARCH INDEXES ──────────────────────────────────────────────────────
-- Trigram indexes for fuzzy search (client name, staff name)
CREATE INDEX idx_clients_name_trgm ON clients USING GIN(name gin_trgm_ops);
CREATE INDEX idx_staff_name_trgm   ON staff   USING GIN(name gin_trgm_ops);

-- Full-text GIN indexes (defined inline on tasks and messages via GENERATED columns above)
-- Additional full-text on comments
ALTER TABLE comments ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_comments_search ON comments USING GIN(search_vector);
```

---

## 9. SEEDS

```sql
-- ─── seeds/001_system_actor.ts ────────────────────────────────────────────────
-- Must run before any rollover or automated audit log entries
-- UUID is fixed and referenced in application code as SYSTEM_ACTOR_ID constant
INSERT INTO staff (id, name, email, role, active, mfa_enrolled)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'System',
  'system@skaly.in',
  'admin',
  TRUE,
  TRUE
) ON CONFLICT (id) DO NOTHING;
```

---

## 10. REDIS KEY PATTERNS

```
bot:session:{staffId}         Serialised conversation array (50 turns), TTL: 12hr
                              Type: string (JSON array)

perms:{staffId}               Serialised permission override array, TTL: 5min
                              Type: string (JSON array)
                              Invalidated immediately on admin permission change

staff_lookup:{supabaseUid}    Staff row JSON (id, role, active, mfaEnrolled), TTL: 5min
                              Type: string (JSON object)

presence:{staffId}            Value: "1", TTL: 60s
                              Refreshed every 30s by client heartbeat
                              Key existence = staff is online

rate_limit:{endpoint}:{ip}    Upstash rate limit sliding window
                              Managed by @fastify/rate-limit + Upstash adapter
```

---

## 11. DATABASE ROLE PERMISSIONS

```sql
-- Application role: skaly_app
-- Principle of least privilege

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO skaly_app;
GRANT DELETE ON tasks, task_assignees, task_attachments TO skaly_app;
-- task_time_logs: SELECT and INSERT only (no endpoint or UI for DELETE in MVP — time tracking is post-MVP)
GRANT SELECT, INSERT ON task_time_logs TO skaly_app;
GRANT DELETE ON shoot_schedules, content_pipelines, content_calendar TO skaly_app;
GRANT DELETE ON messages, message_mentions, comments, notifications TO skaly_app;
GRANT DELETE ON invite_links, bot_sessions TO skaly_app;

-- audit_log: insert only — never update or delete
-- Enforced at DB level: no application role can circumvent this
REVOKE UPDATE, DELETE ON audit_log FROM skaly_app;

-- months.locked: managed only through explicit lock/unlock endpoints
-- No direct UPDATE permission needed beyond the service method
```
