/**
 * ActivityFeedService — GET /v1/activity-feed, the home page's humanised event feed
 * (PRD FR-SET-07, APPFLOW §3).
 *
 * SOURCED FROM `audit_log`, ON ITS OWN READ PATH. FR-SET-07 forbids reusing the
 * admin-only `/v1/audit-log` ENDPOINT; it does not forbid the table, and a second
 * event table would be dual-write drift — two places to remember, one of which
 * eventually gets forgotten.
 *
 * THE TEMPLATE TABLE IS A WHITELIST, AND THAT IS ALSO WHY IT IS SAFE.
 *
 * Rendering needs a couple of named fields out of `audit_log.new_value`, which is
 * raw JSONB and carries DOB, mobile numbers, CV keys and signup rejection notes for
 * some tables (NFR §4.2, never-transmitted). `AuditService`'s own read projection
 * excludes it entirely for that reason. So the whitelist does double duty:
 *
 *   - an unmapped (table_name, action) pair is SKIPPED, never rendered raw, which
 *     keeps this from rotting into a hundred-arm switch; and
 *   - only the fields a template names are ever read out of the JSONB, and only for
 *     tables on the list. `staff` and `signup_requests` are deliberately absent.
 *
 * A raw `new_value` never reaches a response.
 */
import { sql } from 'kysely';

import { type Executor } from './BaseService.js';

import type { CurrentUser } from './AttendanceService.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface FeedItem {
  id: string;
  actor: string;
  text: string;
  link: string | null;
  at: string;
}

/** The JSONB payloads a template may read, narrowed to what it names. */
type AuditValue = Record<string, unknown> | null;

interface TemplateContext {
  actor: string;
  period: string | null;
  recordId: string | null;
  before: AuditValue;
  after: AuditValue;
}

