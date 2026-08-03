/**
 * Comments (07-API-CONTRACT §Comments, 04-APPFLOW §13, ADR-032).
 *
 * The table has existed since migration 022 and search has queried it since
 * Sprint 9; this is the write path that finally puts rows in it.
 *
 * Three things the sprint guide assumes and the schema does not have: threading
 * (`parent_id`), soft delete (`deleted_at`), and a `tasks` module. None exist,
 * none are added. What the contract DOES have and the guide omits is the
 * acknowledge flow, which is built.
 *
 * Reads apply `commentVisibility()` — the same fragment `SearchService` imports,
 * not a second copy of the rule (ADR-032, ADR-015's parity Rule).
 */
import { sql } from 'kysely';

import { AuditService } from './AuditService.js';
import { assertPeriodNotLocked, type Executor } from './BaseService.js';
import { NotificationService } from './NotificationService.js';
import { commentVisibility } from '../lib/comment-visibility.js';
import { AppError } from '../lib/errors.js';

import type { CurrentUser } from './AttendanceService.js';
import type { CommentModule } from '@skaly/shared';

/** One comment in the §1.1 wire shape (camelCase at the boundary). */
export interface CommentDTO {
  id: string;
  module: string;
  recordId: string;
  period: string;
  content: string;
  recordContext: string;
  author: { staffId: string; name: string; role: string };
  acknowledgedBy: { staffId: string; name: string } | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface CommentCreateInput {
  module: CommentModule;
  recordId: string;
  period: string;
  content: string;
}

/**
 * Which table backs each module's grid row, and which column `record_id` points
 * at. All three are `client_id` (audit H-06) — a grid row is a client-month.
 *
 * This map is the only place the module→table correspondence is written. The
 * existence check, the record_context label, and the freelancer fan-out all read
 * it, so a fourth commentable module is one entry rather than three edits.
 */
const MODULE_TABLES = {
  shoot_planner: { table: 'shoot_schedules', label: 'Shoot Planner' },
  content_dropper: { table: 'content_pipelines', label: 'Content Dropper' },
  content_calendar: { table: 'content_calendar', label: 'Content Calendar' },
} as const satisfies Record<CommentModule, { table: string; label: string }>;

export class CommentService {
  private readonly audit = new AuditService();
  private readonly notifications = new NotificationService();

