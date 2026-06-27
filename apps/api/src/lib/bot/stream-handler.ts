/**
 * Canonical streaming bridge from Anthropic to Socket.io.
 * This file is REFERENCE — Sprint 8 wires it to /v1/bot/message.
 * Do not modify the architecture without updating docs/14-PRE-BUILD-AUDIT.md H-04.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Server } from 'socket.io';

export interface HandleBotStreamArgs {
  staffId: string;
  sessionMessages: Anthropic.MessageParam[];
  filteredTools: Anthropic.Tool[];
  io: Server;
  redisClient: Redis;
  redisSessionKey: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB schema types generated in Sprint 8; `any` until then
  db: Kysely<any>;
  anthropic: Anthropic;
  model: string;
}

// Stub function to be implemented in Sprint 8
async function executeToolCall(staffId: string, toolBlock: Anthropic.ToolUseBlock) {
  return { executed: true, tool: toolBlock.name };
}

export async function handleBotStream({
  staffId,
  sessionMessages,
  filteredTools,
  io,
  redisClient,
  redisSessionKey,
  db,
  anthropic,
  model,
}: HandleBotStreamArgs): Promise<void> {
  try {
    let fullResponseText = '';

    // ── Phase 1: First Anthropic streaming call ──────────────────────────────
    const firstStream = anthropic.messages.stream({
      model,
      max_tokens: 1024,
      tools: filteredTools.length > 0 ? filteredTools : undefined,
      messages: sessionMessages,
    });

    firstStream.on('text', (token) => {
      fullResponseText += token;
      io.to('user:' + staffId).emit('bot:message', { chunk: token, done: false });
    });

    const firstResponse = await firstStream.finalMessage();

    // ── Phase 2: Tool block detection ────────────────────────────────────────
    const toolBlocks = firstResponse.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    const updatedHistory: Anthropic.MessageParam[] = [
      ...sessionMessages,
      { role: 'assistant', content: firstResponse.content },
    ];

    if (toolBlocks.length === 0) {
      // No tools used, response is complete
      io.to('user:' + staffId).emit('bot:message', {
        chunk: '',
        done: true,
        toolsUsed: [],
        card: null,
      });
    } else {
      // Tools used: execute them and perform second call
      io.to('user:' + staffId).emit('bot:message', {
        chunk: '',
        done: false,
        status: 'running_tools',
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      const toolsUsed: string[] = [];

      for (const block of toolBlocks) {
        toolsUsed.push(block.name);
        const result = await executeToolCall(staffId, block);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // ── Phase 3: Second Anthropic call ─────────────────────────────────────
      updatedHistory.push({ role: 'user', content: toolResults });

      const secondStream = anthropic.messages.stream({
        model,
        max_tokens: 1024,
        tools: filteredTools,
        messages: updatedHistory,
      });

      secondStream.on('text', (token) => {
        fullResponseText += token;
        io.to('user:' + staffId).emit('bot:message', { chunk: token, done: false });
      });

      const secondResponse = await secondStream.finalMessage();
      updatedHistory.push({ role: 'assistant', content: secondResponse.content });

      io.to('user:' + staffId).emit('bot:message', {
        chunk: '',
        done: true,
        toolsUsed,
        card: null,
      });
    }

    // ── Phase 4: Save updated history to Redis ───────────────────────────────
    // Keep only the last 100 items (50 user + 50 assistant)
    const historyToSave = updatedHistory.slice(-100);
    await redisClient.setex(redisSessionKey, 43200, JSON.stringify(historyToSave)); // 12h TTL

    // ── Phase 5: Archive messages row ────────────────────────────────────────
    await db
      .insertInto('messages')
      .values({
        channel: 'bot',
        sender_id: staffId,
        sender_type: 'user',
        content: fullResponseText,
        content_type: 'text',
      })
      .execute();
  } catch (error) {
    io.to('user:' + staffId).emit('bot:message', {
      chunk: '',
      done: true,
      error: 'Something went wrong. Please try again.',
    });
    throw error;
  }
}
