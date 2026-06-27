import { describe, test, expect, vi, beforeEach } from 'vitest';

import { handleBotStream } from '../../../src/lib/bot/stream-handler.js';

// Mock dependencies
const mockIoEmit = vi.fn();
const mockIoTo = vi.fn(() => ({ emit: mockIoEmit }));
const mockIo = { to: mockIoTo } as any;

const mockRedisSetex = vi.fn();
const mockRedis = { setex: mockRedisSetex } as any;

const mockDbExecute = vi.fn();
const mockDbValues = vi.fn(() => ({ execute: mockDbExecute }));
const mockDbInsertInto = vi.fn(() => ({ values: mockDbValues }));
const mockDb = { insertInto: mockDbInsertInto } as any;

// Helper to create a mock Anthropic stream
function createMockStream(textTokens: string[], finalContent: any[]) {
  const stream = {
    on: vi.fn((event: string, cb: (token: string) => void) => {
      if (event === 'text') {
        textTokens.forEach(cb);
      }
      return stream;
    }),
    finalMessage: vi.fn().mockResolvedValue({ content: finalContent }),
  };
  return stream;
}

describe('stream-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('With no tools: emits bot:message done: true once, archives one messages row', async () => {
    const mockAnthropic = {
      messages: {
        stream: vi.fn().mockReturnValue(createMockStream(['Hello', ' world'], [{ type: 'text', text: 'Hello world' }])),
      },
    } as any;

    await handleBotStream({
      staffId: 'staff-1',
      sessionMessages: [{ role: 'user', content: 'Hi' }],
      filteredTools: [],
      io: mockIo,
      redisClient: mockRedis,
      redisSessionKey: 'bot:session:staff-1',
      db: mockDb,
      anthropic: mockAnthropic,
      model: 'claude-3-haiku-20240307',
    });

    // Emits text tokens
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: 'Hello', done: false });
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: ' world', done: false });

    // Emits done: true without tools
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: '', done: true, toolsUsed: [], card: null });

    // Saves to DB
    expect(mockDbInsertInto).toHaveBeenCalledWith('messages');
    expect(mockDbValues).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Hello world',
        channel: 'bot',
      })
    );

    // Saves to Redis
    expect(mockRedisSetex).toHaveBeenCalledWith('bot:session:staff-1', 43200, expect.any(String));
  });

  test('With tools: emits running_tools status, runs second call, archives one messages row', async () => {
    const mockFirstStream = createMockStream(['Let ', 'me check'], [
      { type: 'text', text: 'Let me check' },
      { type: 'tool_use', id: 'tool_1', name: 'search_tasks', input: {} }
    ]);
    const mockSecondStream = createMockStream(['Found ', 'it'], [{ type: 'text', text: 'Found it' }]);

    const mockAnthropic = {
      messages: {
        stream: vi.fn()
          .mockReturnValueOnce(mockFirstStream)
          .mockReturnValueOnce(mockSecondStream),
      },
    } as any;

    await handleBotStream({
      staffId: 'staff-2',
      sessionMessages: [{ role: 'user', content: 'Find tasks' }],
      filteredTools: [{ name: 'search_tasks', description: 'Search', input_schema: { type: 'object', properties: {} } }],
      io: mockIo,
      redisClient: mockRedis,
      redisSessionKey: 'bot:session:staff-2',
      db: mockDb,
      anthropic: mockAnthropic,
      model: 'claude-3-haiku-20240307',
    });

    // Emits first pass tokens
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: 'Let ', done: false });

    // Emits running tools status
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: '', done: false, status: 'running_tools' });

    // Emits second pass tokens
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: 'Found ', done: false });

    // Emits done: true with tools used
    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', { chunk: '', done: true, toolsUsed: ['search_tasks'], card: null });

    // Saves combined content to DB
    expect(mockDbValues).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Let me checkFound it',
      })
    );
  });

  test('On error: emits error event, re-throws', async () => {
    const mockAnthropic = {
      messages: {
        stream: vi.fn().mockImplementation(() => {
          throw new Error('Anthropic API failed');
        }),
      },
    } as any;

    await expect(
      handleBotStream({
        staffId: 'staff-3',
        sessionMessages: [],
        filteredTools: [],
        io: mockIo,
        redisClient: mockRedis,
        redisSessionKey: 'bot:session:staff-3',
        db: mockDb,
        anthropic: mockAnthropic,
        model: 'claude-3-haiku-20240307',
      })
    ).rejects.toThrow('Anthropic API failed');

    expect(mockIoEmit).toHaveBeenCalledWith('bot:message', {
      chunk: '',
      done: true,
      error: 'Something went wrong. Please try again.',
    });
  });
});