  /**
   * Comments on one grid row, oldest first (a conversation reads top-down).
   *
   * Flat, not threaded — `comments` has no `parent_id`. The visibility predicate
   * does the role filtering; the route does not, so search and this panel cannot
   * disagree.
   */
  async list(
    input: { module: CommentModule; recordId: string; period: string },
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<CommentDTO[]> {
    const rows = await this.commentQuery(trx)
      .where('comments.module', '=', input.module)
      .where('comments.record_id', '=', input.recordId)
      .where('comments.period', '=', input.period)
      .where(commentVisibility(currentUser))
      .orderBy('comments.created_at', 'asc')
      .execute();

    return rows.map(toDTO);
  }

  /**
   * Post a comment on a grid row.
   *
   * `record_context` is populated server-side ("Naaz Furniture / Shoot Planner")
   * per the contract — it is the human-readable reference that survives the
   * underlying record being deleted, so it is not the client's to supply.
   */
  async create(
    input: CommentCreateInput,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<CommentDTO> {
    await assertPeriodNotLocked(input.period, trx);

    // record_id is a SOFT reference (no FK — the target table varies by module),
    // so the service is the only thing standing between a typo and a comment
    // addressed to nothing. H-06 requires this check before INSERT.
    const clientName = await this.assertRecordExists(input, currentUser, trx);

    const inserted = await trx
      .insertInto('comments')
      .values({
        module: input.module,
        record_id: input.recordId,
        period: input.period,
        staff_id: currentUser.staffId,
        content: input.content,
        record_context: `${clientName} / ${MODULE_TABLES[input.module].label}`,
        // search_vector is GENERATED ALWAYS (migration 025) — writing it errors.
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await this.fanOut(inserted.id, input, currentUser, trx);

    const row = await this.commentQuery(trx)
      .where('comments.id', '=', inserted.id)
      .executeTakeFirstOrThrow();
    return toDTO(row);
  }

  /**
   * Mark a comment acknowledged (admin/manager — `PATCH /v1/comments/:id/acknowledge`).
   *
   * Idempotent in the useful direction: re-acknowledging keeps the FIRST
   * acknowledger, because "✓ Noted by Priya" changing to a different name on a
   * second click is a worse answer than a no-op.
   */
  async acknowledge(
    id: string,
    acknowledged: boolean,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<{ acknowledgedBy: string | null; acknowledgedAt: string | null }> {
    if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
      throw new AppError('PERMISSION_DENIED', 'Only an admin or manager may acknowledge a comment.');
    }

    const existing = await trx
      .selectFrom('comments')
      .select(['id', 'period', 'acknowledged_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) {
      throw new AppError('RESOURCE_NOT_FOUND', `Comment ${id} does not exist.`);
    }
    await assertPeriodNotLocked(existing.period, trx);

    // Re-acknowledging an already-acknowledged comment is a read, not a write:
    // an empty SET is not valid SQL, and re-stamping would swap the name shown
    // on the badge for whoever clicked last.
    const keepExisting = acknowledged && existing.acknowledged_by !== null;
    const updated = keepExisting
      ? await trx
          .selectFrom('comments')
          .select(['acknowledged_by', sql<Date | null>`acknowledged_at`.as('acknowledged_at')])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      : await trx
          .updateTable('comments')
          .set(
            acknowledged
              ? { acknowledged_by: currentUser.staffId, acknowledged_at: sql`now()` }
              : { acknowledged_by: null, acknowledged_at: null },
          )
          .where('id', '=', id)
          .returning(['acknowledged_by', sql<Date | null>`acknowledged_at`.as('acknowledged_at')])
          .executeTakeFirstOrThrow();

    if (!keepExisting) {
      await this.audit.log({
        actorId: currentUser.staffId,
        action: 'UPDATE',
        entity: 'comments',
        entityId: id,
        before: { acknowledged_by: existing.acknowledged_by },
        after: { acknowledged_by: updated.acknowledged_by },
        trx,
      });
    }

    return {
      acknowledgedBy: updated.acknowledged_by,
      acknowledgedAt: updated.acknowledged_at?.toISOString() ?? null,
    };
  }

  /**
   * `new_comment` fan-out (04-APPFLOW §13) — a notification TYPE over `notify:new`,
   * never a `comment:new` socket event (the report_ready mistake Sprint 11 caught).
   *
   * APPFLOW's recipient list, not the sprint guide's "assignee + prior commenters":
   * every admin and manager, plus the freelancers assigned to that shoot row. Never
   * the author, even when the author is an admin (ADR-006).
   *
   * `linkBuilder` takes `url` from this payload and rejects anything that is not
   * portal-relative, so the deep link is built here as a route (M-08).
   */
  private async fanOut(
    commentId: string,
    input: CommentCreateInput,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<void> {
    const modulePath = input.module.replace('_', '-');
    const payload = {
      type: 'new_comment' as const,
      title: 'New comment',
      body: input.content.slice(0, 140),
      data: {
        url: `/${modulePath}?period=${input.period}&comments=${input.recordId}`,
        recordId: input.recordId,
        module: input.module,
        commentId,
      },
      recordId: commentId,
      trx,
    };

    await this.notifications.createForStaff({
      ...payload,
      actorId: currentUser.staffId,
      roles: ['admin', 'manager'],
    });

    if (input.module !== 'shoot_planner') return;

    // Freelancers assigned a slot in this client-row. Distinct, and never the
    // author — a freelancer can comment on their own shoot.
    const assigned = await trx
      .selectFrom('shoot_schedules')
      .select('freelancer_id')
      .distinct()
      .where('client_id', '=', input.recordId)
      .where('period', '=', input.period)
      .where('freelancer_id', 'is not', null)
      .where('freelancer_id', '!=', currentUser.staffId)
      .execute();

    for (const { freelancer_id } of assigned) {
      if (!freelancer_id) continue;
      await this.notifications.create({ ...payload, recipientId: freelancer_id });
    }
  }

  /**
   * Does this grid row exist, and may this user reach it? Returns the client name
   * for `record_context`.
   *
   * A freelancer may only comment on a row they hold a slot in — the same
   * boundary `commentVisibility` applies on read, so they cannot write a comment
   * they would then be unable to see.
   */
  private async assertRecordExists(
    input: CommentCreateInput,
    currentUser: CurrentUser,
    trx: Executor,
  ): Promise<string> {
    const { table } = MODULE_TABLES[input.module];

    let q = trx
      .selectFrom(table)
      .innerJoin('clients', 'clients.id', `${table}.client_id`)
      .select('clients.name as name')
      .where(`${table}.client_id`, '=', input.recordId)
      .where(`${table}.period`, '=', input.period);

    if (currentUser.role === 'freelancer') {
      if (input.module !== 'shoot_planner') {
        throw new AppError('RESOURCE_NOT_FOUND', 'No such record for this module and period.');
      }
      q = q.where('shoot_schedules.freelancer_id', '=', currentUser.staffId);
    }

    const row = await q.executeTakeFirst();
    if (!row) {
      // Same answer for "does not exist" and "not yours" — existence is not
      // discoverable by probing ids (the ShootPlannerService.getSlot rule).
      throw new AppError('RESOURCE_NOT_FOUND', 'No such record for this module and period.');
    }
    return row.name;
  }

  /** Comment + author + acknowledger, the shape every read returns. */
  private commentQuery(trx: Executor) {
    return trx
      .selectFrom('comments')
      .innerJoin('staff as author', 'author.id', 'comments.staff_id')
      .leftJoin('staff as ack', 'ack.id', 'comments.acknowledged_by')
      .select([
        'comments.id as id',
        'comments.module as module',
        'comments.record_id as record_id',
        'comments.period as period',
        'comments.content as content',
        'comments.record_context as record_context',
        'comments.created_at as created_at',
        'comments.acknowledged_at as acknowledged_at',
        'author.id as author_id',
        'author.name as author_name',
        'author.role as author_role',
        'ack.id as ack_id',
        'ack.name as ack_name',
      ]);
  }
}

interface JoinedCommentRow {
  id: string;
  module: string;
  record_id: string;
  period: string;
  content: string;
  record_context: string;
  created_at: Date;
  acknowledged_at: Date | null;
  author_id: string;
  author_name: string;
  author_role: string;
  ack_id: string | null;
  ack_name: string | null;
}

function toDTO(row: JoinedCommentRow): CommentDTO {
  return {
    id: row.id,
    module: row.module,
    recordId: row.record_id,
    period: row.period,
    content: row.content,
    recordContext: row.record_context,
    author: { staffId: row.author_id, name: row.author_name, role: row.author_role },
    acknowledgedBy: row.ack_id ? { staffId: row.ack_id, name: row.ack_name ?? '' } : null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
