import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PastPeriodBanner, PeriodSelector } from './period-selector';

import { api } from '@/lib/api';

/**
 * The period selector (UIUX §6.1).
 *
 * ⚠️ THE WINDOW FILTER IS THE LOAD-BEARING PART. `months` accumulates fixture
 * rows in BOTH directions across this repo's suites — far-future rollover
 * periods and Sprint 5's year-2000 ones — and offering either lands the user on
 * a grid with no data behind it, which reads as data loss rather than as a
 * fixture. The first version filtered only the future and shipped a picker full
 * of 2001-01 and 2000-12.
 */
const nav = vi.hoisted(() => ({ push: vi.fn() }));
const params = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  usePathname: () => '/home',
  useSearchParams: () => params.value,
}));

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

/** The current IST month, derived the way the component does. */
const CURRENT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
}).format(new Date());

function shift(period: string, delta: number): string {
  const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const month = (period: string, label = period, locked = false) => ({ period, label, locked });

function renderSelector() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PeriodSelector />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  params.value = new URLSearchParams();
  apiMock.mockResolvedValue({
    data: [
      month(CURRENT),
      month(shift(CURRENT, -1)),
      month(shift(CURRENT, -2)),
      // Outside the 12-month window, in both directions — the fixture rows this
      // repo's own suites leave behind.
      month(shift(CURRENT, -18)),
      month('2001-01'),
      month('2094-07'),
    ],
  });
});

afterEach(cleanup);

describe('the list is a 12-month window ending at the current month', () => {
  test('⭐ neither future nor ancient fixture months are offered', async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent);

    expect(labels).toHaveLength(3);
    // A rollover fixture from this very repo — offering it lands on an empty grid.
    expect(labels.join(' ')).not.toContain('2094');
    expect(labels.join(' ')).not.toContain('2001');
  });

  test('a month more than 12 back is outside the window', async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');

    expect(labels.some((l) => l.includes(shift(CURRENT, -18).slice(0, 4)))).toBe(false);
  });

  test('newest first — the month you want is the one you reach for', async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    const first = (await screen.findAllByRole('option'))[0];
    expect(first?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('labels stay readable when the data is not', () => {
  test('⭐ a label that is literally the period is humanised', async () => {
    // Fixtures across this repo insert `label: period`, so a dev database is full
    // of months labelled "2026-08". The column is authoritative when it says
    // something; deriving only when it does not is what keeps the picker legible.
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(labels[0]).toMatch(/[A-Z][a-z]+ \d{4}/);
    expect(labels[0]).not.toBe(CURRENT);
  });

  test('a real label from the database is used as-is', async () => {
    apiMock.mockResolvedValue({ data: [month(CURRENT, 'August 2026')] });
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    expect((await screen.findAllByRole('option'))[0]?.textContent).toContain('August 2026');
  });

  test('a locked month says so before you travel to it', async () => {
    apiMock.mockResolvedValue({ data: [month(CURRENT), month(shift(CURRENT, -1), undefined, true)] });
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    await waitFor(() => expect(screen.getByLabelText('Locked')).toBeDefined());
  });
});

describe('choosing a period', () => {
  test('pushes ?period= — the URL is the state, so it is bookmarkable', async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(await screen.findByRole('button', { name: /Change period/ }));
    const options = await screen.findAllByRole('option');
    await user.click(options[1]!);

    expect(nav.push).toHaveBeenCalledWith(`/home?period=${shift(CURRENT, -1)}`);
  });
});

describe('the past-period banner (§6.1)', () => {
  test('is absent on the current month', () => {
    params.value = new URLSearchParams({ period: CURRENT });
    render(<PastPeriodBanner />);
    expect(screen.queryByTestId('past-period-banner')).toBeNull();
  });

  test('⭐ appears on a past month, with a way back', async () => {
    params.value = new URLSearchParams({ period: shift(CURRENT, -1) });
    const user = userEvent.setup();
    render(<PastPeriodBanner />);

    expect(screen.getByTestId('past-period-banner')).toBeDefined();
    await user.click(screen.getByRole('button', { name: /Back to current/ }));
    expect(nav.push).toHaveBeenCalledWith(`/home?period=${CURRENT}`);
  });
});
