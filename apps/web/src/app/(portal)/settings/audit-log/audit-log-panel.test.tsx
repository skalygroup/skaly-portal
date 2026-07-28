import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AuditLogPanel } from './audit-log-panel';

import { api, apiFetch } from '@/lib/api';
import { streamToDisk } from '@/lib/stream-download';

/**
 * Settings → Audit Log (STEP 11).
 *
 * Three properties carry this file, and all three are ones you cannot see by
 * looking at the screen:
 *
 *   1. The table is VIRTUALISED — 50k rows at 12 months (NFR §2.2), so a
 *      component that renders every row looks perfect against a 10-row fixture
 *      and dies against real data.
 *   2. The export is never buffered in JS (ADR-028). `res.blob()` here would put
 *      back, one tab at a time, the ceiling the streaming server removed.
 *   3. There are NO mutation controls, structurally. Migration 026 revoked
 *      UPDATE and DELETE on `audit_log` from the app role, so a button here
 *      could only ever render an error.
 */
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
vi.mock('@/lib/stream-download', () => ({ streamToDisk: vi.fn(async () => 'saved') }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const apiMock = vi.mocked(api);
const apiFetchMock = vi.mocked(apiFetch);
const streamMock = vi.mocked(streamToDisk);

const entry = (i: number) => ({
  id: `au-${i}`,
  createdAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T04:00:00.000Z`,
  actorId: 'st-1',
  actorName: 'Asha Rao',
  actorRole: 'admin',
  source: 'user',
  tableName: 'staff',
  action: 'UPDATE',
  recordId: 'rec-1',
  oldValue: { active: true },
  newValue: { active: false },
  ipAddress: null,
});

/**
 * jsdom reports every element as 0×0 and ships no ResizeObserver, and TanStack
 * Virtual measures the scroll element through both. Left alone, the virtualiser
 * renders ZERO rows and the windowing assertion below passes vacuously — so the
 * viewport has to be stubbed for the test to be able to fail.
 */
function stubLayout(height = 560) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  // `observeElementRect` reads offsetWidth/offsetHeight, not the bounding rect.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: height });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 900 });
}

function mockPage(rows: ReturnType<typeof entry>[], nextCursor: string | null = null) {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith('/v1/staff')) return Promise.resolve({ data: [{ id: 'st-1', name: 'Asha Rao' }] });
    return Promise.resolve({ data: rows, nextCursor });
  });
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuditLogPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('⭐ the table is virtualised', () => {
  test('1000 rows render as a window, not 1000 DOM nodes', async () => {
    stubLayout();
    mockPage(Array.from({ length: 1000 }, (_, i) => entry(i)));
    renderPanel();

    await screen.findByTestId('audit-scroll');
    await waitFor(() => expect(screen.getAllByTestId('audit-row').length).toBeGreaterThan(0));

    const rendered = screen.getAllByTestId('audit-row').length;
    // A viewport of ~560px at ~52px per row plus overscan. The exact number is
    // the virtualiser's business; what matters is that it is nowhere near 1000.
    expect(rendered).toBeLessThan(100);
  });
});

describe('⭐ the export never buffers', () => {
  test('Export CSV hands the raw Response to the streaming saver', async () => {
    const user = userEvent.setup();
    stubLayout();
    mockPage([entry(0)]);
    const body = { ok: true, body: {} } as unknown as Response;
    apiFetchMock.mockResolvedValue(body);
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(streamMock).toHaveBeenCalledWith(body, expect.stringMatching(/\.csv$/)));
    // The Response is passed through untouched. If this ever became
    // `await res.blob()` or `res.text()`, the ADR-028 pipeline would terminate
    // in the browser's heap instead of on disk.
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('/v1/audit-log/export'));
  });

  test('the export uses the SAME filters as the table', async () => {
    const user = userEvent.setup();
    stubLayout();
    mockPage([entry(0)]);
    apiFetchMock.mockResolvedValue({ ok: true, body: {} } as unknown as Response);
    renderPanel();

    await screen.findByTestId('audit-scroll');
    await user.selectOptions(screen.getByLabelText('Action'), 'DELETE');
    await user.click(screen.getByRole('button', { name: /export csv/i }));

    // "Export" means "what I am looking at". Both strings come from one
    // `toQuery`, so they cannot select different rows.
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining('action=DELETE')),
    );
  });
});

describe('filters compose into the query', () => {
  test('blank filters are omitted, never sent as empty strings', async () => {
    stubLayout();
    mockPage([entry(0)]);
    renderPanel();

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    const listCall = apiMock.mock.calls.find(([p]) => p.startsWith('/v1/audit-log'));
    // `?action=` would fail the route's enum and 400 the whole page.
    expect(listCall?.[0]).not.toMatch(/=&|=$/);
  });

  test('changing a filter refetches with it applied', async () => {
    const user = userEvent.setup();
    stubLayout();
    mockPage([entry(0)]);
    renderPanel();

    await screen.findByTestId('audit-scroll');
    await user.selectOptions(screen.getByLabelText('Source'), 'bot');

    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p.includes('changedBySource=bot')),
        'the filter belongs in the query key, so the cache cannot serve the old rows',
      ).toBe(true),
    );
  });
});

describe('⭐ the table is read-only, structurally', () => {
  test('no edit or delete control exists anywhere in the panel', async () => {
    stubLayout();
    mockPage([entry(0)]);
    renderPanel();

    await screen.findByTestId('audit-scroll');
    for (const name of [/edit/i, /delete/i, /remove/i, /save/i]) {
      expect(screen.queryByRole('button', { name }), `${name} must not exist`).toBeNull();
    }
  });

  test('a row expands to show only the keys that changed', async () => {
    const user = userEvent.setup();
    stubLayout();
    mockPage([entry(0)]);
    renderPanel();

    await screen.findByTestId('audit-scroll');
    await user.click(screen.getAllByRole('button', { expanded: false })[0]!);

    // old { active: true } → new { active: false }: one changed key, both sides.
    expect(await screen.findByText('active')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getByText('false')).toBeTruthy();
  });
});
