import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SignupRequestsClient } from './signup-requests-client';

import type { SignupRequestAdminItem } from '@skaly/shared/schemas/auth';

import { api, ApiError } from '@/lib/api';

/**
 * Settings → Signup Requests (STEP 10).
 *
 * ⭐ The reinstate branch is the user-visible half of A4's fix, and the reason it
 * needs its own test is that the API delivers it as a 409. Everything in a
 * frontend reflexively routes a 409 to an error toast — which would reproduce
 * A4's actual harm (an admin with no way forward and a person who stays
 * unhireable) while looking like correct error handling. So this asserts the
 * branch RENDERS and offers the action, not merely that nothing crashed.
 */
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message?: string,
      public details?: Record<string, unknown>,
    ) {
      super(message ?? code);
    }
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The card list animates; the animation is not what is under test here.
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: React.ComponentProps<'div'>) => <div {...rest}>{children}</div>,
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const apiMock = vi.mocked(api);

const request = (over: Partial<SignupRequestAdminItem> = {}): SignupRequestAdminItem =>
  ({
    id: 'req-1',
    name: 'Asha Rao',
    email: 'asha@skaly.in',
    mobileNumber: '+91 90000 00000',
    dateOfBirth: '1996-04-02',
    roleRequested: 'team_member',
    message: null,
    cvFileKey: null,
    createdAt: '2026-07-20T04:00:00.000Z',
    rejectionNote: null,
    publicRejectionMessage: null,
    ...over,
  }) as SignupRequestAdminItem;

function renderPanel(status: 'pending' | 'rejected' = 'pending', data = [request()]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SignupRequestsClient status={status} initialData={data} />
    </QueryClientProvider>,
  );
}

/** The 409 `approveSignupRequest` throws when it finds a tombstone (ADR-026 §4). */
const reinstateSuggestion = () =>
  new ApiError(
    409,
    'ALREADY_PROCESSED',
    'This person previously worked here. Reinstate their account instead of creating a new one.',
    {
      previousStaffId: 'st-old',
      deactivatedAt: '2025-11-14T09:00:00.000Z',
      suggestion: 'reinstate',
    },
  );

async function approveInto(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('⭐ the reinstate branch (A4)', () => {
  test('the suggestion renders as a choice, not an error toast', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(reinstateSuggestion());
    renderPanel();

    await approveInto(user);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Asha Rao previously worked here/);
    // The date is what makes the claim checkable rather than an assertion the
    // admin has to take on faith.
    expect(dialog.textContent).toMatch(/2025-11-14/);
    expect(screen.getByRole('button', { name: 'Reinstate their account' })).toBeTruthy();
  });

  test('reinstating is ONE call that also closes the request', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(reinstateSuggestion());
    renderPanel();
    await approveInto(user);

    apiMock.mockResolvedValueOnce({ staffId: 'st-old', status: 'approved' });
    await user.click(screen.getByRole('button', { name: 'Reinstate their account' }));

    // Not "reactivate, then mark approved": a dropped second fetch would leave
    // the person live with their request still pending, and re-approving THAT
    // hits the live-row branch — which rejects with the exact false sentence A4
    // exists to delete.
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/auth/signup-requests/req-1/reinstate', {
        method: 'POST',
      }),
    );
    expect(apiMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/reactivate'),
      expect.anything(),
    );
  });

  test('⭐ "leave pending" is the second choice — never "create a new account"', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(reinstateSuggestion());
    renderPanel();
    await approveInto(user);

    await screen.findByRole('dialog');
    // ADR-026 §3: reinstate the ORIGINAL row, never a duplicate. A [Create new]
    // button would exist only to violate the ruling this screen implements —
    // the returning employee would come back as a new id and lose every task,
    // attendance row and audit entry that names them.
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave pending' })).toBeTruthy();
  });

  test('an ordinary 409 with no suggestion still toasts — the branch is not a catch-all', async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new ApiError(409, 'ALREADY_PROCESSED', 'Live account exists.'));
    renderPanel();
    await approveInto(user);

    // Still the approve modal; a LIVE row is the H-04 backstop and correctly an
    // error, not an offer to reinstate somebody who never left.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm approval' })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Reinstate their account' })).toBeNull();
  });
});

describe('the rejection note is internal', () => {
  test('reject cannot be submitted without a note', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    await user.click(confirm);
    expect(apiMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Internal note/), 'Not enough experience.');
    await user.click(confirm);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
  });

  test('the note field says out loud that only the admin sees it', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    // NFR §4.2: rejection_note is never transmitted to the applicant. The admin
    // has to KNOW that, or they will write the public message in the wrong box.
    expect(screen.getByText(/only you see this/i)).toBeTruthy();
  });

  test('the note renders on the rejected tab, which is the admin panel', async () => {
    renderPanel('rejected', [
      request({ rejectionNote: 'Overlaps an existing role.', publicRejectionMessage: 'Thanks!' }),
    ]);

    expect(screen.getByText(/Overlaps an existing role/)).toBeTruthy();
    expect(screen.getByText(/Thanks!/)).toBeTruthy();
  });
});
