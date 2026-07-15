/**
 * DEV ONLY — wire the seeded staff to real Supabase Auth users so they can log
 * in. The seed inserts staff rows with supabase_uid = NULL; login resolves a
 * staff row by supabase_uid (auth-verify.ts), so without this they get a 401
 * NO_STAFF_ROW.
 *
 * For each seeded email: create (or find) a Supabase user with a known password
 * and email_confirm=true, then set staff.supabase_uid to that user's id.
 * Admin + manager also get mfa_enrolled=true — a dev shortcut past /mfa-setup
 * (login-time TOTP is deferred to Sprint 8, ADR-002), so they land in the portal
 * with just email+password.
 *
 * Run:  pnpm --filter @skaly/api exec tsx scripts/dev-link-supabase-users.ts
 * Idempotent — safe to re-run.
 */
import { createClient } from '@supabase/supabase-js';

import { db } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';

const PASSWORD = 'Skaly!Dev2026';
const USERS = [
  { email: 'admin@test.skaly.in', mfa: true },
  { email: 'manager@test.skaly.in', mfa: true },
  { email: 'team@test.skaly.in', mfa: false },
  { email: 'team2@test.skaly.in', mfa: false },
  { email: 'freelancer@test.skaly.in', mfa: false },
];

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserIdByEmail(email: string): Promise<string | undefined> {
  // Paginate through the project's users (dev project is small).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

async function main() {
  for (const { email, mfa } of USERS) {
    // Create, or reuse an existing user.
    let uid: string | undefined;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) {
      uid = await findUserIdByEmail(email);
      if (!uid) throw new Error(`createUser failed for ${email}: ${error.message}`);
      // Reset the password so the known one always works on re-run.
      await admin.auth.admin.updateUserById(uid, { password: PASSWORD });
      console.log(`~ ${email.padEnd(28)} exists → ${uid}`);
    } else {
      uid = data.user.id;
      console.log(`+ ${email.padEnd(28)} created → ${uid}`);
    }

    const res = await db
      .updateTable('staff')
      .set({ supabase_uid: uid, mfa_enrolled: mfa })
      .where('email', '=', email)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) {
      console.log(`  ! no staff row for ${email} — run db:seed first`);
    }
  }

  console.log(`\nAll set. Password for every account: ${PASSWORD}`);
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
