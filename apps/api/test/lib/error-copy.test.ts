import { describe, test, expect } from 'vitest';

import {
  BOT_CYCLE_ERROR_COPY,
  BOT_ERROR_CODES,
  BOT_GENERIC_ERROR_COPY,
  botErrorCopy,
} from '../../src/lib/bot/error-copy.js';
import { capabilityPhrases, ALL_TOOLS, MUTATION_TOOLS } from '../../src/lib/bot/tools/registry.js';
import { FAMILY_PHRASES } from '../../src/lib/bot/tools/types.js';
import { BotService } from '../../src/services/BotService.js';

import type Anthropic from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';

/**
 * Bot copy (Sprint 9 STEP 6, Error-Handling §6, audit M-08).
 *
 * Two things are under test and they are the same rule from different ends: the
 * user is a person, not a debugger, and the model must not be handed so much
 * refusal surface that it starts refusing things the user can do.
 */
const svc = (): BotService =>
  new BotService({} as Anthropic, {} as Redis, { of: () => ({ to: () => ({ emit: () => {} }) }) } as unknown as Server);

/** Everything a user must never read in bot copy. */
const FORBIDDEN = [
  /\b(admin|manager|team.member|freelancer)\b/i, // role names (APPFLOW §9)
  /\bversion\b/i, // our concurrency model
  /\b[A-Z][A-Z_]{4,}\b/, // SCREAMING_CASE error codes
  /\b(4\d\d|5\d\d)\b/, // HTTP statuses
  /\bbot\.tool\./, // permission keys
];

/** Copy is allowed to say "ask an admin" — that is the remedy, not a statement of
 *  what role is required. Strip that clause before the role check. */
const stripRemedy = (s: string): string => s.replace(/Ask an admin[^.]*\./g, '');

