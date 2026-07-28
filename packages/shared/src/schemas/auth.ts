/**
 * Single source of truth for every auth request/response shape.
 *
 * Both apps/api (request validation + response typing) and apps/web
 * (form validation) import from `@skaly/shared/schemas/auth`. Keep the
 * wire contract here in sync with docs/04-APPFLOW.md §2 and
 * docs/07-API-CONTRACT.md §1 — nowhere else.
 */
import { z } from 'zod';

// ─── Shared building blocks ──────────────────────────────────────────────

/** All roles in the system. Admin is the only one a user can never self-assign. */
export const RoleSchema = z.enum(['admin', 'manager', 'team_member', 'freelancer']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles a user may request for themselves (admin excluded — APPFLOW §2.6). */
const RequestableRoleSchema = z.enum(['manager', 'team_member', 'freelancer']);

/**
 * Password policy: min 10 chars with at least one lowercase, one uppercase,
 * one digit, and one special character.
 */
const PasswordSchema = z
  .string()
  .min(10)
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/,
    'Password needs an uppercase, a lowercase, a digit, and a special character',
  );

/** E.164-style international number: leading +, country code, then subscriber digits. */
const MobileNumberSchema = z
  .string()
  .regex(/^\+\d{1,3}\d{6,14}$/, '+CC format required');

// ─── Request schemas ─────────────────────────────────────────────────────

/** Body of POST /v1/auth/login (email + password). */
export const LoginEmailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
});

/**
 * Body of POST /v1/auth/invite. Email is required: every invite is scoped to a
 * specific address so admins govern exactly who can join (APPFLOW §2.7 — the
 * invite form is Name + Email + Role). There are no generic, unscoped links.
 */
export const InviteCreateSchema = z.object({
  email: z.string().email(),
  role: RoleSchema,
});

/**
 * Response of GET /v1/auth/invite/:token/check — pre-validates an invite for the
 * redemption page so it can show the scoped email/role and auto-login after
 * redeeming. Invalid tokens return the same error codes as the redeem endpoint
 * (404 NOT_FOUND / 409 ALREADY_USED / 410 EXPIRED).
 */
export const InviteCheckResponseSchema = z.object({
  email: z.string().email(),
  role: RoleSchema,
});

/** Body of POST /v1/auth/signup/invite (accepting an invite link). */
export const SignupViaInviteSchema = z.object({
  token: z.string().min(32),
  password: PasswordSchema,
  name: z.string().min(1).max(255),
  dateOfBirth: z.string().date(),
  mobileNumber: MobileNumberSchema,
});

/** Body of POST /v1/auth/signup/request (self-signup form, APPFLOW §2.6). */
export const SignupRequestSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  dateOfBirth: z.string().date(),
  mobileNumber: MobileNumberSchema,
  roleRequested: RequestableRoleSchema,
  message: z.string().max(500).optional(),
  // Set when the user arrived via the OAuth (Google) signup path A.
  googleUid: z.string().optional(),
});

/** Body of POST /v1/auth/signup-requests/:id/approve. */
export const SignupApproveSchema = z.object({
  // Admin may override the originally requested role.
  roleAssigned: RoleSchema,
});

/** Body of POST /v1/auth/signup-requests/:id/reject. */
export const SignupRejectSchema = z.object({
  // Internal note, never shown to the applicant.
  rejectionNote: z.string().min(1).max(2000),
  // Optional message surfaced to the applicant.
  publicRejectionMessage: z.string().max(300).optional(),
});

/**
 * Response of GET /v1/auth/signup-requests/me/status — the PUBLIC poll endpoint
 * a rejected/pending applicant hits. This shape is the privacy boundary: it
 * MUST never carry the internal rejection_note.
 *
 * `rejectionNote: z.never().optional()` makes a leak a compile error (the type
 * is `never`, so nothing can be assigned to it) and a runtime error (if a value
 * ever appears, schema-gated serialization rejects it rather than sending it).
 */
export const SignupStatusResponseSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  publicRejectionMessage: z.string().nullable(),
  submittedAt: z.string(),
  rejectionNote: z.never().optional(),
});

/** Body of POST /v1/auth/password/reset/request. */
export const PasswordResetRequestSchema = z.object({
  email: z.string().email(),
});

/** Body of POST /v1/auth/password/reset/confirm. */
export const PasswordResetConfirmSchema = z.object({
  token: z.string(),
  newPassword: PasswordSchema,
});

/** Body of POST /v1/auth/mfa/verify. */
export const MfaVerifySchema = z.object({
  factorId: z.string(),
  code: z.string().length(6).regex(/^\d+$/),
});

