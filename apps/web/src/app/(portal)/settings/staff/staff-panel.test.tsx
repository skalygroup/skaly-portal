import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { StaffPanel } from './staff-panel';

import { api } from '@/lib/api';

/**
 * Settings → Staff (STEP 9).
 *
 * Two things carry this file. A manager's table must have NO row actions — the
 * 👁 limited row in Auth-Matrix §3 is about what you can do, not only what you
 * can see, and a disabled-looking button that 403s is a worse answer than no
 * button. And [Reinstate] must appear only for soft-deleted rows, because that
 * button is the entire user-visible surface of A4's fix; if it renders on a live
 * row it is offering to reinstate someone who never left.
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

const row = (over: Record<string, unknown> = {}) => ({
  id: 'st-1',
  name: 'Asha Rao',
  role: 'team_member',
  avatarUrl: null,
  active: true,
  joinedAt: '2026-01-04',
  email: 'asha@skaly.in',
  mfaEnrolled: false,
  deactivatedAt: null,
  ...over,
});

function renderPanel(canWrite: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StaffPanel canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('row actions follow the write permission, not the table', () => {
  test('⭐ a manager gets the table and NO row actions', async () => {
    apiMock.mockResolvedValue({ data: [row()] });
    renderPanel(false);

    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reset mfa/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull();
    // ...and no admin-only COLUMNS either. The API omits the fields, so
    // rendering the header would produce a column of em-dashes.
    expect(screen.queryByText('Email')).toBeNull();
    expect(screen.queryByText('MFA')).toBeNull();
  });

  test('an admin gets Invite, Reset MFA and Deactivate', async () => {
    apiMock.mockResolvedValue({ data: [row()] });
    renderPanel(true);

    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByRole('button', { name: /invite/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reset mfa/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeTruthy();
  });
});

describe('destructive actions name their consequence', () => {
  test('⭐ deactivate requires confirmation, and does NOT call the API before it', async () => {
    apiMock.mockResolvedValue({ data: [row()] });
    const user = userEvent.setup();
    renderPanel(true);

    await screen.findByText('Asha Rao');
    apiMock.mockClear();

    await user.click(screen.getByRole('button', { name: /deactivate/i }));

    // The dialog is open and the mutation has not fired.
    const dialog = await screen.findByRole('dialog');
    expect(apiMock).not.toHaveBeenCalled();

    // The consequence, not "Are you sure?".
    expect(within(dialog).getByText(/signed out/i)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/staff/st-1/deactivate', { method: 'PUT' }),
    );
  });

  test('cancelling the confirmation calls nothing', async () => {
    apiMock.mockResolvedValue({ data: [row()] });
    const user = userEvent.setup();
    renderPanel(true);

    await screen.findByText('Asha Rao');
    apiMock.mockClear();

    await user.click(screen.getByRole('button', { name: /deactivate/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  test('reset MFA names re-enrolment as the consequence', async () => {
    apiMock.mockResolvedValue({ data: [row({ mfaEnrolled: true })] });
    const user = userEvent.setup();
    renderPanel(true);

    await screen.findByText('Asha Rao');
    await user.click(screen.getByRole('button', { name: /reset mfa/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/re-enrol on their next login/i)).toBeTruthy();
  });
});

describe('⭐ reinstate is reachable, and only where it makes sense', () => {
  test('a soft-deleted row gets [Reinstate]; a live row does not', async () => {
    apiMock.mockResolvedValue({
      data: [row(), row({ id: 'st-2', name: 'Former Person', active: false, deactivatedAt: '2026-03-02' })],
    });
    const user = userEvent.setup();
    renderPanel(true);

    await screen.findByText('Asha Rao');

    // Collapsed by default — a list you consult, not one you read.
    expect(screen.queryByText('Former Person')).toBeNull();
    await user.click(screen.getByRole('button', { name: /former staff \(1\)/i }));

    expect(await screen.findByText('Former Person')).toBeTruthy();
    const reinstate = screen.getAllByRole('button', { name: /reinstate/i });
    // Exactly one — the live row must not offer to reinstate someone who never left.
    expect(reinstate).toHaveLength(1);

    apiMock.mockClear();
    await user.click(reinstate[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/history intact/i)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /^reinstate$/i }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/staff/st-2/reactivate', { method: 'PUT' }),
    );
  });

  test('the Former staff section is absent when nobody has left', async () => {
    apiMock.mockResolvedValue({ data: [row()] });
    renderPanel(true);

    await screen.findByText('Asha Rao');
    expect(screen.queryByRole('button', { name: /former staff/i })).toBeNull();
  });
});