interface Template {
  /** Returns null to skip this row (e.g. an UPDATE that touched nothing readable). */
  text: (ctx: TemplateContext) => string | null;
  /**
   * The module page this event belongs to. A bare path gets `?period=` appended
   * when the payload carried one — that was ten identical closures before, one
   * per template, all writing the same ternary.
   */
  link?: string;
  /** Only for events that deep-link to a ROW rather than a page (APPFLOW §12). */
  rowLink?: (ctx: TemplateContext) => string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * (table_name, action) → renderer. Adding a row here is the ONLY way an event type
 * becomes visible in the feed.
 */
const TEMPLATES: Record<string, Template> = {
  'tasks:INSERT': {
    text: ({ actor, after }) => {
      const description = str(after?.description);
      return description ? `${actor} created "${description}"` : `${actor} created a task`;
    },
    link: '/tasks',
    rowLink: ({ period, recordId }) =>
      period && recordId ? `/tasks?period=${period}&highlight=${recordId}` : null,
  },
  'tasks:UPDATE': {
    text: ({ actor, after }) => {
      const status = str(after?.status);
      // An UPDATE that changed no status is not interesting on a home feed; skip it
      // rather than emit "someone updated a task".
      return status ? `${actor} marked a task as ${status}` : null;
    },
    link: '/tasks',
    rowLink: ({ period, recordId }) =>
      period && recordId ? `/tasks?period=${period}&highlight=${recordId}` : null,
  },
  'tasks:DELETE': {
    text: ({ actor }) => `${actor} deleted a task`,
    link: '/tasks',
  },
  'holidays:INSERT': {
    text: ({ actor, after }) => {
      const name = str(after?.name);
      return name ? `${actor} added the holiday ${name}` : `${actor} added a holiday`;
    },
    link: '/attendance',
  },
  'holidays:DELETE': {
    text: ({ actor, before }) => {
      const name = str(before?.name);
      return name ? `${actor} removed the holiday ${name}` : `${actor} removed a holiday`;
    },
    link: '/attendance',
  },
  'content_pipelines:UPDATE': {
    text: ({ actor }) => `${actor} moved a client's content pipeline forward`,
    link: '/content-dropper',
  },
  'content_calendar:UPDATE': {
    text: ({ actor, after }) => {
      const status = str(after?.status);
      return status ? `${actor} set a calendar day to ${status}` : null;
    },
    link: '/content-calendar',
  },
  'shoot_schedules:UPDATE': {
    text: ({ actor, after }) => {
      const status = str(after?.slot_status);
      return status ? `${actor} set a shoot slot to ${status}` : `${actor} updated a shoot slot`;
    },
    link: '/shoot-planner',
  },
  'clients:INSERT': {
    text: ({ actor, after }) => {
      const name = str(after?.name);
      return name ? `${actor} added the client ${name}` : `${actor} added a client`;
    },
    // Clients are not period-scoped, so no ?period= is appended for them.
    link: '/settings/clients',
  },
  'clients:DELETE': {
    text: ({ actor, before }) => {
      const name = str(before?.name);
      return name ? `${actor} deactivated ${name}` : `${actor} deactivated a client`;
    },
    link: '/settings/clients',
  },
  // Month events are the one 'system'-sourced thing worth surfacing — a locked or
  // rolled-over month changes what everyone can do.
  'months:LOCK': {
    text: ({ actor, recordId }) => `${actor} locked ${recordId ?? 'a month'}`,
  },
  'months:UNLOCK': {
    text: ({ actor, recordId }) => `${actor} unlocked ${recordId ?? 'a month'}`,
  },
};

/**
 * `changed_by_source = 'system'` rows are excluded EXCEPT these pairs. A trigger
 * recompute is noise; a rollover or a month lock is not.
 */
const SYSTEM_WHITELIST = new Set(['months:LOCK', 'months:UNLOCK']);

export class ActivityFeedService {
  /**
   * Newest-first feed for the home page.
   *
   * Role filter: admin/manager see everything; team_member and freelancer see only
   * their own events. Note this is NOT the same as the audit log's admin-only gate —
   * a feed of your own activity is useful to everyone, which is why FR-SET-07 wants
   * a separate endpoint rather than a relaxed audit one.
   */
  async getFeed(
    opts: { period?: string; limit?: number },
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<FeedItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    let query = db
      .selectFrom('audit_log')
      .leftJoin('staff', 'staff.id', 'audit_log.staff_id')
      .select([
        'audit_log.id as id',
        'audit_log.table_name as tableName',
        'audit_log.action as action',
        'audit_log.record_id as recordId',
        'audit_log.changed_by_source as source',
        'audit_log.created_at as createdAt',
        'audit_log.old_value as oldValue',
        'audit_log.new_value as newValue',
        'staff.name as staffName',
      ])
      .orderBy('audit_log.created_at', 'desc');

    if (currentUser.role === 'team_member' || currentUser.role === 'freelancer') {
      query = query.where('audit_log.staff_id', '=', currentUser.staffId);
    }

    // Only the pairs the whitelist knows about can ever be rendered, so filter to
    // them in SQL — otherwise a burst of unmapped rows starves the page of items
    // that WOULD have rendered.
    const keys = Object.keys(TEMPLATES);
    query = query.where((eb) =>
      eb.or(
        keys.map((key) => {
          const [tableName, action] = key.split(':') as [string, string];
          return eb.and([eb('audit_log.table_name', '=', tableName), eb('audit_log.action', '=', action)]);
        }),
      ),
    );

    if (opts.period) {
      // audit_log has no period column; the period lives inside the payload for the
      // period-scoped tables. Match on either side of the change.
      const period = opts.period;
      query = query.where(
        sql<boolean>`(audit_log.new_value->>'period' = ${period} OR audit_log.old_value->>'period' = ${period})`,
      );
    }

    // Over-fetch: a whitelisted pair can still be skipped by its renderer (a
    // status-less tasks:UPDATE), so ask for more rows than we intend to return.
    const rows = await query.limit(limit * 3).execute();

    const items: FeedItem[] = [];
    for (const row of rows) {
      const key = `${row.tableName}:${row.action}`;
      const template = TEMPLATES[key];
      if (!template) continue;
      if (row.source === 'system' && !SYSTEM_WHITELIST.has(key)) continue;

      const ctx: TemplateContext = {
        actor: row.staffName ?? 'The system',
        recordId: row.recordId,
        before: asValue(row.oldValue),
        after: asValue(row.newValue),
        period: str(asValue(row.newValue)?.period) ?? str(asValue(row.oldValue)?.period),
      };

      const text = template.text(ctx);
      if (text === null) continue; // the renderer decided this row says nothing

      // A row-level deep link when the template has one, else the module page —
      // with ?period= only when the payload carried a period, which is exactly the
      // period-scoped tables (a clients row has no period column, so it stays bare).
      const page = template.link
        ? ctx.period
          ? `${template.link}?period=${ctx.period}`
          : template.link
        : null;

      items.push({
        id: row.id,
        actor: ctx.actor,
        text,
        link: template.rowLink?.(ctx) ?? page,
        at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      });
      if (items.length === limit) break;
    }

    return items;
  }
}

/** audit_log JSONB arrives as an object from pg, or as a string if it round-tripped
 *  as text. Anything that is not a plain object becomes null — a template can then
 *  only fall back, never read a field off a surprise. */
function asValue(raw: unknown): AuditValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
