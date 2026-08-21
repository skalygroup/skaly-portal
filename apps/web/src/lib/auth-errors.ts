/**
 * One place that turns a Supabase auth failure into copy the user can act on —
 * the auth-page counterpart to mutation-errors.ts.
 *
 * The case that matters is the one auth-js reports as a bare "Failed to fetch":
 * the auth host never answered. A paused or deleted project, a DNS record that
 * no longer resolves, an offline laptop and a blocked request are indistinguish-
 * able from the browser, and every auth page used to fold all of them into
 * "Something went wrong. Try again." — which sends the user to retry the one
 * thing that cannot succeed, with no hint that the service is the problem.
 * Naming it costs one branch and saves the next person the DNS lookup.
 */
/**
 * Did this auth call fail in transit, rather than come back with a verdict?
 *
 * Its own predicate because the EDGE MIDDLEWARE needs the same question answered
 * and must not guess differently: getUser() reports "the auth host never
 * answered" and "you have no session" identically as `user === null`, and
 * treating the first as the second logs out a valid session. One definition, so
 * the page copy and the redirect decision can never drift apart.
 */
export function isAuthTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  // auth-js wraps every transport failure as AuthRetryableFetchError. The raw
  // TypeError shapes are here too for the paths that call fetch directly.
  return (
    (err instanceof Error && err.name === 'AuthRetryableFetchError') ||
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Load failed') // Safari's wording for the same failure
  );
}

export function authErrorMessage(
  err: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  const message = err instanceof Error ? err.message : '';

  // Our own ApiError for a request that never reached the API (api.ts). Matched
  // by shape rather than instanceof: importing ApiError here would pull the
  // browser Supabase client in at module load, which this helper does not need.
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NETWORK_ERROR') {
    return 'Cannot reach the server. Check your connection and try again.';
  }

  if (isAuthTransportError(err)) {
    return typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'You appear to be offline. Reconnect and try again.'
      : 'Cannot reach the sign-in service. Check your connection — if this keeps happening, contact your admin.';
  }

  if (message.includes('Invalid login credentials')) return 'Email or password is incorrect.';
  if (message.includes('Email not confirmed')) {
    return 'Please confirm your email before logging in.';
  }

  return fallback;
}
