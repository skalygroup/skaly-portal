import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ReportsPanel } from './reports-panel';

import { api, ApiError } from '@/lib/api';

/**
 * Settings → Reports (STEP 11).
 *
 * ADR-027 moved the render off the event loop, which makes the PANEL responsible
 * for the half a user actually experiences: a report that is accepted but not
 * done. The two assertions that carry this file are that `report_ready` finishes
 * a pending row WITHOUT a poll, and that the download link is fetched at click
 * time rather than held on the row — a stored presigned URL is a button that
 * works until it silently doesn't (audit M-08).
 */
const handlers = new Map<string, (payload: unknown) => void>();

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
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
vi.mock('@/lib/socket', () => ({
  useNotifySocket: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
  },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

let search = '';
const apiMock = vi.mocked(api);

const report = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'rep-1',
  type: 'client_monthly',
  period: '2026-06',
  clientId: 'cl-1',
  clientName: 'Acme',
  status: 'pending',
  errorMessage: null,
  requestedAt: '2026-07-01T04:00:00.000Z',
  completedAt: null,
  requestedBy: 'st-1',
  ...over,
});

const CLIENTS = [{ id: 'cl-1', name: 'Acme', isInternal: false, active: true }];

/** Serves the two list GETs; `reports` comes from a mutable box so a refetch can
 *  return a different answer than the first load. */
let reportRows: ReturnType<typeof report>[] = [];
function mockLists() {
  apiMock.mockImplementation((path: string) => {
    if (path === '/v1/reports') return Promise.resolve({ data: reportRows });
    if (path === '/v1/clients') return Promise.resolve({ data: CLIENTS });
    return Promise.resolve({ data: {} });
  });
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handlers.clear();
  search = '';
  reportRows = [];
  vi.clearAllMocks();
});
afterEach(cleanup);

/**
 * ⚠️ THESE TESTS SUBSCRIBE TO `notify:new`, AND THE EVENT NAME IS LOAD-BEARING.
 *
 * They used to fire `handlers.get('report_ready')`, which passed against a panel
 * listening for an event the server has never emitted — the handler was correct
 * and unreachable, so a finished report spun on "Generating" until a reload, and
 * every assertion here stayed green. Firing the name the SERVER sends
 * (`notify:new`, carrying the row's `type`) is what makes the suite able to fail
 * for that.
 *
 * `handlers.get('notify:new')` is `undefined` if the panel subscribes to
 * anything else, and `?.()` on undefined is a silent no-op — so each test below
 * asserts the handler EXISTS before using it. Without that, the same defect
 * would come back as a passing test for the second time.
 */
