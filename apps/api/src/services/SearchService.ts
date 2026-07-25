/**
 * SearchService — GET /v1/search over four categories (ADR-015, audit M-05).
 *
 * FOUR INDEPENDENT QUERIES, run in parallel. They are deliberately not unioned into
 * one clever statement: different tables, different role predicates, and — the part
 * that actually forbids it — TWO DIFFERENT RANKING STRATEGIES, because only two of
 * the four categories have a `search_vector` column at all.
 *
 *   tasks, comments  → full-text: search_vector @@ websearch_to_tsquery(...)
 *                      ranked by ts_rank        (GIN, migrations 010 + 025)
 *   clients, staff   → trigram:   name ILIKE '%q%'
 *                      ranked by similarity(name, q)   (GIN gin_trgm_ops, mig 025)
 *
 * There is no `search_indexes` table — migration 025 creates INDEXES. And ranking
 * clients/staff with ts_rank does not compile: the column does not exist.
 *
 * ROLE SCOPE IS PARITY, NOT STRICTNESS (ADR-015 §2). Each category mirrors its
 * owning service's scope exactly. team_member tasks are NOT row-filtered, because
 * Auth-Matrix §4 grants team_member read on all tasks; filtering search harder than
 * the service is as much a parity break as filtering it softer — it just fails safe,
 * so nobody notices. The real isolation surface is freelancer and comments.
 *
 * `websearch_to_tsquery` over `plainto_tsquery` (M-05's default): it never throws on
 * user input, and it understands quoted phrases and -exclusion — which is what a
 * search box actually gets typed into.
 */
import { sql, type Expression, type SqlBool } from 'kysely';

import { getCurrentPeriod, type Executor } from './BaseService.js';
import { softDeletable } from '../lib/queries.js';

import type { CurrentUser } from './AttendanceService.js';
import type { Role } from '@skaly/shared/schemas/auth';

/** UI/UX §17 renders 5 per category with [Show more]; 20 gives it something to
 *  reveal in ONE round trip. Audit M-05's LIMIT 5 leaves [Show more] nothing. */
const PER_CATEGORY_LIMIT = 20;

/** Below this, a query matches half the database — and a 1-char trigram scan is
 *  the one input that makes the GIN index useless. */
const MIN_QUERY_LENGTH = 2;

export type SearchScope = 'current' | 'all_time';

export interface SearchTaskHit {
  id: string;
  description: string;
  period: string;
  status: string;
  clientName: string | null;
}
export interface SearchCommentHit {
  id: string;
  content: string;
  module: string;
  recordContext: string;
  period: string;
}
export interface SearchClientHit {
  id: string;
  name: string;
}
export interface SearchStaffHit {
  id: string;
  name: string;
  role: Role;
  avatarUrl: string | null;
}

export interface SearchResults {
  tasks: SearchTaskHit[];
  clients: SearchClientHit[];
  staff: SearchStaffHit[];
  comments: SearchCommentHit[];
}

const EMPTY: SearchResults = { tasks: [], clients: [], staff: [], comments: [] };

export class SearchService {
  /**
   * The two ranking strategies, as the only thing shared between the four queries.
   *
   * This is where the repetition genuinely is — the match+rank expression, not the
   * query. Merging the QUERIES would mean merging these two, and they are not the
   * same operation: one is a lexeme match over a stored tsvector, the other a
   * trigram similarity over a plain text column.
   */
  private tsMatch(column: Expression<string | null>, q: string): Expression<SqlBool> {
    return sql<SqlBool>`${column} @@ websearch_to_tsquery('english', ${q})`;
  }

  private tsRank(column: Expression<string | null>, q: string): Expression<number> {
    return sql<number>`ts_rank(${column}, websearch_to_tsquery('english', ${q}))`;
  }

  /** ILIKE drives the gin_trgm_ops index; similarity does the ordering. */
  private trigramMatch(column: Expression<string>, q: string): Expression<SqlBool> {
    return sql<SqlBool>`${column} ILIKE '%' || ${q} || '%'`;
  }

  private trigramRank(column: Expression<string>, q: string): Expression<number> {
    return sql<number>`similarity(${column}, ${q})`;
  }

