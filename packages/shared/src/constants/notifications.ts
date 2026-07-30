/**
 * The notification type registry (ADR-020).
 *
 * ONE entry per value of the `notifications_type_check` CHECK constraint (migration
 * `021_notifications.ts`), which is the source of truth for the count — 18, not the
 * 14 the PRD and Impl-Plan carried. The discrepancy was explained rather than
 * arbitrary: the four system-generated types (`month_ready` + the three `rollover_*`)
 * were skipped by a count of user-facing events. 18 − 4 = 14.
 *
 * The registry MIRRORS the enum, in both directions, and a test asserts set equality
 * so the two cannot drift. Adding a type is therefore: a migration (the CHECK is a
 * constraint), an entry here, and nothing else — the bell renders from this table, so
 * there are no per-type conditionals in JSX to remember.
 *
 * Types whose producer lands in a later sprint are PRESENT here with a
 * `producer: Sprint N` note. The registry describes the enum, not what happens to be
 * wired today; a missing entry would make the drift guard fail for the wrong reason.
 */

/** Drives the bell row's tint. Not a colour — the UI maps these. */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface NotificationTypeSpec {
  /** Fallback title when a producer supplies none. Producers usually pass a specific one. */
  title: string;
  /** One-line description of when this fires — shown in docs and the admin settings UI. */
  template: string;
  /** Lucide icon name. */
  icon: string;
  severity: NotificationSeverity;
  /**
   * Deep link for the bell row, built from the notification's `payload`.
   *
   * Lives here so no component constructs a notification URL. Returns null when the
   * payload cannot address anything — the row then renders unlinked rather than
   * navigating somewhere wrong.
   */
  linkBuilder: (payload: Record<string, unknown>) => string | null;
  /**
   * The sprint that owns this type's producer. Present for every entry; the coverage
   * test uses it to split "must be exercised end-to-end" from "asserted as deferred".
   */
  producerSprint: number;
}

const str = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** `/tasks?period=YYYY-MM&highlight=id` — the Sprint 9 landing convention. */
const taskLink = (payload: Record<string, unknown>): string | null => {
  const id = str(payload, 'taskId');
  if (!id) return null;
  const period = str(payload, 'period');
  return period ? `/tasks?period=${period}&highlight=${id}` : `/tasks?highlight=${id}`;
};

