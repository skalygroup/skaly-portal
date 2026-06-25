import type { SignupRequestInput } from '@skaly/shared/schemas/auth';

/**
 * Client-side helpers shared by the self-signup (PATH B) and OAuth-complete
 * (PATH A) forms — both POST the same multipart body to
 * /v1/auth/signup/request (APPFLOW §2.6).
 */

export const CV_MAX_BYTES = 5 * 1024 * 1024; // 5 MB (matches the API multipart limit)

/** Accepted CV types — PDF / DOC / DOCX. */
const CV_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const CV_EXT = /\.(pdf|docx?|DOCX?|PDF)$/;

export const CV_ACCEPT =
  '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Validate a CV before upload. Returns an inline error string, or null if OK.
 * Some browsers report an empty MIME for .docx, so we fall back to the
 * extension.
 */
export function validateCvFile(file: File): string | null {
  const typeOk = CV_MIME.has(file.type) || CV_EXT.test(file.name);
  if (!typeOk) return 'CV must be a PDF, DOC, or DOCX file.';
  if (file.size > CV_MAX_BYTES) return 'CV must be 5 MB or smaller.';
  return null;
}

/** Roles a user may request for themselves — admin is excluded (APPFLOW §2.6). */
export const ROLE_OPTIONS: { value: SignupRequestInput['roleRequested']; label: string }[] = [
  { value: 'team_member', label: 'Team member' },
  { value: 'manager', label: 'Manager' },
  { value: 'freelancer', label: 'Freelancer' },
];

/**
 * Build the multipart body. Text fields go first (the API parses them before
 * the file part), then the optional CV. `googleUid` is set on the OAuth path.
 */
export function buildSignupFormData(values: SignupRequestInput, cv?: File | null): FormData {
  const fd = new FormData();
  fd.append('name', values.name);
  fd.append('email', values.email);
  fd.append('dateOfBirth', values.dateOfBirth);
  fd.append('mobileNumber', values.mobileNumber);
  fd.append('roleRequested', values.roleRequested);
  if (values.message) fd.append('message', values.message);
  if (values.googleUid) fd.append('googleUid', values.googleUid);
  // File MUST be appended last — the API validates text fields before reading
  // the stream.
  if (cv) fd.append('cv', cv, cv.name);
  return fd;
}
