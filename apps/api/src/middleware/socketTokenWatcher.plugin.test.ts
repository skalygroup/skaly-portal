import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub tests for socketTokenWatcher — full integration tests require
// a running Socket.io server + client. These stubs validate the logic
// contracts and will be expanded in Sprint 10 (chat sprint) when the
// WebSocket infrastructure is fully wired.

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('socketTokenWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('missing exp → immediate disconnect', async () => {
    // Contract: if socket.handshake.auth.exp is missing, socket.disconnect(true)
    // is called immediately in the connection handler
    const mockSocket = {
      id: 'test-socket-1',
      handshake: { auth: {} },
      disconnect: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    const mockIo = {
      on: vi.fn((event: string, handler: (socket: any) => void) => {
        if (event === 'connection') handler(mockSocket);
      }),
    };

    const { setupSocketTokenWatcher } = await import('./socketTokenWatcher.plugin.js');
    setupSocketTokenWatcher(mockIo as any);

    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  test('expired token → immediate disconnect', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 100; // 100s ago
    const mockSocket = {
      id: 'test-socket-2',
      handshake: { auth: { exp: pastExp } },
      disconnect: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    const mockIo = {
      on: vi.fn((event: string, handler: (socket: any) => void) => {
        if (event === 'connection') handler(mockSocket);
      }),
    };

    const { setupSocketTokenWatcher } = await import('./socketTokenWatcher.plugin.js');
    setupSocketTokenWatcher(mockIo as any);

    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });

  test('valid token → timers scheduled, not immediately disconnected', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1hr from now
    const mockSocket = {
      id: 'test-socket-3',
      handshake: { auth: { exp: futureExp } },
      disconnect: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    const mockIo = {
      on: vi.fn((event: string, handler: (socket: any) => void) => {
        if (event === 'connection') handler(mockSocket);
      }),
    };

    const { setupSocketTokenWatcher } = await import('./socketTokenWatcher.plugin.js');
    setupSocketTokenWatcher(mockIo as any);

    // Should NOT be disconnected immediately
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    // Should have registered event listeners (auth:refresh, disconnect)
    expect(mockSocket.on).toHaveBeenCalled();
  });

  test('token expires → disconnect timer fires', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const futureExp = nowSec + 120; // 2 minutes from now
    const mockSocket = {
      id: 'test-socket-4',
      handshake: { auth: { exp: futureExp } },
      disconnect: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    };

    const mockIo = {
      on: vi.fn((event: string, handler: (socket: any) => void) => {
        if (event === 'connection') handler(mockSocket);
      }),
    };

    const { setupSocketTokenWatcher } = await import('./socketTokenWatcher.plugin.js');
    setupSocketTokenWatcher(mockIo as any);

    // Fast-forward past warning (exp - 60s = 60s from now)
    vi.advanceTimersByTime(61 * 1000);
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'auth:refresh_required',
      expect.objectContaining({ message: expect.any(String) }),
    );

    // Fast-forward past disconnect (exp + 30s = 150s from now, we're at 61s)
    vi.advanceTimersByTime(90 * 1000);
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });
});
