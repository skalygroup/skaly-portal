// @vitest-environment node
// Logic test: authErrorMessage names the unreachable-auth-host case instead of
// folding it into the generic fallback. That fold is what made a dead Supabase
// project look like "Something went wrong. Try again." on every retry.
import { describe, expect, it } from 'vitest';

import { authErrorMessage } from '@/lib/auth-errors';

/** auth-js sets the class name; the message is a bare "Failed to fetch". */
function retryableFetchError() {
  const err = new Error('Failed to fetch');
  err.name = 'AuthRetryableFetchError';
  return err;
}

describe('authErrorMessage', () => {
  it('AuthRetryableFetchError → says the sign-in service is unreachable', () => {
    expect(authErrorMessage(retryableFetchError())).toMatch(/cannot reach the sign-in service/i);
  });

  it('a bare "Failed to fetch" TypeError → same unreachable message', () => {
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toMatch(
      /cannot reach the sign-in service/i,
    );
  });

  it("Safari's 'Load failed' wording → same unreachable message", () => {
    expect(authErrorMessage(new TypeError('Load failed'))).toMatch(
      /cannot reach the sign-in service/i,
    );
  });

  it('our ApiError NETWORK_ERROR → says the server is unreachable', () => {
    const err = Object.assign(new Error('Cannot reach the server.'), { code: 'NETWORK_ERROR' });
    expect(authErrorMessage(err)).toMatch(/cannot reach the server/i);
  });

  it('bad credentials keep their own copy, not the network copy', () => {
    const err = new Error('Invalid login credentials');
    expect(authErrorMessage(err)).toBe('Email or password is incorrect.');
  });

  it('unconfirmed email keeps its own copy', () => {
    expect(authErrorMessage(new Error('Email not confirmed'))).toMatch(/confirm your email/i);
  });

  it('anything else → the caller-supplied fallback', () => {
    expect(authErrorMessage(new Error('boom'), 'Custom fallback.')).toBe('Custom fallback.');
    expect(authErrorMessage(null)).toBe('Something went wrong. Try again.');
  });

  // mfa-challenge leans on this: listFactors() returns a null error when the
  // call succeeded but no TOTP factor exists, and that must stay the caller's
  // own "no authenticator" copy rather than a network message.
  it('a null error → the caller\x27s fallback, untouched', () => {
    expect(authErrorMessage(null, 'No authenticator on this account.')).toBe(
      'No authenticator on this account.',
    );
  });
});
