import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { HolidaysPanel } from './holidays-panel';

import { api } from '@/lib/api';

/**
 * Settings → Holidays (STEP 10).
 *
 * Two things here are not cosmetic. Removing a holiday runs the H-01 cascade in
 * reverse — everyone's attendance for that date goes back to a working day — and
 * that is invisible from the button, so the confirmation has to say it. And the
 * POST's `period` must come from the chosen DATE, not from the month being
 * viewed: the service uses the two together to flip attendance rows, so a
 * mismatched pair inserts the holiday and cascades over nothing.
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
vi.mock('@/lib/hooks/use-month-context', () => ({
  useMonthContext: () => ({ period: '2026-07', setPeriod: vi.fn() }),
  currentIstPeriod: () => '2026-07',
}));

const apiMock = vi.mocked(api);

const holiday = { id: 'h-1', period: '2026-07', date: '2026-07-29', name: 'Muharram' };

function renderPanel(rows = [holiday], canWrite = true) {
  apiMock.mockImplementation((path: string, init?: RequestInit) =>
    !init ? Promise.resolve({ data: rows }) : Promise.resolve({ data: { removed: true } }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HolidaysPanel canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('⭐ removal names the H-01 cascade', () => {
  test('the confirmation says the date reverts to a working day', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/2026-07-29/);
    expect(dialog.textContent).toMatch(/working day/);
  });

  test('confirming issues the DELETE', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Remove holiday' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/holidays/h-1', { method: 'DELETE' }),
    );
  });
});

describe('⭐ the period is derived from the date', () => {
  test('a date outside the viewed month sends ITS month, not the viewed one', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Muharram');

    await user.click(screen.getByRole('button', { name: 'Add holiday' }));
    const dateInput = screen.getByLabelText('Date');
    await user.clear(dateInput);
    await user.type(dateInput, '2026-08-15');
    await user.type(screen.getByLabelText('Name'), 'Independence Day');
    // Scoped to the dialog — the panel header carries a button of the same name.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add holiday' }));

    // Viewed period is 2026-07; the chosen date is in August. Sending the viewed
    // period would insert the row and update zero attendance rows, because the
    // service filters on period AND date together.
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/holidays', {
        method: 'POST',
        body: JSON.stringify({ period: '2026-08', date: '2026-08-15', name: 'Independence Day' }),
      }),
    );
  });
});

describe('write gating', () => {
  test('a caller without the write permission gets the list and nothing to click', async () => {
    renderPanel([holiday], false);

    expect(await screen.findByText('Muharram')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add holiday' })).toBeNull();
  });

  test('the list is fetched for the viewed period', async () => {
    renderPanel();
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/v1/holidays?period=2026-07'));
  });
});
