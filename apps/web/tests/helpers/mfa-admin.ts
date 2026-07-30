import { withDb } from './db';

/**
 * The throwaway MFA admin (TEST_MFA_ADMIN_*), and the reset that makes its specs
 * re-runnable.
 *
 * Enrolment is only testable from the UN-enrolled state, so both mfa.spec.ts and
 * mfa-recovery.spec.ts have to put the account back before and after every test.
 * That reset lives here rather than in either spec: two copies of "delete the
 * Supabase factor AND clear staff.mfa_enrolled" is two places to forget the
 * second half, and forgetting it sends the next run to /mfa-challenge instead of
 * /mfa-setup — a failure that reads as broken auth.
 *
 * NEVER point TEST_MFA_ADMIN_* at a human's account: this destroys their
 * authenticator entry on every run.
 */
const MFA_EMAIL = process.env.TEST_MFA_ADMIN_EMAIL ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const sbHeaders = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` };

/** The throwaway admin's Supabase uid, read from the staff row that links them. */
export async function mfaAdminUid(): Promise<string> {
  const { rows } = await withDb((c) =>
    c.query('SELECT supabase_uid FROM staff WHERE email = $1 AND deleted_at IS NULL', [MFA_EMAIL]),
  );
  const uid = rows[0]?.supabase_uid as string | undefined;
  if (!uid) throw new Error(`No staff row with a supabase_uid for ${MFA_EMAIL}.`);
  return uid;
}

/**
 * Put the throwaway admin back in the un-enrolled state: no TOTP factor in
 * Supabase, mfa_enrolled=false in our own table.
 *
 * Both halves matter — a factor left behind sends the next run to
 * /mfa-challenge, and a stale mfa_enrolled=true does the same via the
 * middleware.
 *
 * Recovery codes go too. They are minted per enrolment, and a set left over from
 * a previous run would let a "spent code is rejected" assertion pass against a
 * code from the wrong generation.
 */
export async function resetEnrollment(): Promise<void> {
  const uid = await mfaAdminUid();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}/factors`, {
    headers: sbHeaders,
  });
  const factors = (await res.json()) as Array<{ id: string }>;
  for (const f of Array.isArray(factors) ? factors : []) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}/factors/${f.id}`, {
      method: 'DELETE',
      headers: sbHeaders,
    });
  }
  await withDb(async (c) => {
    await c.query('UPDATE staff SET mfa_enrolled = false WHERE email = $1', [MFA_EMAIL]);
    await c.query(
      'DELETE FROM mfa_recovery_codes WHERE staff_id = (SELECT id FROM staff WHERE email = $1)',
      [MFA_EMAIL],
    );
  });
}
