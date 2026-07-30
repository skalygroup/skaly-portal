/**
 * ONE implementation of "who may read this comment" (ADR-015 §1 and its Rule).
 *
 * Two readers need it: `SearchService`'s comments query (shipped Sprint 9) and
 * `GET /v1/comments`. If they drift, one direction leaks a row and the other
 * hides a reply the reader was notified about — and neither shows up as a test
 * failure, because each service only ever tests itself. So the predicate lives
 * here and both pass it to `.where()`.
 *
 *   admin / manager → every comment.
 *   team_member     → their own, PLUS manager/admin comments on a record they
 *                     have themselves commented on (a reply they need to see).
 *   freelancer      → comments on their own SHOOT ROWS — not merely comments
 *                     they authored. 04-APPFLOW §13 notifies the assigned
 *                     freelancer of every new comment on their shoot, so
 *                     author-scoping would point that notification at a row
 *                     they cannot read (ADR-015 §2: stricter than the owning
 *                     service is still a parity break, it just fails safe).
 *                     Row access ends when the assignment does — same as
 *                     `ShootPlannerService.getSlot`, which 404s them.
 *
 * Only shoot_planner comments are reachable by a freelancer at all: Auth-Matrix
 * §4 gives them no content_dropper or content_calendar access.
 */
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { CurrentUser } from '../services/AttendanceService.js';
import type { DB } from '@skaly/shared';

export function commentVisibility(
  currentUser: CurrentUser,
): (eb: ExpressionBuilder<DB, 'comments'>) => Expression<SqlBool> {
  const self = currentUser.staffId;

  return (eb) => {
    if (currentUser.role === 'freelancer') {
      return eb.and([
        eb('comments.module', '=', 'shoot_planner'),
        eb.exists(
          eb
            .selectFrom('shoot_schedules')
            .select(sql`1`.as('one'))
            .whereRef('shoot_schedules.id', '=', 'comments.record_id')
            .where('shoot_schedules.freelancer_id', '=', self),
        ),
      ]);
    }

    if (currentUser.role === 'team_member') {
      return eb.or([
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
      ]);
    }

    return eb.lit(true);
  };
}
