import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PermissionsPanel } from './permissions-panel';

import { api } from '@/lib/api';

/**
 * Settings → Permissions (STEP 10).
 *
 * The whole file is about the THIRD state. A two-state toggle passes every test
 * you would naturally write — allow works, deny works — and is still wrong,
 * because the bug it causes is a state you can no longer REACH: once an admin
 * touches a key, that person is pinned to whatever was written and stops
 * tracking their role default forever. So these assert the verbs, not the
 * pixels: allow → PUT true, deny → PUT false, inherit → DELETE. A DELETE that
 * quietly became `PUT { value: false }` would look identical on screen.
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

/** `bot.tool.update_task_status` is the documented 🔧 case: false for a team
 *  member by role default, and override-able. Its label comes out of humanise(). */
const KEY = 'bot.tool.update_task_status';
const KEY_LABEL = 'Update task status';

const STAFF = [{ id: 'st-1', name: 'Asha Rao', role: 'team_member', active: true }];

/** Routes the two GETs; mutations resolve empty. Returns the call log. */
function mockApi(overrides: { permissionKey: string; value: boolean }[]) {
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/v1/settings/staff') return Promise.resolve({ data: STAFF });
    if (path.endsWith('/permissions') && !init) {
      return Promise.resolve({ data: { staffId: 'st-1', role: 'team_member', overrides } });
    }
    return Promise.resolve({});
  });
}

function renderPanel(canWrite = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PermissionsPanel canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

/** Select the staff member and hand back the control's fieldset. */
async function openControl(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole('option', { name: /Asha Rao/ })).toBeTruthy());
  await user.selectOptions(screen.getByLabelText('Staff member'), 'st-1');
  return await screen.findByRole('group', { name: KEY_LABEL });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('⭐ three states, three verbs', () => {
  test('Allow issues PUT { value: true }', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel();

    const group = await openControl(user);
    await user.click(within(group).getByRole('radio', { name: 'Allow' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/v1/staff/st-1/permissions/${KEY}`, {
        method: 'PUT',
        body: JSON.stringify({ value: true }),
      }),
    );
  });

  test('Deny issues PUT { value: false } — NOT a delete', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel();

    const group = await openControl(user);
    await user.click(within(group).getByRole('radio', { name: 'Deny' }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/v1/staff/st-1/permissions/${KEY}`, {
        method: 'PUT',
        body: JSON.stringify({ value: false }),
      }),
    );
  });

  test('⭐ Inherit issues DELETE — the row must GO, not be set to a third value', async () => {
    const user = userEvent.setup();
    // Start from an explicit DENY so Inherit is a real transition rather than a
    // no-op click on the already-selected option.
    mockApi([{ permissionKey: KEY, value: false }]);
    renderPanel();

    const group = await openControl(user);
    await user.click(within(group).getByRole('radio', { name: /^Inherit/ }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/v1/staff/st-1/permissions/${KEY}`, {
        method: 'DELETE',
      }),
    );
    // §6.1 is "no row found → role default". A DELETE carrying a body would mean
    // somebody decided inheritance was a value after all.
    const call = apiMock.mock.calls.find(([p]) => p.endsWith(`/permissions/${KEY}`));
    expect((call?.[1] as RequestInit | undefined)?.body).toBeUndefined();
  });
});

describe('Inherit says what it resolves to', () => {
  test('⭐ the selected Inherit names the role default rather than just "Inherit"', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel();

    const group = await openControl(user);
    // team_member's default for this key is false — so Inherit must read
    // "denied by role". "Inherit" alone is a state whose meaning the admin has
    // to leave the screen to discover.
    expect(within(group).getByRole('radio', { name: 'Inherit — denied by role' })).toBeTruthy();
  });

  test('⭐ the effective result is shown, so an admin verifies without impersonating', async () => {
    const user = userEvent.setup();
    // An explicit ALLOW on a key the role denies: override wins (§6.1).
    mockApi([{ permissionKey: KEY, value: true }]);
    renderPanel();

    await openControl(user);
    expect(screen.getByTestId(`effective-${KEY}`).textContent).toBe('Allowed');
  });

  test('an untouched key shows the role default as the effective answer', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel();

    await openControl(user);
    expect(screen.getByTestId(`effective-${KEY}`).textContent).toBe('Denied');
  });
});

describe('the matrix is derived from ROLE_DEFAULTS, not typed here', () => {
  test('all three groups render, including keys in no prefix family', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel();
    await openControl(user);

    expect(screen.getByRole('heading', { name: 'Bot Tools' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Modules' })).toBeTruthy();
    // chat.access / report.generate / months.unlock match no prefix; the last
    // group is the remainder so they cannot fall off the screen unlisted.
    expect(screen.getByRole('heading', { name: 'Features' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Chat · access' })).toBeTruthy();
  });

  test('without the write permission the controls are visible but write nothing', async () => {
    const user = userEvent.setup();
    mockApi([]);
    renderPanel(false);

    const group = await openControl(user);
    await user.click(within(group).getByRole('radio', { name: 'Allow' }));

    // Asserted as BEHAVIOUR, not as a `disabled` attribute: the attribute lives
    // on the <fieldset> and never reaches the input in the DOM, so checking for
    // it would pass on a control that happily fires anyway.
    expect(apiMock.mock.calls.some(([, init]) => init !== undefined)).toBe(false);
  });
});