export const NOTIFICATION_REGISTRY = {
  // ── Tasks (Sprint 4) ──────────────────────────────────────────────────────
  task_assigned: {
    title: 'You were assigned a task',
    template: 'Someone assigns you a task. Never fires for your own assignment (ADR-006).',
    icon: 'ClipboardList',
    severity: 'info',
    linkBuilder: taskLink,
    producerSprint: 4,
  },
  task_overdue: {
    title: 'A task is overdue',
    template: 'The overdue sweep finds an incomplete task past its date. Deduped to once per 24h.',
    icon: 'AlarmClock',
    severity: 'warning',
    linkBuilder: taskLink,
    producerSprint: 4,
  },
  dependency_resolved: {
    title: 'A blocker cleared',
    template: 'A task you depend on reached Done, so yours can start.',
    icon: 'GitBranch',
    severity: 'success',
    linkBuilder: taskLink,
    producerSprint: 4,
  },

  // ── Shoot planner (Sprint 5) ──────────────────────────────────────────────
  shoot_confirmed: {
    title: 'A shoot was confirmed',
    template: 'A shoot slot moved to Confirmed. Goes to the assigned freelancer.',
    icon: 'Camera',
    severity: 'success',
    linkBuilder: (p) => {
      const period = str(p, 'period');
      return period ? `/shoot-planner?period=${period}` : '/shoot-planner';
    },
    producerSprint: 5,
  },

  // ── Attendance / holidays (Sprint 3) ──────────────────────────────────────
  holiday_added: {
    title: 'A holiday was added',
    template: 'An admin or manager adds a holiday. Everyone but the actor is notified.',
    icon: 'CalendarPlus',
    severity: 'info',
    linkBuilder: (p) => {
      const period = str(p, 'period');
      return period ? `/attendance?period=${period}` : '/attendance';
    },
    producerSprint: 3,
  },
  holiday_removed: {
    title: 'A holiday was removed',
    template: 'An admin or manager removes a holiday; that date reverts to working (H-01).',
    icon: 'CalendarMinus',
    severity: 'warning',
    linkBuilder: (p) => {
      const period = str(p, 'period');
      return period ? `/attendance?period=${period}` : '/attendance';
    },
    producerSprint: 3,
  },

  // ── Signup + account lifecycle (Sprints 1–2) ──────────────────────────────
  signup_request: {
    title: 'New signup request',
    template: 'Someone requests access. Delivered to the admin room.',
    icon: 'UserPlus',
    severity: 'info',
    linkBuilder: (_payload: Record<string, unknown>) => '/settings/signup-requests',
    producerSprint: 2,
  },
  signup_approved: {
    title: 'Your access was approved',
    template: 'An admin approves a signup request; the applicant is notified.',
    icon: 'UserCheck',
    severity: 'success',
    linkBuilder: (_payload: Record<string, unknown>) => '/dashboard',
    producerSprint: 2,
  },
  signup_rejected: {
    title: 'A signup request was declined',
    template:
      'An admin rejects a signup request. Goes to the OTHER admins — the applicant has no staff row and is unreachable in-app (ADR-020). Carries the PUBLIC message only, never rejection_note.',
    icon: 'UserX',
    severity: 'warning',
    // The queue defaults to PENDING, and the thing being linked to is by definition no
    // longer pending — so the filter is part of the address, not a nicety. Without it
    // the notification drops the admin on an empty list.
    linkBuilder: (p) => {
      const id = str(p, 'requestId');
      return id
        ? `/settings/signup-requests?status=rejected&highlight=${id}`
        : '/settings/signup-requests?status=rejected';
    },
    producerSprint: 2,
  },
  account_reactivated: {
    title: 'Your account was reactivated',
    template: 'An admin reactivates a deactivated staff account.',
    icon: 'UserCog',
    severity: 'success',
    linkBuilder: (_payload: Record<string, unknown>) => '/dashboard',
    // Sprint 11, NOT Sprint 2. Sprint 10's census assumed this was a shipped-sprint
    // gap like the other five, but there is no staff reactivate path to hook into —
    // StaffService is read-only, and there is no deactivate either. The producer
    // arrives with Settings → Staff, so this is a genuine deferral, not a gap.
    producerSprint: 11,
  },

  // ── Clients (Sprint 6) ────────────────────────────────────────────────────
  client_updated: {
    title: 'A client was updated',
    template: "A client's name changed, so every grid showing it is stale.",
    icon: 'Building2',
    severity: 'info',
    linkBuilder: (_payload: Record<string, unknown>) => '/settings/clients',
    producerSprint: 6,
  },

  // ── Chat (Sprint 10 — this sprint) ────────────────────────────────────────
  mention: {
    title: 'You were mentioned',
    template:
      '@mentioned in chat. The ONLY notification chat produces — ordinary messages deliver over the socket, never as a row (ADR-020).',
    icon: 'AtSign',
    severity: 'info',
    linkBuilder: (p) => {
      const id = str(p, 'messageId');
      return id ? `/chat?highlight=${id}` : '/chat';
    },
    producerSprint: 10,
  },

  // ── Deferred: producers land in Sprints 11–13 ─────────────────────────────
  report_ready: {
    title: 'Your report is ready',
    template: 'An async report finished; the link expires after 24h.',
    icon: 'FileText',
    severity: 'success',
    // Audit M-08: a PORTAL route, never the presigned R2 URL. The presigned link
    // lives 24h (REPORT_EXPIRY_SECONDS) and the notification row lives forever, so
    // a link baked into the payload is a bell that stops working overnight while
    // still looking clickable. /settings/reports fetches a fresh URL on open.
    //
    // This entry returned `payload.downloadUrl` from Sprint 10 until Sprint 11.
    // Nothing caught it because the type had no producer to exercise it — the
    // deferred-list census proves an emitter is absent, not that the registry
    // entry beside it is right.
    linkBuilder: (p) => {
      const id = str(p, 'reportId');
      return id ? `/settings/reports?reportId=${id}` : '/settings/reports';
    },
    producerSprint: 11,
  },
  new_comment: {
    title: 'New comment',
    template: 'Someone comments on a record you follow.',
    icon: 'MessageSquare',
    severity: 'info',
    // The ONLY builder that takes its address from the payload, so it is the only
    // one that can be handed an absolute URL. It must not be: the row lives
    // forever and a signed link does not (audit M-08, the report_ready defect
    // generalised). A non-portal value yields null — an unlinked row — rather
    // than a bell that navigates off the portal or expires overnight.
    linkBuilder: (p) => {
      const url = str(p, 'url');
      return url?.startsWith('/') && !url.startsWith('//') ? url : null;
    },
    producerSprint: 12,
  },
  month_ready: {
    title: 'A new month is ready',
    template: 'Rollover finished provisioning the next period.',
    icon: 'CalendarCheck',
    severity: 'success',
    linkBuilder: (p) => {
      const period = str(p, 'period');
      return period ? `/dashboard?period=${period}` : '/dashboard';
    },
    producerSprint: 12,
  },
  rollover_success: {
    title: 'Rollover completed',
    template: 'The monthly rollover job succeeded.',
    icon: 'CheckCircle2',
    severity: 'success',
    linkBuilder: (_payload: Record<string, unknown>) => '/settings/months',
    producerSprint: 12,
  },
  rollover_failed: {
    title: 'Rollover failed',
    template:
      'The monthly rollover job failed. Rendered in full with an inline action, never truncated (FR-NOTIF-04).',
    icon: 'XCircle',
    severity: 'critical',
    linkBuilder: (_payload: Record<string, unknown>) => '/settings/months',
    producerSprint: 12,
  },
  rollover_view_refresh_failed: {
    title: 'Rollover view refresh failed',
    template: 'Rollover succeeded but a materialised view refresh did not.',
    icon: 'AlertTriangle',
    severity: 'critical',
    linkBuilder: (_payload: Record<string, unknown>) => '/settings/months',
    producerSprint: 12,
  },
  // `satisfies` WITHOUT `as const`: the keys stay literal (so NotificationType is the
  // union and NOTIFICATION_REGISTRY.mention is typed), while each linkBuilder widens
  // to the interface's (payload) => string | null. With `as const`, the entries that
  // ignore their payload would be narrowed to zero-argument functions and calling
  // them with one would not compile.
} satisfies Record<string, NotificationTypeSpec>;

