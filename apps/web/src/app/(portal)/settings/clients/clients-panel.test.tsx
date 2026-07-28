import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ClientsPanel } from './clients-panel';

import { api, ApiError } from '@/lib/api';

/**
 * Settings → Clients (STEP 9).
 *
 * The load-bearing test is the slot-count error landing on the FIELD. A required
 * value with no DEFAULT in the schema is the one thing a user can get wrong on
 * this form, and a toast for it disappears while they are still looking at the
 * input that caused it.
 *
 * The second is the panel/lookup split: a manager must not request
 * `includeInactive`, because that query param is admin-only and 403s — while the
 * bare list stays open to every role by design.
 */
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
      this.name = 'ApiError';
    }
  }
  return { api: vi.fn(), ApiError };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const apiMock = vi.mocked(api);

const client = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  name: 'Acme Studios',
  isInternal: false,
  active: true,
  shootSlotsPerMonth: 4,
  piecesPerVisit: 1,
  whatsappNumber: null,
  createdAt: '2026-01-01',
  ...over,
});

function renderPanel({ canWrite = true, isAdmin = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClientsPanel canWrite={canWrite} isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('⭐ gate the panel, never the lookup', () => {
  test('an admin asks for includeInactive; a manager asks for the bare list', async () => {
    apiMock.mockResolvedValue({ data: [client()] });

    renderPanel({ isAdmin: true });
    await screen.findByText('Acme Studios');
    expect(apiMock).toHaveBeenCalledWith('/v1/clients?includeInactive=true');

    cleanup();
    apiMock.mockClear();

    renderPanel({ isAdmin: false });
    await screen.findByText('Acme Studios');
    // NOT includeInactive: that param is admin-only and 403s. The bare list is
    // open to all four roles — it is the shared client filter every grid reads.
    expect(apiMock).toHaveBeenCalledWith('/v1/clients');
  });

  test('a manager gets Edit but no lifecycle actions', async () => {
    apiMock.mockResolvedValue({ data: [client()] });
    renderPanel({ canWrite: true, isAdmin: false });

    await screen.findByText('Acme Studios');
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeTruthy();
    // Deactivate/reactivate are admin-only on the API — hidden rather than
    // rendered into a 403.
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reactivate/i })).toBeNull();
  });

  test('no write permission → no New client, no row actions', async () => {
    apiMock.mockResolvedValue({ data: [client()] });
    renderPanel({ canWrite: false, isAdmin: false });

    await screen.findByText('Acme Studios');
    expect(screen.queryByRole('button', { name: /new client/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
  });
});

describe('⭐ the slot-count error maps to the field', () => {
  test('CLIENT_SHOOT_SLOTS_REQUIRED renders on the input, not in a toast', async () => {
    apiMock.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /new client/i }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^name$/i), 'New Client');

    apiMock.mockRejectedValueOnce(new ApiError(400, 'CLIENT_SHOOT_SLOTS_REQUIRED'));
    await user.click(within(dialog).getByRole('button', { name: /create client/i }));

    const error = await within(dialog).findByRole('alert');
    expect(error.textContent).toMatch(/shoot slots/i);

    // Tied to the input by aria, so a screen reader gets it too — a red
    // paragraph floating near a field is not "on the field".
    const slots = within(dialog).getByLabelText(/shoot slots per month/i);
    expect(slots.getAttribute('aria-invalid')).toBe('true');
    expect(slots.getAttribute('aria-describedby')).toBe(error.id);
  });

  test('editing the field clears the error', async () => {
    apiMock.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /new client/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^name$/i), 'New Client');

    apiMock.mockRejectedValueOnce(new ApiError(400, 'CLIENT_SHOOT_SLOTS_REQUIRED'));
    await user.click(within(dialog).getByRole('button', { name: /create client/i }));
    await within(dialog).findByRole('alert');

    await user.type(within(dialog).getByLabelText(/shoot slots per month/i), '4');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

describe('lifecycle confirmations name what actually happens', () => {
  test('deactivate says the history is kept', async () => {
    apiMock.mockResolvedValue({ data: [client()] });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Acme Studios');
    apiMock.mockClear();
    await user.click(screen.getByRole('button', { name: /deactivate/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/nothing already recorded is deleted/i)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/clients/c-1', { method: 'DELETE' }),
    );
  });

  test('⭐ reactivate mentions the current-period rows being regenerated', async () => {
    apiMock.mockResolvedValue({ data: [client({ active: false })] });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Acme Studios');
    await user.click(screen.getByRole('button', { name: /reactivate/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/regenerated/i)).toBeTruthy();
  });
});

describe('editing sends only what changed', () => {
  test('a rename does NOT rebuild the shoot slots', async () => {
    apiMock.mockResolvedValue({ data: [client()] });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Acme Studios');
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog');

    const name = within(dialog).getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, 'Acme Films');

    apiMock.mockClear();
    apiMock.mockResolvedValue({ data: [client({ name: 'Acme Films' })] });
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/clients/c-1', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Acme Films' }),
      }),
    );
    // The claim, stated directly. A total-call count would also match the
    // post-save refetch and would pass for the wrong reason.
    expect(apiMock).not.toHaveBeenCalledWith(
      expect.stringContaining('shoot-slots'),
      expect.anything(),
    );
  });

  test('Save stays disabled until something actually changes', async () => {
    apiMock.mockResolvedValue({ data: [client()] });
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Acme Studios');
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog');

    const save = within(dialog).getByRole('button', { name: /save changes/i });
    expect(save.hasAttribute('disabled')).toBe(true);
  });
});
