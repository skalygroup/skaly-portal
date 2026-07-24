import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP, computed with node:crypto — no dependency for ~30 lines. The
 * MFA E2E reads the base32 secret shown on /mfa-setup and drives the 6-digit
 * code from it, exactly as an authenticator app would. Verified against the RFC
 * 6238 Appendix B test vector in totp.test.ts.
 */

/** RFC 4648 base32 decode (Supabase TOTP secrets are unpadded base32). */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 6-digit SHA-1 TOTP with a 30s step for a base32 secret at the given time. */
export function totp(secretBase32: string, forTimeMs: number = Date.now()): string {
  const key = base32Decode(secretBase32);
  let counter = Math.floor(forTimeMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}
