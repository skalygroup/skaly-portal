import Anthropic from '@anthropic-ai/sdk';

import { requireAnthropicKey } from './env.js';

/**
 * ONE Anthropic client for the whole app (mirrors lib/r2.ts's single-client
 * precedent). Built lazily so requireAnthropicKey()'s throw doesn't fire at
 * import time on processes that never invoke the bot.
 *
 * Retry — DELIBERATE DIVERGENCE from THIRD-PARTY §3.4's hand-rolled
 * callWithRetry (recorded there): we use the SDK's built-in exponential backoff
 * (`maxRetries: 3`), which respects the Retry-After header on 429/529 and is
 * better tested than a hand loop. Caveat the SDK cannot cover: retries apply to
 * CALL ESTABLISHMENT only. Once BotService has emitted bot:token deltas, a
 * mid-stream failure is NOT retryable (a restart would duplicate text) — the
 * service finalizes gracefully with the partial text + the friendly error, it
 * does not restart the stream.
 */
let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (client) return client;
  client = new Anthropic({ apiKey: requireAnthropicKey(), maxRetries: 3 });
  return client;
}
