import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import MfaSetupPage from './page';

import { api, ApiError } from '@/lib/api';

/**
 * MFA enrollment → recovery codes (ADR-031).
 *
 * ⚠️ THE FLOW UNDER TEST CANNOT BE EXERCISED LOCALLY. `POST /v1/auth/mfa/enroll`
 * 501s against local Supabase, which cannot issue a TOTP factor, so the fallback
 * branch is the ONLY one a developer ever sees by hand. That is a reason to mock
 * both branches here, not a reason to leave the path uncovered — the hole this
 * closes lives specifically in the branch nobody could see.
 *
 * The assertion that matters is the second one: enrollment that mints no codes
 * must still leave the user holding codes before they reach the portal.
 */
const apiMock = vi.mocked(api);
const push = vi.fn();

const mfa = {
  enroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/recovery-notice', () => ({ takeRecoveryNotice: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { mfa } }) }));

/**
 * A plain input in place of the OTP widget. This file is about what happens
 * AFTER six correct digits; the widget's own keyboard behaviour is the library's
 * problem and would only add jsdom flake to an assertion that isn't about it.
 */
vi.mock('@/components/ui/input-otp', () => ({
  InputOTP: ({
    value,
    onChange,
    maxLength,
  }: {
    value: string;
    onChange: (v: string) => void;
    maxLength: number;
  }) => (
    <input
      aria-label="6-digit verification code"
      maxLength={maxLength}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
}));

const CODES = Array.from({ length: 10 }, (_, i) => `code-${i}`);

/** The server-side enroll, which mints its own codes. */
const ENROLLED = {
  factorId: 'factor-1',
  qrCodeDataUrl: 'data:image/png;base64,AAA',
  secret: 'SECRET123',
  recoveryCodes: CODES,
};

beforeEach(() => {
  vi.clearAllMocks();
  mfa.challenge.mockResolvedValue({ data: { id: 'chal-1' }, error: null });
  mfa.verify.mockResolvedValue({ error: null });
});
afterEach(cleanup);

/** Drive the page to the moment the factor has verified. */
async function enrolAndVerify() {
  render(<MfaSetupPage />);
  const otp = await screen.findByLabelText('6-digit verification code');
  await userEvent.type(otp, '123456');
}

describe('⭐ recovery codes are issued at enrollment, not on a Profile visit', () => {
  test('the server-enroll path shows its codes and gates Continue behind the acknowledgment', async () => {
    apiMock.mockImplementation((path: string) =>
      path === '/v1/auth/mfa/enroll' ? Promise.resolve(ENROLLED) : Promise.resolve(undefined),
    );

    await enrolAndVerify();

    expect(await screen.findByText('code-0')).toBeTruthy();
    const cont = screen.getByRole('button', { name: /continue to portal/i });
    // The gate is the point: codes shown once, behind a deliberate acknowledgment.
    expect(cont.hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(cont.hasAttribute('disabled')).toBe(false);
    await userEvent.click(cont);
    expect(push).toHaveBeenCalledWith('/');
  });

  test('⭐ the 501 fallback mints codes after verify — it must not finish empty-handed', async () => {
    apiMock.mockImplementation((path: string) => {
      // Local Supabase (and any admin SDK without enrollFactor) answers this way.
      if (path === '/v1/auth/mfa/enroll') return Promise.reject(new ApiError(501, 'MFA_ENROLL_UNAVAILABLE'));
      if (path === '/v1/auth/mfa/recovery/regenerate') return Promise.resolve({ recoveryCodes: CODES });
      return Promise.resolve(undefined);
    });
    mfa.enroll.mockResolvedValue({
      data: { id: 'factor-1', totp: { qr_code: 'data:image/png;base64,AAA', secret: 'S' } },
      error: null,
    });

    await enrolAndVerify();

    // ORDER IS THE ASSERTION. Codes are minted only once the factor has verified —
    // regenerating for an enrollment that then fails would replace a working set
    // with one for a factor nobody holds.
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/v1/auth/mfa/recovery/regenerate', { method: 'POST' }));
    const paths = apiMock.mock.calls.map(([p]) => p);
    expect(paths.indexOf('/v1/auth/mfa/verify')).toBeLessThan(
      paths.indexOf('/v1/auth/mfa/recovery/regenerate'),
    );

    expect(await screen.findByText('code-0')).toBeTruthy();
    // And the same gate applies — this path used to sail straight through with an
    // enabled button and no codes at all.
    expect(screen.getByRole('button', { name: /continue to portal/i }).hasAttribute('disabled')).toBe(true);
  });

  test('a failed mint is a dead end for nobody — Continue works and Profile is named', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === '/v1/auth/mfa/enroll') return Promise.reject(new ApiError(501, 'MFA_ENROLL_UNAVAILABLE'));
      if (path === '/v1/auth/mfa/recovery/regenerate') return Promise.reject(new ApiError(403, 'MFA_REQUIRED'));
      return Promise.resolve(undefined);
    });
    mfa.enroll.mockResolvedValue({
      data: { id: 'factor-1', totp: { qr_code: 'data:image/png;base64,AAA', secret: 'S' } },
      error: null,
    });

    await enrolAndVerify();

    // MFA really is on, so refusing to let them in would be worse than the missing
    // codes — but the remedy has to be one they can perform themselves.
    expect(await screen.findByText(/Profile → Recovery codes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /continue to portal/i }).hasAttribute('disabled')).toBe(false);
  });
});
