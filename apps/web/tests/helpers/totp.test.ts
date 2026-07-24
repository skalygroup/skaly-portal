// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { totp } from './totp';

// RFC 6238 Appendix B (SHA-1) test vector: the ASCII secret "12345678901234567890"
// is base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ". At T=59s the 8-digit TOTP is
// 94287082, so the 6-digit code is its last six digits, 287082.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('matches the RFC 6238 Appendix B vector (t=59s → 287082)', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('changes across a 30s step boundary and is a 6-digit string', () => {
    const a = totp(RFC_SECRET, 0);
    const b = totp(RFC_SECRET, 30_000);
    expect(a).toMatch(/^\d{6}$/);
    expect(b).toMatch(/^\d{6}$/);
    expect(a).not.toBe(b);
  });
});