describe('the error→copy table', () => {
  test('every mapped code produces copy, and none of it leaks internals', () => {
    for (const code of BOT_ERROR_CODES) {
      const copy = botErrorCopy({ code }, { month: 'July 2026', action: 'mark task as done', dependency: 'Shoot the reel', updatedBy: 'Priya' });
      expect(copy, code).toBeTruthy();
      expect(copy, code).not.toBe(BOT_GENERIC_ERROR_COPY);
      for (const pattern of FORBIDDEN) {
        expect(stripRemedy(copy), `${code} matched ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  test('an unmapped code falls to the generic line rather than showing raw text', () => {
    // Not a gap: a code we have never seen must not have its message shown.
    expect(botErrorCopy({ code: 'SOMETHING_NEW', message: 'pg: relation does not exist' })).toBe(
      BOT_GENERIC_ERROR_COPY,
    );
    expect(botErrorCopy(null)).toBe(BOT_GENERIC_ERROR_COPY);
    expect(botErrorCopy(new Error('boom'))).toBe(BOT_GENERIC_ERROR_COPY);
  });

  test('STALE_DATA offers recovery and names who moved the record', () => {
    // Newly reachable BECAUSE ADR-014 captures the version. The user did nothing
    // wrong here, so the copy must not dead-end.
    const copy = botErrorCopy({ code: 'STALE_DATA' }, { updatedBy: 'Priya' });
    expect(copy).toContain('Priya');
    expect(copy).toMatch(/try again/i);
    expect(copy).not.toMatch(/version|409|conflict/i);
  });

  test('STALE_DATA still reads cleanly when nobody is named', () => {
    const copy = botErrorCopy({ code: 'STALE_DATA' }, {});
    expect(copy).not.toContain('undefined');
    expect(copy).toMatch(/try again/i);
  });

  test('a dependency cycle gets its own sentence, not "some details were invalid"', () => {
    const cycle = botErrorCopy({ code: 'VALIDATION_ERROR', message: 'Dependency cycle detected' });
    expect(cycle).toBe(BOT_CYCLE_ERROR_COPY);
    expect(cycle).toMatch(/loop/i);

    // A plain validation error keeps the generic-validation sentence.
    const plain = botErrorCopy({ code: 'VALIDATION_ERROR', message: 'note exceeds 500 characters.' });
    expect(plain).not.toBe(BOT_CYCLE_ERROR_COPY);
  });

  test('interpolation degrades gracefully when context is missing', () => {
    for (const code of BOT_ERROR_CODES) {
      expect(botErrorCopy({ code }, {}), code).not.toContain('undefined');
    }
  });
});

describe('the denial block, re-tuned for 22 tools', () => {
  test('every tool declares a family, and every family has a phrase', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.family, tool.name).toBeTruthy();
      expect(FAMILY_PHRASES[tool.family], `${tool.name} → ${tool.family}`).toBeTruthy();
    }
  });

  test("a team_member's 13 denied tools collapse to a handful of phrases", () => {
    // The actual team_member denial set off ROLE_DEFAULTS.
    const denied = [
      'get_content_pipeline',
      'get_audit_log',
      'get_client_summary',
      'update_task_status',
      'create_task',
      'assign_task',
      'set_deadline',
      'update_pipeline_stage',
      'update_shoot_slot',
      'update_calendar_cell',
      'add_holiday',
      'remove_holiday',
      'add_client',
      'deactivate_client',
    ];
    const phrases = capabilityPhrases(denied);

    expect(denied.length).toBe(14);
    // Grouped, not enumerated — this is the whole re-tune. 14 tools → 9 phrases.
    // (The guide predicted ~6; that assumed a smaller denial set. 9 is the honest
    // number for this one, and the reduction that matters is 14 → 9 — four
    // task-write tools becoming a single line.)
    expect(phrases).toHaveLength(9);
    expect(phrases).toContain('creating, assigning, or scheduling tasks');
    expect(phrases).toContain('adding or removing holidays');
    expect(phrases).toContain('adding or deactivating clients');
    // No duplicates: four denied task-write tools yield ONE phrase.
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  test('phrase order is stable, so the prompt prefix stays cacheable', () => {
    const a = capabilityPhrases(['add_client', 'create_task', 'add_holiday']);
    const b = capabilityPhrases(['add_holiday', 'add_client', 'create_task']);
    expect(a).toEqual(b);
  });

  test('an unknown tool name is dropped, never echoed into the prompt', () => {
    // A raw tool name in the prompt would leak the internal tool surface.
    expect(capabilityPhrases(['not_a_real_tool'])).toEqual([]);
  });

  test('the TOOL ACCESS section names families, never raw tool names, and stays small', () => {
    const denied = MUTATION_TOOLS.map((t) => t.name);
    const prompt = svc().buildSystemPrompt('Rahul', 'team_member', denied);

    const section = prompt.slice(prompt.indexOf('TOOL ACCESS'));
    expect(section).toBeTruthy();

    // No raw tool name anywhere in the prompt.
    for (const tool of ALL_TOOLS) {
      expect(prompt, tool.name).not.toContain(tool.name);
    }
    // 8.1 budgeted ~120 tokens for ~10 phrases; grouping must keep it in that range
    // rather than growing with the tool count. ~4 chars/token.
    expect(section.length).toBeLessThan(1200);
  });

  test('an admin with nothing denied still gets NO TOOL ACCESS section (8.1 rule)', () => {
    const prompt = svc().buildSystemPrompt('Arslaan', 'admin', []);
    expect(prompt).not.toContain('TOOL ACCESS');
  });

  test("8.1's verbatim refusal sentence and its constraints are unchanged", () => {
    const prompt = svc().buildSystemPrompt('Rahul', 'team_member', ['add_client']);
    expect(prompt).toContain(
      "I don't have permission to [action] on your behalf. Ask an admin to update your bot access settings.",
    );
    expect(prompt).toContain('Never state which role or permission level is required.');
    // The out-of-scope paragraph — without it the bot answers "what's the weather?"
    // with a permission refusal.
    expect(prompt).toContain('portal does not cover at all');
  });

  test('the system prompt tells the model to look ids up rather than guess', () => {
    const prompt = svc().buildSystemPrompt('Rahul', 'admin', []);
    expect(prompt).toContain('Never guess an id.');
  });
});