describe('⭐ the async contract', () => {
  test('a pending report becomes ready on a report_ready notification — no poll', async () => {
    reportRows = [report()];
    mockLists();
    renderPanel();

    expect(await screen.findByText('Generating')).toBeTruthy();
    const callsBefore = apiMock.mock.calls.length;

    const onNotify = handlers.get('notify:new');
    expect(onNotify, 'the panel must subscribe to notify:new — see the note above').toBeDefined();

    // The worker finishes. The event is the ONLY thing that happens — nothing
    // here is on a timer, so a passing test proves the socket did it.
    reportRows = [report({ status: 'ready', completedAt: '2026-07-01T04:02:00.000Z' })];
    onNotify!({ type: 'report_ready', payload: { reportId: 'rep-1', status: 'ready' } });

    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.queryByText('Generating')).toBeNull();
    // Exactly one extra request: the list refetch. Not a poll loop.
    expect(apiMock.mock.calls.length).toBe(callsBefore + 1);
  });

  test('a report_ready notification also settles a FAILED render, so nothing spins forever', async () => {
    reportRows = [report()];
    mockLists();
    renderPanel();
    await screen.findByText('Generating');

    // The worker notifies on both outcomes; if the panel only reacted to
    // success, a failed report would spin until a manual reload.
    reportRows = [report({ status: 'failed', errorMessage: 'No attendance rows for that period.' })];
    handlers.get('notify:new')!({ type: 'report_ready', payload: { reportId: 'rep-1', status: 'failed' } });

    expect(await screen.findByText('Failed')).toBeTruthy();
    // The reason is shown inline. "Failed" alone is a dead end.
    expect(screen.getByText(/No attendance rows for that period/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  test('an unrelated notification does NOT refetch the list', async () => {
    reportRows = [report()];
    mockLists();
    renderPanel();
    await screen.findByText('Generating');
    const callsBefore = apiMock.mock.calls.length;

    // Every notification of every type reaches this handler. A missing type
    // guard would make one task assignment refetch this list for everyone who
    // happens to have the panel open — the fan-out ADR-022 exists to prevent.
    handlers.get('notify:new')!({ type: 'task_assigned', payload: { taskId: 't-1' } });

    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.mock.calls.length).toBe(callsBefore);
  });

  test('the UI says the tab can be closed', async () => {
    mockLists();
    renderPanel();
    // A user who thinks the render depends on their tab will sit and wait on it.
    expect(await screen.findByText(/you can leave this page/i)).toBeTruthy();
  });
});

describe('⭐ the download link is fetched at click time', () => {
  test('Download calls GET /v1/reports/:id and opens the fresh URL', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    reportRows = [report({ status: 'ready' })];
    mockLists();
    renderPanel();

    await screen.findByText('Ready');
    apiMock.mockImplementation((path: string) => {
      if (path === '/v1/reports/rep-1') {
        return Promise.resolve({ data: { ...report({ status: 'ready' }), downloadUrl: 'https://r2/fresh' } });
      }
      return Promise.resolve({ data: reportRows });
    });

    await user.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/v1/reports/rep-1'));
    expect(open).toHaveBeenCalledWith('https://r2/fresh', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  test('a 30-day-expired report says so and does not open a dead link', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    reportRows = [report({ status: 'ready' })];
    mockLists();
    renderPanel();

    await screen.findByText('Ready');
    apiMock.mockRejectedValueOnce(new ApiError(410, 'RESOURCE_EXPIRED'));
    await user.click(screen.getByRole('button', { name: /download/i }));

    // R2's lifecycle rule removed the object; presigning it would hand over a
    // URL that 404s on click.
    await waitFor(() => expect(open).not.toHaveBeenCalled());
    open.mockRestore();
  });
});

describe('generate', () => {
  test('client_monthly sends the clientId; org_monthly omits it entirely', async () => {
    const user = userEvent.setup();
    mockLists();
    renderPanel();
    // Wait for the OPTION, not the select — the select renders immediately with
    // just its placeholder while the client lookup is still in flight.
    await screen.findByRole('option', { name: 'Acme' });

    await user.selectOptions(screen.getByLabelText('Client'), 'cl-1');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/v1/reports/generate', {
        method: 'POST',
        body: expect.stringContaining('"clientId":"cl-1"'),
      }),
    );

    // The API REJECTS clientId for org_monthly, so it must be absent rather than
    // null — the selector disappears and so does the field.
    await user.selectOptions(screen.getByLabelText('Report'), 'org_monthly');
    expect(screen.queryByLabelText('Client')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => {
      // The LAST generate call, not the last call — a successful generate is
      // followed by the list refetch, which has no body at all.
      const generates = apiMock.mock.calls.filter(([p]) => p === '/v1/reports/generate');
      expect(generates.length).toBe(2);
      expect(String((generates.at(-1)![1] as RequestInit).body)).not.toContain('clientId');
    });
  });

  test('a missing client maps to the field, not a toast', async () => {
    const user = userEvent.setup();
    mockLists();
    renderPanel();
    // Wait for the OPTION, not the select — the select renders immediately with
    // just its placeholder while the client lookup is still in flight.
    await screen.findByRole('option', { name: 'Acme' });

    apiMock.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR'));
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/Choose a client/);
    expect(screen.getByLabelText('Client').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('the report_ready deep link lands somewhere', () => {
  test('⭐ ?reportId= highlights that row', async () => {
    // M-08's payoff: the notification carries a portal route instead of a
    // presigned URL, which is only worth doing if arriving here shows you the
    // report you clicked for.
    search = 'reportId=rep-1';
    reportRows = [report({ status: 'ready' })];
    mockLists();
    renderPanel();

    const row = await screen.findByTestId('report-rep-1');
    expect(row.className).toContain('accent-gold-dim');
  });
});
