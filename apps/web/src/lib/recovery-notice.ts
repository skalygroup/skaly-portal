/**
 * The one-shot notice carried from the recovery-code redeem (/mfa-challenge)
 * to the enrolment screen it lands on (/mfa-setup).
 *
 * `sessionStorage`, not a query param or a store: the count must survive one
 * client navigation and nothing more. A query param would put it in history and
 * in any copied link; a store would need a provider above both pages, which are
 * in the same route group but not the same tree state.
 */
const KEY = 'skaly.recovery-redeemed';

export function setRecoveryNotice(remainingCodes: number): void {
  try {
    sessionStorage.setItem(KEY, String(remainingCodes));
  } catch {
    // Private mode / storage disabled — the banner is a courtesy, not a gate.
  }
}

/** Read AND clear, so a refresh of /mfa-setup doesn't re-announce it. */
export function takeRecoveryNotice(): number | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(KEY);
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
