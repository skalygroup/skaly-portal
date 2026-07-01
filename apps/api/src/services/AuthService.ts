import { createHash, randomBytes } from 'node:crypto';

import { Upload } from '@aws-sdk/lib-storage';
import { sql, type Kysely, type Transaction } from 'kysely';

import { AttendanceService } from './AttendanceService.js';
import { AuditService } from './AuditService.js';
import { NotificationService } from './NotificationService.js';

import type { S3Client } from '@aws-sdk/client-s3';
import type { DB } from '@skaly/shared';
import type { Role, SignupRequestInput } from '@skaly/shared/schemas/auth';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Redis } from 'ioredis';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';



/**
 * Domain error carrying the HTTP status the route should surface. Routes map
 * `code` straight onto the error envelope; `statusCode` drives the response.
 */
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}


// 5-minute TTL, matching the auth plugin's staff_lookup cache (STEP 4).
const STAFF_CACHE_TTL_SECONDS = 300;
const staffCacheKey = (supabaseUid: string) => `staff_lookup:${supabaseUid}`;

// Where Supabase's recovery email lands the user to set a new password. The
// frontend completes the flow with supabase.auth.updateUser({ password }) once
// the recovery token has established a session.
const PASSWORD_RESET_REDIRECT_URL = 'http://localhost:3000/reset-password';

// Anti-enumeration timing (M-08). The matched password-reset path makes a real
// network round-trip to Supabase; the unmatched path has nothing to do and would
// return far faster, leaking which emails exist. We keep a rolling average of the
// last few matched-path durations and make the unmatched path sleep that long
// (plus a small jitter) so response latency is indistinguishable between the two.
const HIT_DURATION_SAMPLES: number[] = [];
const HIT_DURATION_SAMPLE_CAP = 20;
// Used only until the first real send calibrates the average — deliberately on
// the slow side so an early unmatched request never looks faster than a match.
const FALLBACK_HIT_DURATION_MS = 800;
const TIMING_JITTER_MS = 20;

function recordHitDuration(ms: number): void {
  HIT_DURATION_SAMPLES.push(ms);
  if (HIT_DURATION_SAMPLES.length > HIT_DURATION_SAMPLE_CAP) HIT_DURATION_SAMPLES.shift();
}

function avgHitDurationMs(): number {
  if (HIT_DURATION_SAMPLES.length === 0) return FALLBACK_HIT_DURATION_MS;
  return HIT_DURATION_SAMPLES.reduce((a, b) => a + b, 0) / HIT_DURATION_SAMPLES.length;
}

/** Uniform jitter in [-maxMs, +maxMs] so the mimic isn't a constant value. */
function jitterMs(maxMs: number): number {
  return (Math.random() * 2 - 1) * maxMs;
}

export interface CreateInviteParams {
  /** Required — every invite is scoped to a specific address (APPFLOW §2.7). */
  email: string;
  role: Role;
  createdBy: string;
  /** Reuse an outer transaction when the caller already opened one. */
  trx?: Transaction<DB>;
}

export interface ConsumeInviteSignupParams {
  token: string;
  password: string;
  name: string;
  dateOfBirth: string; // ISO YYYY-MM-DD
  mobileNumber: string;
}

/** A CV upload handed to the service as a stream — never buffered to memory. */
export interface CvUpload {
  stream: Readable;
  mimetype: string;
}

/** Allow-list of CV content types and their canonical file extensions. */
const CV_MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};


/**
 * The admin MFA *enroll/verify* surface the spec targets. The installed
 * @supabase/auth-js (2.108.2) admin client does NOT expose these — enroll and
 * verify live on the client MFA API and require the user's own session. Newer /
 * self-hosted GoTrue builds (and the spec) put them under admin.mfa, so we
 * detect them at runtime and cast through this shape when present.
 */
interface MfaAdminEnrollApi {
  enrollFactor(params: {
    userId: string;
    factorType: 'totp';
    friendlyName?: string;
  }): Promise<{
    data: { id: string; totp: { qr_code: string; secret: string; uri: string } } | null;
    error: { message: string } | null;
  }>;
  verifyFactor?(params: { userId: string; factorId: string; code: string }): Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export class AuthService {
  private readonly attendance = new AttendanceService();
  private readonly audit = new AuditService();
  private readonly notifications = new NotificationService();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly redis: Redis,
    private readonly supabaseAdmin: SupabaseClient,
    private readonly logger: Logger,
    private readonly s3: S3Client,
    private readonly r2Bucket: string,
  ) {}

