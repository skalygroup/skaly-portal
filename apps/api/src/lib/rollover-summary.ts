/**
 * The rollover-failure incident summary (Error-Handling §7, ADR-036 §3).
 *
 * ⭐ THE ONLY CONTRACT THIS FILE HAS: it never throws, and it never blocks the
 * notification. It returns a summary, or it returns null. The caller has ALREADY
 * written a complete, correct, templated failure notification before calling —
 * this is enrichment, and enrichment that could take the incident report down
 * with it would invert the entire point of ADR-036.
 *
 * RETRY: the SDK's, not ours (`lib/anthropic.ts`, `maxRetries: 3`, respects
 * Retry-After — the Sprint 8 amendment). There is no loop here on purpose. The
 * cron already retries the endpoint 3× (Infra §4); a hand loop would make that
 * 9 API calls and 3 incident notifications for one bad night.
 */
import { getAnthropic } from './anthropic.js';
import { env } from './env.js';

import type { JobLogger } from '../jobs/job-logger.js';

/** Verbatim from Error-Handling §7. */
const SYSTEM_PROMPT = `Write a calm, plain-language incident summary for a non-technical business owner.
           Explain: what happened, whether any data was affected, and what they should do next.
           No technical jargon. 3-5 sentences maximum.`;

export interface RolloverFailureContext {
  period: string;
  failedStep: string;
  error: unknown;
  /** Which of the cron's 3 attempts this was, when the caller knows. Defaults to 3 (the last). */
  attempt?: number;
}

/**
 * A 3–5 sentence plain-language summary, or `null` if the API could not produce
 * one — including a missing API key, an exhausted retry budget, or a response
 * that arrived with no text block.
 */
export async function summariseRolloverFailure(
  ctx: RolloverFailureContext,
  logger?: JobLogger,
): Promise<string | null> {
  const { period, failedStep, error, attempt = 3 } = ctx;
  const message = error instanceof Error ? error.message : String(error);

  try {
    // Same prod-Sonnet / dev-Haiku split the bot uses (TRD §9) — an incident
    // summary in a test run should not cost Sonnet money.
    const model = env.NODE_ENV === 'production' ? env.ANTHROPIC_MODEL_PROD : env.ANTHROPIC_MODEL_DEV;

    const { content } = await getAnthropic().messages.create({
      model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Rollover for period ${period} failed at step "${failedStep}".
              Error: ${message}. Attempt ${attempt} of 3.`,
        },
      ],
    });

    // A response with no text block is a failure for our purposes — returning ''
    // would blank a notification body that currently reads correctly.
    const text = content
      .filter((b): b is { type: 'text'; text: string; citations: never } => b.type === 'text')
      .map((b) => b.text.trim())
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    // Swallowed, by design and by ADR. The admin already has the templated body.
    logger?.error({ err, period, failedStep }, 'rollover failure summary unavailable — templated body stands');
    return null;
  }
}
