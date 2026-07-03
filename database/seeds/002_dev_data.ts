import { Kysely } from 'kysely';

import { datesInPeriod, isSunday } from '../../apps/api/src/lib/period-days.js';
import { currentIstPeriod } from '../../apps/api/src/services/BaseService.js';
import { generatePeriodRows } from '../../apps/api/src/services/period-generation.js';

import type { DB } from '@skaly/shared';

/**
 * Dev/staging seed (M-10). Gives EVERY module realistic data by reusing the same
 * generatePeriodRows() the Sprint 12 rollover will call — so dev data matches the
 * production shape exactly.
 *
 * Runs in ONE transaction so generatePeriodRows receives a real Transaction<DB>
 * (the same way the rollover composes it later).
 */
export async function seedDevData(db: Kysely<DB>) {
  // Function-level guard (not module top-level): seed.ts imports this module,
  // so a top-level process.exit() would abort the whole seed — including the
  // production-safe system actor — before it runs.
  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping dev seed — production');
    return;
  }

  // Current + prior IST months, computed dynamically (never hardcoded). The
  // prior month exists so lock/unlock is testable and the locked-period grid has
  // real data (STEP 7 manual check); both start unlocked.
  const current = currentIstPeriod();
  const prior = priorPeriod(current);

  const ADMIN_ID = '11111111-1111-1111-1111-111111111111';

  await db.transaction().execute(async (trx) => {
    // ── months ──────────────────────────────────────────────────────────────
    await trx
      .insertInto('months')
      .values([
        { period: prior, label: monthLabel(prior), locked: false },
        { period: current, label: monthLabel(current), locked: false },
      ])
      // Keep the label authoritative even if a stale row already exists (a
      // half-formed row from an earlier run would otherwise keep an ugly label).
      // Lock state is left untouched — a tester's manual lock survives a re-seed.
      .onConflict((oc) => oc.column('period').doUpdateSet((eb) => ({ label: eb.ref('excluded.label') })))
      .execute();

    // ── staff (one per role + a second team member → 5, so the grid has more
    //    than one editable column to demo) ────────────────────────────────────
    await trx
      .insertInto('staff')
      .values([
        { id: ADMIN_ID, name: 'Admin User', email: 'admin@test.skaly.in', role: 'admin', active: true },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Manager User', email: 'manager@test.skaly.in', role: 'manager', active: true },
        { id: '33333333-3333-3333-3333-333333333333', name: 'Team Member One', email: 'team@test.skaly.in', role: 'team_member', active: true },
        { id: '55555555-5555-5555-5555-555555555555', name: 'Team Member Two', email: 'team2@test.skaly.in', role: 'team_member', active: true },
        { id: '44444444-4444-4444-4444-444444444444', name: 'Freelancer User', email: 'freelancer@test.skaly.in', role: 'freelancer', active: true },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // ── clients (8: 7 client deliverables with varied shoot_slots_per_month +
    //    1 internal, which gets NO shoot/pipeline/calendar rows) ──────────────
    await trx
      .insertInto('clients')
      .values([
        { id: 'c1111111-1111-1111-1111-111111111111', name: 'Naaz Furniture', shoot_slots_per_month: 4, pieces_per_visit: 2, is_internal: false, active: true },
        { id: 'c2222222-2222-2222-2222-222222222222', name: 'Hyatt Hotels', shoot_slots_per_month: 6, pieces_per_visit: 3, is_internal: false, active: true },
        { id: 'c3333333-3333-3333-3333-333333333333', name: 'Skaly Internal', shoot_slots_per_month: 2, pieces_per_visit: 1, is_internal: true, active: true },
        { id: 'c4444444-4444-4444-4444-444444444444', name: 'Bloom Cafe', shoot_slots_per_month: 3, pieces_per_visit: 1, is_internal: false, active: true },
        { id: 'c5555555-5555-5555-5555-555555555555', name: 'Urban Threads', shoot_slots_per_month: 5, pieces_per_visit: 2, is_internal: false, active: true },
        { id: 'c6666666-6666-6666-6666-666666666666', name: 'Green Leaf Organics', shoot_slots_per_month: 2, pieces_per_visit: 1, is_internal: false, active: true },
        { id: 'c7777777-7777-7777-7777-777777777777', name: 'Velocity Motors', shoot_slots_per_month: 8, pieces_per_visit: 4, is_internal: false, active: true },
        { id: 'c8888888-8888-8888-8888-888888888888', name: 'Coastal Realty', shoot_slots_per_month: 3, pieces_per_visit: 2, is_internal: false, active: true },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // ── operational rows for both months, via the SHARED generator ───────────
    // (before holidays, so the working rows exist to be flipped).
    await generatePeriodRows(prior, trx);
    await generatePeriodRows(current, trx);

    // ── 2 sample holidays in the current month, on mid-month weekdays ─────────
    const holidayDates = datesInPeriod(current)
      .filter((d) => Number(d.slice(8)) >= 15 && !isSunday(d))
      .slice(0, 2);
    const holidayNames = ['Company Offsite', "Founder's Day"];

    if (holidayDates.length > 0) {
      await trx
        .insertInto('holidays')
        .values(
          holidayDates.map((date, i) => ({
            period: current,
            date,
            name: holidayNames[i] ?? 'Holiday',
            active: true,
            added_by: ADMIN_ID,
          })),
        )
        .onConflict((oc) => oc.columns(['period', 'date']).doNothing())
        .execute();

      // Apply them to attendance — same effect as HolidayService.create (STEP 5):
      // flip working → holiday for that date; sundays are untouched.
      for (const date of holidayDates) {
        await trx
          .updateTable('attendance_logs')
          .set({ day_type: 'holiday' })
          .where('period', '=', current)
          .where('date', '=', date)
          .where('day_type', '=', 'working')
          .execute();
      }
    }
  });
}

/** The month before `period` ('YYYY-MM') as 'YYYY-MM'. */
function priorPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)); // 1-based
  const d = new Date(Date.UTC(year, month - 2, 1)); // month-1 = current index; -1 more = prior
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Human label for a period, e.g. '2026-06' → 'June 2026'. */
function monthLabel(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)); // 1-based
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${year}`;
}