  /**
   * Structured security log for events that are NOT domain-row mutations and so
   * have no place in audit_log (which is table-change-scoped: table_name +
   * record_id UUID + CRUD action). Password-reset request/confirm run entirely
   * against Supabase and can be anonymous, so they're recorded here, not audited.
   */
  private securityLog(event: string, details: Record<string, unknown>): void {
    this.logger.info({ security: { event, ...details } }, 'security');
  }


  /**
   * Create an invite link and (when email-scoped) send the Supabase invite
   * email. Runs in one transaction — reuses `trx` if the caller passed one.
   */
  async createInvite(params: CreateInviteParams): Promise<{
    id: string;
    token: string;
    expiresAt: Date;
    email: string;
    role: string;
  }> {
    const { email, role, createdBy } = params;

    const run = async (trx: Transaction<DB>) => {
      // a/b. Insert; token + expires_at are generated by the table defaults.
      const row = await trx
        .insertInto('invite_links')
        .values({ email, role, created_by: createdBy })
        .returning(['id', 'token', 'expires_at', 'role'])
        .executeTakeFirstOrThrow();

      // c. Create the Supabase user + send the branded invite email in one
      // step. Our token rides along in user_metadata so /signup/invite can
      // match it. The created user has no password yet — signup sets it.
      // We persist the user's UUID on the invite so signup can resolve it
      // from the token alone (the [Copy link] fallback in APPFLOW §2.7 shares
      // this same token URL manually if the email itself doesn't arrive).
      const { data, error } = await this.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { invite_token: row.token },
      });
      if (error || !data?.user) {
        // Invite is only valid once the Supabase user exists; roll back.
        throw new AuthError('INVITE_EMAIL_FAILED', 502, 'Could not send the invite email.');
      }
      await trx
        .updateTable('invite_links')
        .set({ supabase_uid: data.user.id })
        .where('id', '=', row.id)
        .execute();

      // d. Audit.
      await this.audit.log({
        actorId: createdBy,
        entity: 'invite_links',
        entityId: row.id,
        action: 'INSERT',
        after: { email, role },
        trx,
      });