export type NotificationType = keyof typeof NOTIFICATION_REGISTRY;

/** Every type, for iteration and the enum drift guard. */
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_REGISTRY) as NotificationType[];

/**
 * The last sprint whose producers are built. Bump it when a sprint ships its
 * notification producers, and the census test tells you which ones you still owe.
 */
export const SHIPPED_THROUGH_SPRINT = 11;

/**
 * Types with no producer yet, with the sprint that owns each.
 *
 * Derived, not hand-maintained — a new entry with a future `producerSprint` joins this
 * list automatically, and an entry whose sprint has shipped leaves it. The coverage test
 * asserts its length, so bumping SHIPPED_THROUGH_SPRINT above fails until every producer
 * that sprint owes actually exists in src. That failure is the intended workflow, not a
 * regression.
 *
 * Was `SPRINT_10_DEFERRED_TYPES`, a name that had to be edited every sprint. Sprint 11
 * lands two of them: `account_reactivated` (ADR-026 staff reinstate) and `report_ready`
 * (ADR-027), taking the list 7 → 5.
 */
export const DEFERRED_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(
  (t) => NOTIFICATION_REGISTRY[t].producerSprint > SHIPPED_THROUGH_SPRINT,
).sort();

export const isNotificationType = (value: string): value is NotificationType =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_REGISTRY, value);