/**
 * Body of POST /v1/auth/mfa/recovery. Deliberately loose on shape — the code is
 * 10 hex characters but arrives retyped from a printed sheet, so spacing and
 * case are normalised server-side rather than rejected here. A tight regex would
 * turn "typed it with a space" into a failed attempt against the lockout budget.
 */
export const MfaRecoveryRedeemSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

// ─── Response schemas ────────────────────────────────────────────────────

/** Returned by POST /v1/auth/mfa/enroll so the frontend can render the QR. */
export const MfaEnrollResponseSchema = z.object({
  factorId: z.string(),
  qrCodeDataUrl: z.string(),
  secret: z.string(),
  recoveryCodes: z.array(z.string()).length(10),
});

/**
 * Returned by POST /v1/auth/mfa/recovery. `remainingCodes` drives the nag at
 * N ≤ 2; the caller is now unenrolled and headed for /mfa-setup.
 */
export const MfaRecoveryRedeemResponseSchema = z.object({
  remainingCodes: z.number().int().min(0),
});

/**
 * Returned by POST /v1/auth/mfa/recovery/regenerate. The ONLY time a code is
 * ever readable after enrolment, and only the freshly-minted set — there is no
 * endpoint that shows an existing one, because codes readable from a live
 * session are not a second factor.
 */
export const MfaRecoveryRegenerateResponseSchema = z.object({
  recoveryCodes: z.array(z.string()).length(10),
});

/** Returned by GET /v1/auth/mfa/recovery — the count only, never the codes. */
export const MfaRecoveryStatusResponseSchema = z.object({
  remainingCodes: z.number().int().min(0),
});

/**
 * One row of GET /v1/settings/signup-requests — the ADMIN list view. Unlike the
 * applicant's public status poll, this intentionally carries `rejectionNote`:
 * it's the admin's own internal note, visible only here (privacy boundary lives
 * on the applicant endpoint, not this one).
 */
export const SignupRequestAdminItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  dateOfBirth: z.string().nullable(),
  mobileNumber: z.string(),
  roleRequested: RequestableRoleSchema,
  message: z.string().nullable(),
  cvFileKey: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  rejectionNote: z.string().nullable(),
  publicRejectionMessage: z.string().nullable(),
});

/** Returned by the session-refresh endpoint. */
export const SessionRefreshResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

/**
 * Shape of GET /v1/staff/me (C-04 reference handler). The full own-profile
 * (identical fields to GET /v1/staff/:id) PLUS the effective permission map the
 * frontend gates UI on.
 */
export const StaffMeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: RoleSchema,
  dateOfBirth: z.string().nullable(),
  mobileNumber: z.string().nullable(),
  cvFileKey: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  active: z.boolean(),
  mfaEnrolled: z.boolean(),
  createdAt: z.string(),
  permissions: z.record(z.string(), z.boolean()),
});

// ─── Inferred TypeScript types ───────────────────────────────────────────

export type LoginEmailInput = z.infer<typeof LoginEmailSchema>;
export type InviteCreateInput = z.infer<typeof InviteCreateSchema>;
export type SignupViaInviteInput = z.infer<typeof SignupViaInviteSchema>;
export type InviteCheckResponse = z.infer<typeof InviteCheckResponseSchema>;
export type SignupRequestInput = z.infer<typeof SignupRequestSchema>;
export type SignupApproveInput = z.infer<typeof SignupApproveSchema>;
export type SignupRejectInput = z.infer<typeof SignupRejectSchema>;
export type PasswordResetRequestInput = z.infer<typeof PasswordResetRequestSchema>;
export type PasswordResetConfirmInput = z.infer<typeof PasswordResetConfirmSchema>;
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;

export type SignupRequestAdminItem = z.infer<typeof SignupRequestAdminItemSchema>;
export type MfaEnrollResponse = z.infer<typeof MfaEnrollResponseSchema>;
export type MfaRecoveryRedeemInput = z.infer<typeof MfaRecoveryRedeemSchema>;
export type MfaRecoveryRedeemResponse = z.infer<typeof MfaRecoveryRedeemResponseSchema>;
export type MfaRecoveryRegenerateResponse = z.infer<typeof MfaRecoveryRegenerateResponseSchema>;
export type MfaRecoveryStatusResponse = z.infer<typeof MfaRecoveryStatusResponseSchema>;
export type SessionRefreshResponse = z.infer<typeof SessionRefreshResponseSchema>;
export type StaffMeResponse = z.infer<typeof StaffMeResponseSchema>;
export type SignupStatusResponse = z.infer<typeof SignupStatusResponseSchema>;