      return {
        id: row.id,
        token: row.token,
        expiresAt: new Date(row.expires_at as unknown as string),
        email,
        role: row.role,
      };
    };

    return params.trx ? run(params.trx) : this.db.transaction().execute(run);
  }

  /**
   * Pre-validate an invite token for the redemption page (read-only). Returns
   * the scoped email + role so the form can show them and the client can
   * auto-login after redeeming. Throws the same AuthErrors as
   * consumeInviteSignup so the frontend handles both with one code switch.
   */
  async checkInvite(token: string): Promise<{ email: string; role: string }> {
    const invite = await this.db
      .selectFrom('invite_links')
      .select(['email', 'role', 'used_at', 'expires_at'])
      .where('token', '=', token)
      .executeTakeFirst();

    if (!invite) {
      throw new AuthError('INVITE_NOT_FOUND', 404, 'Invite not found.');
    }
    if (invite.used_at !== null) {
      throw new AuthError('INVITE_ALREADY_USED', 409, 'This invite has already been used.');
    }
    if (new Date(invite.expires_at as unknown as string).getTime() < Date.now()) {
      throw new AuthError('INVITE_EXPIRED', 410, 'This invite has expired.');
    }
    return { email: invite.email ?? '', role: invite.role };
  }

  /**
   * Consume an invite token: validate it, set the password on the Supabase user
   * that was created at invite time, create the staff row, and mark the token
   * used — all in one transaction.
   */
  async consumeInviteSignup(
    params: ConsumeInviteSignupParams,
  ): Promise<{ staffId: string; supabaseUid: string }> {
    const { token, password, name, dateOfBirth, mobileNumber } = params;

    return this.db.transaction().execute(async (trx) => {
      // a. Lock the invite row for the duration of the transaction.
      const invite = await trx
        .selectFrom('invite_links')
        .selectAll()
        .where('token', '=', token)
        .forUpdate()
        .executeTakeFirst();

      if (!invite) {
        throw new AuthError('INVITE_NOT_FOUND', 404, 'Invite not found.');
      }
      // b.
      if (invite.used_at !== null) {
        throw new AuthError('INVITE_ALREADY_USED', 409, 'This invite has already been used.');
      }
      // c.
      if (new Date(invite.expires_at as unknown as string).getTime() < Date.now()) {
        throw new AuthError('INVITE_EXPIRED', 410, 'This invite has expired.');
      }

      // d. H-04: refuse if a staff row already exists for this email, in ANY
      // state (including soft-deleted). Failing here avoids orphaning a freshly
      // created Supabase user against a staff row we can't insert.
      if (invite.email) {
        const existing = await trx
          .selectFrom('staff')
          .select('id')
          .where('email', '=', invite.email)
          .limit(1)
          .executeTakeFirst();
        if (existing) {
          throw new AuthError('ALREADY_PROCESSED', 409, 'This account has already been processed.');
        }
      }

      // e. The Supabase user was created at invite time (inviteUserByEmail).
      // Set its password and confirm the email — email_confirm: true means the
      // user can log in immediately; the invite email was the confirmation gate.
      if (!invite.supabase_uid) {
        // Should never happen for invites created via createInvite.
        throw new AuthError('INVITE_NOT_FOUND', 404, 'Invite is not linked to an account.');
      }
      const supabaseUid = invite.supabase_uid;
      const { error } = await this.supabaseAdmin.auth.admin.updateUserById(supabaseUid, {
        password,
        email_confirm: true,
        user_metadata: { name },
      });
      if (error) {
        throw new AuthError('SUPABASE_UPDATE_FAILED', 500, 'Could not finalize the user account.');
      }

      // Everything past this point can leave the Supabase user without a matching
      // staff row on failure (the transaction rolls back our rows, but the
      // external user persists). MVP: log loudly; Sprint 13 adds a janitor job.
      try {
        // f. Insert the staff row.
        const staff = await trx
          .insertInto('staff')
          .values({
            supabase_uid: supabaseUid,
            name,
            email: invite.email ?? '',
            role: invite.role,
            date_of_birth: dateOfBirth,
            mobile_number: mobileNumber,
            active: true,
            mfa_enrolled: false,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        // g. Mark the invite consumed.
        await trx
          .updateTable('invite_links')
          .set({ used_at: sql`NOW()`, used_by: staff.id })
          .where('id', '=', invite.id)
          .execute();

        // h. Audit.
        await this.audit.log({
          actorId: staff.id,
          entity: 'staff',
          entityId: staff.id,
          action: 'INSERT',
          after: { email: invite.email, role: invite.role, via: 'invite' },
          trx,
        });

        // i. Pre-warm the staff_lookup cache (same shape the auth plugin reads).
        try {
          await this.redis.set(
            staffCacheKey(supabaseUid),
            JSON.stringify({
              id: staff.id,
              supabase_uid: supabaseUid,
              name,
              email: invite.email ?? '',
              role: invite.role,
              active: true,
              mfa_enrolled: false,
              avatar_url: null,
            }),
            'EX',
            STAFF_CACHE_TTL_SECONDS,
          );
        } catch (err) {
          this.logger.warn({ err, supabaseUid }, 'consumeInviteSignup: cache pre-warm failed');
        }

        return { staffId: staff.id, supabaseUid };
      } catch (err) {
        this.logger.error(
          { err, supabaseUid, email: invite.email },
          'consumeInviteSignup: ORPHANED Supabase user — created in Supabase but staff insert failed',
        );
        throw err;
      }
    });
  }

  /**
   * Self-signup: record a pending signup_requests row, optionally stream the
   * applicant's CV to R2, and notify every admin. Whole thing runs in one
   * transaction so a failed CV upload (e.g. oversized file) leaves no row
   * behind. Duplicate emails are rejected per audit H-04.
   */
  async signupRequest(
    form: SignupRequestInput,
    cv?: CvUpload,
  ): Promise<{ requestId: string; status: 'pending' }> {
    // Defense in depth: the schema already excludes 'admin', but a hand-rolled
    // API call could smuggle it past validation. Never let it through here.
    if ((form.roleRequested as string) === 'admin') {
      throw new AuthError('INVALID_ROLE', 422, 'Admin cannot be self-requested.');
    }

    // Validate MIME up-front (cheap, from the part header) so we fail fast
    // without inserting a row or reading the stream.
    let cvExt: string | undefined;
    if (cv) {
      cvExt = CV_MIME_EXT[cv.mimetype];
      if (!cvExt) {
        throw new AuthError('INVALID_FILE_TYPE', 422, 'CV must be a PDF or Word document.');
      }
    }

    return this.db.transaction().execute(async (trx) => {
      // H-04 check #1 (fast path): any staff row with this email, in ANY state
      // (deleted_at NOT filtered) blocks a new request.
      const existingStaff = await trx
        .selectFrom('staff')
        .select('id')
        .where('email', '=', form.email)
        .limit(1)
        .executeTakeFirst();
      if (existingStaff) {
        throw new AuthError(
          'ALREADY_PROCESSED',
          409,
          'A request or account already exists for this email.',
        );
      }

      // Insert pending request. H-04 check #2 (race backstop): the partial
      // unique index idx_signup_requests_email_pending rejects a concurrent
      // second pending row with a 23505 unique violation.
      let requestId: string;
      try {
        const row = await trx
          .insertInto('signup_requests')
          .values({
            name: form.name,
            email: form.email,
            date_of_birth: form.dateOfBirth,
            mobile_number: form.mobileNumber,
            role_requested: form.roleRequested,
            message: form.message ?? null,
            google_uid: form.googleUid ?? null,
            status: 'pending',
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
        requestId = row.id;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AuthError(
            'ALREADY_PROCESSED',
            409,
            'A request or account already exists for this email.',
          );
        }
        throw err;
      }

      // Stream the CV straight to R2 — never buffered. lib-storage's Upload
      // handles multipart for large streams; a too-large stream surfaces the
      // multipart 5MB limit error, which rolls back this whole transaction.
      if (cv && cvExt) {
        const key = `cvs/requests/${requestId}/cv.${cvExt}`;
        const upload = new Upload({
          client: this.s3,
          params: {
            Bucket: this.r2Bucket,
            Key: key,
            Body: cv.stream,
            ContentType: cv.mimetype,
          },
        });
        await upload.done();

        await trx
          .updateTable('signup_requests')
          .set({ cv_file_key: key })
          .where('id', '=', requestId)
          .execute();
      }

      // Notify every active admin.
      const admins = await trx
        .selectFrom('staff')
        .select('id')
        .where('role', '=', 'admin')
        .where('active', '=', true)
        .where('deleted_at', 'is', null)
        .execute();
      for (const admin of admins) {
        await this.notifications.create({
          recipientId: admin.id,
          type: 'signup_request',
          title: `New access request from ${form.name}`,
          data: { requestId, roleRequested: form.roleRequested },
          trx,
        });
      }

      return { requestId, status: 'pending' as const };
    });
  }

  /**
   * Admin approves a pending signup request. In ONE transaction: create the
   * Supabase user (no password — they set it via the recovery link we email),
   * create the staff row, backfill the current attendance period (M-02), and
   * mark the request approved. If any step fails, all of it rolls back.
   */
  async approveSignupRequest(
    requestId: string,
    roleAssigned: Role,
    reviewerStaffId: string,
  ): Promise<{ staffId: string; supabaseUid: string; attendanceRowsCreated: number }> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      // a. Lock the request row for the transaction.
      const row = await trx
        .selectFrom('signup_requests')
        .selectAll()
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) {
        throw new AuthError('NOT_FOUND', 404, 'Signup request not found.');
      }
      if (row.status !== 'pending') {
        throw new AuthError('ALREADY_REVIEWED', 409, 'This request has already been reviewed.');
      }

      // b. H-04 backstop: a staff row may have appeared (any state) since the
      // request was filed. If so, mark this request rejected with an internal
      // note (committed by returning, not throwing) and signal the caller.
      const existing = await trx
        .selectFrom('staff')
        .select('id')
        .where('email', '=', row.email)
        .limit(1)
        .executeTakeFirst();
      if (existing) {
        await trx
          .updateTable('signup_requests')
          .set({
            status: 'rejected',
            rejection_note: 'Account already exists at approval time',
            reviewed_at: sql`NOW()`,
            reviewed_by: reviewerStaffId,
          })
          .where('id', '=', requestId)
          .execute();
        await this.audit.log({
          actorId: reviewerStaffId,
          entity: 'signup_requests',
          entityId: requestId,
          action: 'UPDATE',
          after: { status: 'rejected', reason: 'h04_account_exists' },
          trx,
        });
        return { kind: 'h04' as const };
      }

      // c. Create the Supabase user with no password; recovery link sets it.
      const { data, error } = await this.supabaseAdmin.auth.admin.createUser({
        email: row.email,
        email_confirm: true,
        user_metadata: { name: row.name },
      });
      if (error || !data?.user) {
        throw new AuthError('SUPABASE_CREATE_FAILED', 500, 'Could not create the user account.');
      }
      const supabaseUid = data.user.id;

      // Past this point a failure can orphan the Supabase user (our rows roll
      // back, the external user persists). MVP: log loudly; Sprint 13 janitor.
      try {
        // d. Create the staff row.
        const staff = await trx
          .insertInto('staff')
          .values({
            supabase_uid: supabaseUid,
            name: row.name,
            email: row.email,
            role: roleAssigned,
            date_of_birth: row.date_of_birth,
            mobile_number: row.mobile_number,
            active: true,
            mfa_enrolled: false,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        // e. M-02: backfill attendance in the SAME transaction.
        const attendanceRowsCreated = await this.attendance.backfillCurrentPeriod(staff.id, trx);

        // f. Mark the request approved.
        await trx
          .updateTable('signup_requests')
          .set({
            status: 'approved',
            role_assigned: roleAssigned,
            reviewed_at: sql`NOW()`,
            reviewed_by: reviewerStaffId,
          })
          .where('id', '=', requestId)
          .execute();

        // g. Password-setup (recovery) link — best effort; failure must not
        // abort an otherwise-successful approval.
        let resetLink: string | undefined;
        try {
          const link = await this.supabaseAdmin.auth.admin.generateLink({
            type: 'recovery',
            email: row.email,
          });
          if (link?.error) {
            this.logger.warn({ err: link.error, email: row.email }, 'approve: generateLink failed');
          } else {
            resetLink = link?.data?.properties?.action_link;
          }
        } catch (err) {
          this.logger.warn({ err, email: row.email }, 'approve: generateLink threw');
        }

        // h. Notify the new staff member (recipient = the row we just created).
        await this.notifications.create({
          recipientId: staff.id,
          type: 'signup_approved',
          title: 'Your access request was approved',
          data: { resetLink },
          trx,
        });

        // i. Audit.
        await this.audit.log({
          actorId: reviewerStaffId,
          entity: 'signup_requests',
          entityId: requestId,
          action: 'UPDATE',
          after: { status: 'approved', staffId: staff.id, roleAssigned },
          trx,
        });

        return {
          kind: 'approved' as const,
          staffId: staff.id,
          supabaseUid,
          attendanceRowsCreated,
        };
      } catch (err) {
        this.logger.error(
          { err, supabaseUid, email: row.email },
          'approveSignupRequest: ORPHANED Supabase user — created but staff/backfill failed; rolled back',
        );
        throw err;
      }
    });

    if (outcome.kind === 'h04') {
      throw new AuthError('ALREADY_PROCESSED', 409, 'An account already exists for this email.');
    }
    return {
      staffId: outcome.staffId,
      supabaseUid: outcome.supabaseUid,
      attendanceRowsCreated: outcome.attendanceRowsCreated,
    };
  }

  /**
   * Admin rejects a pending signup request. Terminal: no Supabase user, no
   * staff row, no attendance. The internal `rejectionNote` is stored and
   * surfaced only in the audit log + admin views — never to the applicant.
   */
  async rejectSignupRequest(
    requestId: string,
    rejectionNote: string,
    publicRejectionMessage: string | undefined,
    reviewerStaffId: string,
  ): Promise<{ status: 'rejected' }> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('signup_requests')
        .select(['id', 'status'])
        .where('id', '=', requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) {
        throw new AuthError('NOT_FOUND', 404, 'Signup request not found.');
      }
      if (row.status !== 'pending') {
        throw new AuthError('ALREADY_REVIEWED', 409, 'This request has already been reviewed.');
      }

      await trx
        .updateTable('signup_requests')
        .set({
          status: 'rejected',
          rejection_note: rejectionNote,
          public_rejection_message: publicRejectionMessage ?? null,
          reviewed_at: sql`NOW()`,
          reviewed_by: reviewerStaffId,
        })
        .where('id', '=', requestId)
        .execute();

      // rejection_note goes into the audit trail (admins can read it); the
      // rejected applicant has no JWT and never sees the audit log.
      await this.audit.log({
        actorId: reviewerStaffId,
        entity: 'signup_requests',
        entityId: requestId,
        action: 'UPDATE',
        after: { status: 'rejected', rejectionNote, publicRejectionMessage: publicRejectionMessage ?? null },
        trx,
      });

      return { status: 'rejected' as const };
    });
  }

  /**
   * Public password-reset request. Anti-enumeration (audit M-08): both the
   * response body AND its wall-clock timing must look identical whether or not
   * the email maps to an active staff member, so an attacker can't probe which
   * addresses exist. We only actually trigger Supabase's recovery email when an
   * active, non-deleted staff row exists; the caller always sees the same 200.
   */
  async requestPasswordReset(email: string): Promise<{ status: 'sent' }> {
    const staff = await this.db
      .selectFrom('staff')
      .select(['id'])
      .where('email', '=', email)
      .where('active', '=', true)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (staff) {
      // resetPasswordForEmail tells Supabase to actually SEND the recovery email
      // (the /recover pipeline — the same SMTP that powers invites). admin.
      // generateLink only *mints* a link for custom delivery and sends nothing,
      // so using it here meant no reset email ever went out. redirectTo lands the
      // user on /reset-password with the recovery token in the URL fragment.
      //
      // Time the real send so the unmatched path below can mimic its latency.
      const startedAt = Date.now();
      const { error } = await this.supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: PASSWORD_RESET_REDIRECT_URL,
      });
      recordHitDuration(Date.now() - startedAt);
      if (error) {
        // Never surface this to the caller — doing so would both leak existence
        // and break the uniform response. Log for ops; the user can retry.
        this.logger.warn({ err: error, email }, 'requestPasswordReset: send recovery email failed');
      }
    } else {
      // No matching account: sleep for the rolling-average matched-path duration
      // (plus jitter) so response latency can't be used to enumerate accounts.
      const targetMs = Math.max(0, avgHitDurationMs() + jitterMs(TIMING_JITTER_MS));
      await new Promise((resolve) => setTimeout(resolve, targetMs));
    }

    // Audit either way — the trail records that a reset was attempted (and
    // internally whether it matched), never exposed to the requester.
    this.securityLog('password.reset_request', {
      staffId: staff?.id ?? null,
      email,
      matched: Boolean(staff),
    });

    return { status: 'sent' as const };
  }

  /**
   * Confirm a password reset. Thin wrapper: the actual password change happens
   * client-side via supabase.auth.updateUser({ password }) once the recovery
   * token has set a session. Our only job here is to record the action when a
   * caller invokes the (optional) explicit confirm endpoint.
   */
  async confirmPasswordReset(token: string, newPassword: string): Promise<{ status: 'confirmed' }> {
    void token;
    void newPassword;
    this.securityLog('password.reset_confirm', { via: 'recovery_token' });
    return { status: 'confirmed' as const };
  }

  /**
   * Exchange a refresh token for a fresh session. On any failure (expired,
   * revoked, malformed) we collapse to a single 401 — the reason is never
   * distinguished to the caller.
   */
  async refreshSession(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const { data, error } = await this.supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });
    const session = data?.session;
    if (error || !session) {
      throw new AuthError('INVALID_REFRESH_TOKEN', 401, 'Invalid or expired refresh token.');
    }
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      // Supabase returns expires_at as a unix-seconds timestamp; a valid session
      // always carries it — the ?? 0 only satisfies the optional type.
      expiresAt: session.expires_at ?? 0,
    };
  }

  /**
   * Revoke the caller's Supabase session and drop their cached staff lookup.
   *
   * auth-js 2.108.2 exposes admin.signOut(jwt, scope?) — it revokes by the
   * user's JWT, not by UID (the spec's UID-based signature predates the v2 SDK).
   * The DELETE /v1/auth/session route already holds the caller's bearer token,
   * so we pass that through; the UID is used only to evict our staff cache.
   */
  async signOut(supabaseUid: string, jwt: string): Promise<void> {
    const { error } = await this.supabaseAdmin.auth.admin.signOut(jwt);
    if (error) {
      // A failed revoke shouldn't block local sign-out; the token still expires
      // on its own. Log and continue to cache eviction.
      this.logger.warn({ err: error, supabaseUid }, 'signOut: supabase signOut failed');
    }
    await this.invalidateCache(supabaseUid);
  }

  /**
   * Begin TOTP enrollment: register a factor with Supabase, mint 10 single-use
   * recovery codes (storing only their hashes), and return the QR + secret the
   * frontend renders. mfa_enrolled stays FALSE here — it only flips once
   * verifyMfa confirms the user has a working code.
   */
  async enrollMfa(
    staffId: string,
    supabaseUid: string,
  ): Promise<{
    factorId: string;
    qrCodeDataUrl: string;
    secret: string;
    recoveryCodes: string[];
  }> {
    const adminMfa = this.adminMfa();
    if (!adminMfa?.enrollFactor) {
      // The installed admin SDK can't enroll (see MfaAdminEnrollApi). Fail with
      // a typed 501 instead of a raw TypeError so the client can fall back to
      // enrolling via its own Supabase session.
      throw new AuthError('MFA_ENROLL_UNAVAILABLE', 501, 'MFA enrollment is unavailable.');
    }
    const { data, error } = await adminMfa.enrollFactor({
      userId: supabaseUid,
      factorType: 'totp',
      friendlyName: 'Scaly Portal Authenticator',
    });
    if (error || !data?.totp) {
      throw new AuthError('MFA_ENROLL_FAILED', 502, 'Could not start MFA enrollment.');
    }

    // 10 recovery codes, ~40 bits each. They're high-entropy secrets, so an
    // unsalted SHA-256 is the right primitive (bcrypt is for low-entropy human
    // passwords). Replace any prior set so re-enrollment invalidates old codes.
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex'));
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('mfa_recovery_codes').where('staff_id', '=', staffId).execute();
      await trx
        .insertInto('mfa_recovery_codes')
        .values(codes.map((c) => ({ staff_id: staffId, code_hash: hashRecoveryCode(c) })))
        .execute();
    });

    await this.audit.log({
      actorId: staffId,
      entity: 'mfa_recovery_codes',
      action: 'INSERT',
      after: { staffId, event: 'recovery_codes_regenerated', count: codes.length },
      trx: this.db,
    });

    // Supabase returns qr_code already as a data:image/png;base64,... string.
    return {
      factorId: data.id,
      qrCodeDataUrl: data.totp.qr_code,
      secret: data.totp.secret,
      recoveryCodes: codes,
    };
  }

  /**
   * Confirm enrollment: flip staff.mfa_enrolled to true and audit. The frontend
   * has already run Supabase's challenge+verify against the user's session
   * (server-validated by Supabase). When the admin SDK exposes verifyFactor we
   * re-check server-side for defence in depth; otherwise we trust that result.
   */
  async verifyMfa(
    staffId: string,
    supabaseUid: string,
    factorId: string,
    code: string,
  ): Promise<void> {
    const adminMfa = this.adminMfa();
    if (adminMfa?.verifyFactor) {
      const { error } = await adminMfa.verifyFactor({ userId: supabaseUid, factorId, code });
      if (error) {
        throw new AuthError('MFA_VERIFY_FAILED', 400, 'Invalid verification code.');
      }
    }

    await this.db
      .updateTable('staff')
      .set({ mfa_enrolled: true })
      .where('id', '=', staffId)
      .execute();
    await this.invalidateCache(supabaseUid);

    await this.audit.log({
      actorId: staffId,
      entity: 'staff',
      entityId: staffId,
      action: 'UPDATE',
      after: { mfa_enrolled: true },
      trx: this.db,
    });
  }

  /**
   * Set a new password for the calling user via the Supabase Admin API.
   *
   * The reset-password page calls this instead of the client SDK's updateUser:
   * with "Secure password change" enabled, GoTrue demands reauthentication for a
   * client-side password change once the recovery session has been stepped up to
   * aal2 (the authenticator gate makes `totp` the most-recent auth method, which
   * consumes the recovery exemption). The service-role admin update is not
   * subject to that gate. The route restricts this to an aal2 session, so a bare
   * stolen aal1 login cannot reach it.
   */
  async updateOwnPassword(
    staffId: string,
    supabaseUid: string,
    newPassword: string,
  ): Promise<void> {
    const { error } = await this.supabaseAdmin.auth.admin.updateUserById(supabaseUid, {
      password: newPassword,
    });
    if (error) {
      throw new AuthError(
        'PASSWORD_UPDATE_FAILED',
        400,
        error.message || 'Could not update your password.',
      );
    }

    this.securityLog('password.reset_confirm', { staffId });
  }

  /**
   * Admin-only MFA reset for a user who lost their authenticator. Deletes every
   * Supabase factor, clears mfa_enrolled, drops their recovery codes, and evicts
   * the cache so the next login re-enters the /mfa-setup flow.
   */
  async resetMfa(targetStaffId: string, adminId: string): Promise<void> {
    const target = await this.db
      .selectFrom('staff')
      .select(['id', 'supabase_uid'])
      .where('id', '=', targetStaffId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!target) {
      throw new AuthError('NOT_FOUND', 404, 'Staff member not found.');
    }

    if (target.supabase_uid) {
      const adminMfa = this.supabaseAdmin.auth.admin.mfa;
      const { data, error } = await adminMfa.listFactors({ userId: target.supabase_uid });
      if (error) {
        this.logger.warn({ err: error, targetStaffId }, 'resetMfa: listFactors failed');
      } else {
        for (const factor of data?.factors ?? []) {
          const del = await adminMfa.deleteFactor({ id: factor.id, userId: target.supabase_uid });
          if (del.error) {
            this.logger.warn(
              { err: del.error, factorId: factor.id, targetStaffId },
              'resetMfa: deleteFactor failed',
            );
          }
        }
      }
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('staff')
        .set({ mfa_enrolled: false })
        .where('id', '=', targetStaffId)
        .execute();
      await trx.deleteFrom('mfa_recovery_codes').where('staff_id', '=', targetStaffId).execute();
    });

    if (target.supabase_uid) {
      await this.invalidateCache(target.supabase_uid);
    }

    await this.audit.log({
      actorId: adminId,
      entity: 'staff',
      entityId: targetStaffId,
      action: 'UPDATE',
      after: { mfa_enrolled: false, event: 'mfa_reset' },
      trx: this.db,
    });
  }

  /**
   * Resolve the admin MFA enroll/verify surface if this SDK build exposes it.
   * Returns null when absent (the 2.108.2 admin client) so callers can fall
   * back instead of hitting a TypeError. See MfaAdminEnrollApi.
   */
  private adminMfa(): MfaAdminEnrollApi | null {
    const mfa = (this.supabaseAdmin.auth.admin as unknown as { mfa?: Partial<MfaAdminEnrollApi> })
      .mfa;
    return typeof mfa?.enrollFactor === 'function' ? (mfa as MfaAdminEnrollApi) : null;
  }

  /** Evict the staff_lookup cache (best-effort; bounded by the 5-min TTL). */
  private async invalidateCache(supabaseUid: string): Promise<void> {
    try {
      await this.redis.del(staffCacheKey(supabaseUid));
    } catch (err) {
      this.logger.warn({ err, supabaseUid }, 'invalidateCache: redis del failed');
    }
  }
}

/** SHA-256 (hex) of a recovery code. High-entropy input → fast hash is fine. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Postgres unique-violation (SQLSTATE 23505), however the driver surfaces it. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
