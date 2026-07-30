import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MonthsPanel } from './months-panel';

import { api, ApiError } from '@/lib/api';

/**
 * Settings → Months (STEP 10).
 *
 * Unlock is the only action in Settings that makes the admin write something
 * down, and `UNLOCK_REASON_REQUIRED` is enforced in `MonthService` — not by the
 * route's Zod body — so there is ONE gate rather than two that answer
 * differently depending on whether you sent `{}` or nothing. What this file
 * pins is that the panel puts that answer on the FIELD. A toast would vanish
 * while the admin is still looking at the empty textarea it is about.
 */
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const apiMock = vi.mocked(api);

const month = (over: Record<string, unknown> = {}) => ({
  period: '2026-06',
  label: 'June 2026',
  locked: true,
  lockedAt: '2026-07-01T04:00:00.000Z',
  lockedByName: 'Arslaan',
  unlockedAt: null,
  unlockedByName: null,
  unlockReason: null,
  ...over,
});

function renderPanel(rows: ReturnType<typeof month>[], canWrite = true) {
  apiMock.mockImplementation((path: string, init?: RequestInit) =>
    !init ? Promise.resolve({ data: rows }) : Promise.resolve({}),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MonthsPanel canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('⭐ unlock requires a reason, on the field', () => {
  test('an empty reason surfaces UNLOCK_REASON_REQUIRED as a field error', async () => {
    const user = userEvent.setup();
    renderPanel([month()]);

    await user.click(await screen.findByRole('button', { name: 'Unlock' }));

    // The button is deliberately NOT disabled on an empty reason: the rule lives
    // on the server, and letting the click through is what proves the server
    // said no and puts its answer where the admin is looking.
    apiMock.mockRejectedValueOnce(new ApiError(400, 'UNLOCK_REASON_REQUIRED'));
    await user.click(screen.getByRole('button', { name: 'Unlock month' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/Say why this month is being reopened/);
    // Tied to the textarea, not floating next to it.
    expect(screen.getByLabelText(/Reason/).getAttribute('aria-describedby')).toBe(
      'unlock-reason-error',
    );
    expect(screen.getByLabelText(/Reason/).getAttribute('aria-invalid')).toBe('true');
  });

  test('a reason sends the DELETE and carries the text', async () => {
    const user = userEvent.setup();
    renderPanel([month()]);

    await user.click(await screen.findByRole('button', { name: 'Unlock' }));
    await user.type(screen.getByLabelText(/Reason/), 'Fixing three attendance rows.');
    await user.click(screen.getByRole('button', { name: 'Unlock month' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/months/2026-06/lock', {
        method: 'DELETE',
        body: JSON.stringify({ reason: 'Fixing three attendance rows.' }),
      }),
    );
  });

  test('typing clears the field error rather than leaving it stale', async () => {
    const user = userEvent.setup();
    renderPanel([month()]);

    await user.click(await screen.findByRole('button', { name: 'Unlock' }));
    apiMock.mockRejectedValueOnce(new ApiError(400, 'UNLOCK_REASON_REQUIRED'));
    await user.click(screen.getByRole('button', { name: 'Unlock month' }));
    await screen.findByRole('alert');

    await user.type(screen.getByLabelText(/Reason/), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('locking names its consequence', () => {
  test('⭐ the lock confirmation says every module goes read-only', async () => {
    const user = userEvent.setup();
    renderPanel([month({ locked: false, lockedByName: null, lockedAt: null })]);

    await user.click(await screen.findByRole('button', { name: 'Lock' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Every module goes read-only for June 2026/);
    // "Are you sure?" asks a question the admin answered by clicking. What they
    // cannot know without being told is that this stops everyone else too.
    expect(dialog.textContent).not.toMatch(/^Are you sure/);
  });

  test('lock is one click behind one confirmation — no reason asked', async () => {
    const user = userEvent.setup();
    renderPanel([month({ locked: false, lockedByName: null, lockedAt: null })]);

    await user.click(await screen.findByRole('button', { name: 'Lock' }));
    expect(screen.queryByLabelText(/Reason/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Lock month' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/months/2026-06/lock', { method: 'POST' }),
    );
  });
});

describe('the history column explains the decision', () => {
  test('a reopened month shows who reopened it and why', async () => {
    renderPanel([
      month({
        locked: false,
        unlockedAt: '2026-07-20T04:00:00.000Z',
        unlockedByName: 'Arslaan',
        unlockReason: 'Client invoice correction',
      }),
    ]);

    expect(await screen.findByText(/Reopened by Arslaan/)).toBeTruthy();
    expect(screen.getByText(/Client invoice correction/)).toBeTruthy();
  });

  test('a manager sees the state but no lock or unlock action', async () => {
    renderPanel([month()], false);

    expect(await screen.findByText('June 2026')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });
});
