/**
 * TODO(Sprint 8 pre-flight, FIRST item): identity-parse DATE globally.
 *
 *   pg.types.setTypeParser(1082, (v) => v);   // 1082 = DATE → keep 'YYYY-MM-DD'
 *
 * node-postgres parses a DATE column into a JS Date at LOCAL midnight, so any
 * DTO that formats it with toISOString() shifts it one day BACKWARDS east of
 * UTC. Sprint 7 hit this on content_calendar.date — an edit to the 21st
 * rendered on the 20th — and fixed it by routing that table through a single
 * to_char projection. The parser is GLOBAL, so every other DATE column still
 * carries the same off-by-one:
 *
 *   HIGH   attendance_logs.date  (grid keys cells staffId:date — same failure)
 *          tasks.date            (groups under the wrong date header)
 *   MED    tasks.deadline        (overdue a day early)
 *          shoot_schedules.slot_date          (display + week banding)
 *          content_pipelines.coming_shoot_date (boundary vs CURRENT_DATE)
 *   LOW    content_pipelines.last_shoot_date, holidays.date,
 *          staff/signup_requests.date_of_birth (display only, still wrong)
 *
 * Leave TIMESTAMPTZ (1184) alone — those are absolute instants and Date is right.
 *
 * COST: kysely-codegen types DATE as Date, so after the parser change runtime and
 * types disagree — those columns need a ColumnType override to `string`. That
 * type-alignment IS the work; the parser itself is one line.
 *
 * WHY BEFORE SPRINT 8, NOT LATER: the bot's get_attendance / list_tasks /
 * get_shoot_schedule hand dates to an LLM that will state them as fact. A shifted
 * date in a grid is visible; the same date in a confident sentence is not.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { env } from './env.js';

import type { DB } from '@skaly/shared';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});