  async search(
    rawQuery: string,
    scope: SearchScope,
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<SearchResults> {
    const q = rawQuery.trim();
    // Guard BEFORE any DB work — four queries for a single character is pure waste
    // and the palette fires this on every keystroke past the debounce.
    if (q.length < MIN_QUERY_LENGTH) return { ...EMPTY };

    // Resolved once, not per query. `scope` is a NO-OP for clients and staff:
    // neither has a period column, and applying it there returns zero rows and
    // reads as a broken search (ADR-015 §4).
    const period = scope === 'current' ? (await getCurrentPeriod(db)).period : undefined;

    const [tasks, comments, clients, staff] = await Promise.all([
      this.searchTasks(q, period, currentUser, db),
      this.searchComments(q, period, currentUser, db),
      this.searchClients(q, db),
      this.searchStaff(q, db),
    ]);

    return { tasks, clients, staff, comments };
  }

  /**
   * tasks — admin/manager/team_member all read ALL tasks (Auth-Matrix §4), which is
   * exactly `TaskService.getTasks`'s scope. freelancer has no task access at all, so
   * the query is SKIPPED rather than filtered to nothing.
   */
  private async searchTasks(
    q: string,
    period: string | undefined,
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<SearchTaskHit[]> {
    if (currentUser.role === 'freelancer') return [];

    let query = db
      .selectFrom('tasks')
      .leftJoin('clients', 'clients.id', 'tasks.client_id')
      .select([
        'tasks.id as id',
        'tasks.description as description',
        'tasks.period as period',
        'tasks.status as status',
        'clients.name as clientName',
      ])
      // softDeletable() cannot be used on a multi-table select (bare `deleted_at`
      // would be ambiguous), so the tombstone filter is explicit and qualified —
      // same reason TaskService.getTasks does it this way.
      .where('tasks.deleted_at', 'is', null)
      .where(this.tsMatch(sql.ref('tasks.search_vector'), q));

    if (period) query = query.where('tasks.period', '=', period);

    return query
      .orderBy(this.tsRank(sql.ref('tasks.search_vector'), q), 'desc')
      .limit(PER_CATEGORY_LIMIT)
      .execute();
  }

  /**
   * comments — the real isolation surface alongside freelancer tasks.
   *
   *   admin/manager → all
   *   team_member   → their own, PLUS manager/admin comments on a record they have
   *                   themselves commented on (a reply they need to see)
   *   freelancer    → their own only
   */
  private async searchComments(
    q: string,
    period: string | undefined,
    currentUser: CurrentUser,
    db: Executor,
  ): Promise<SearchCommentHit[]> {
    let query = db
      .selectFrom('comments')
      .select([
        'comments.id as id',
        'comments.content as content',
        'comments.module as module',
        'comments.record_context as recordContext',
        'comments.period as period',
      ])
      .where(this.tsMatch(sql.ref('comments.search_vector'), q));

    if (period) query = query.where('comments.period', '=', period);

    if (currentUser.role === 'freelancer') {
      query = query.where('comments.staff_id', '=', currentUser.staffId);
    } else if (currentUser.role === 'team_member') {
      const self = currentUser.staffId;
      query = query.where((eb) =>
        eb.or([
          eb('comments.staff_id', '=', self),
          // A manager/admin reply on a record this member commented on.
          eb.and([
            eb.exists(
              eb
                .selectFrom('staff')
                .select(sql`1`.as('one'))
                .whereRef('staff.id', '=', 'comments.staff_id')
                .where('staff.role', 'in', ['admin', 'manager']),
            ),
            eb.exists(
              eb
                .selectFrom('comments as mine')
                .select(sql`1`.as('one'))
                .whereRef('mine.record_id', '=', 'comments.record_id')
                .whereRef('mine.module', '=', 'comments.module')
                .where('mine.staff_id', '=', self),
            ),
          ]),
        ]),
      );
    }

    return query
      .orderBy(this.tsRank(sql.ref('comments.search_vector'), q), 'desc')
      .limit(PER_CATEGORY_LIMIT)
      .execute();
  }

  /** clients — mirrors ClientService.list's default scope exactly: active, not
   *  soft-deleted. All internal roles may read them; `scope` does not apply. */
  private async searchClients(q: string, db: Executor): Promise<SearchClientHit[]> {
    return softDeletable(db.selectFrom('clients').select(['id', 'name']))
      .where('active', '=', true)
      .where(this.trigramMatch(sql.ref('name'), q))
      .orderBy(this.trigramRank(sql.ref('name'), q), 'desc')
      .limit(PER_CATEGORY_LIMIT)
      .execute();
  }

  /**
   * staff — the LIMITED field shape (`GET /v1/staff`), never SELECT *. That shape is
   * a security boundary: the staff row carries DOB, mobile and CV keys (NFR §4.2),
   * and this endpoint is readable by every role.
   */
  private async searchStaff(q: string, db: Executor): Promise<SearchStaffHit[]> {
    const rows = await softDeletable(
      db.selectFrom('staff').select(['id', 'name', 'role', 'avatar_url']),
    )
      .where('active', '=', true)
      .where(this.trigramMatch(sql.ref('name'), q))
      .orderBy(this.trigramRank(sql.ref('name'), q), 'desc')
      .limit(PER_CATEGORY_LIMIT)
      .execute();

    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role as Role, avatarUrl: r.avatar_url }));
  }
}
