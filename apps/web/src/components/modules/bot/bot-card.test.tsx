import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BotCard } from './bot-card';

import type { BotCard as BotCardPayload } from './chat-state';

/**
 * The confirmation + result cards (Sprint 9 STEP 10, ADR-014).
 *
 * The rule these tests defend: the card is DISPLAY + DISPATCH. It renders exactly
 * what the server sent and posts back only a confirmationId — so the assertions are
 * about what reaches the screen and what reaches the callback, never about the card
 * computing anything.
 */
afterEach(cleanup);

const summary = {
  action: 'Mark task as Done',
  entity: 'Task',
  target: 'Edit the Naaz Furniture reel',
  period: '2026-07',
  changes: [
    { field: 'Status', from: 'In Progress', to: 'Done' },
    { field: 'Deadline', from: '—', to: '14 Aug 2026' },
  ],
};

const CONFIRMATION_ID = '11111111-1111-4111-8111-111111111111';

const confirmationPayload = (over: Partial<BotCardPayload> = {}): BotCardPayload => ({
  type: 'confirmation',
  confirmationId: CONFIRMATION_ID,
  toolName: 'update_task_status',
  summary,
  ...over,
});

describe('ConfirmationCard', () => {
  test('renders the server summary verbatim, including every changes row', () => {
    render(<BotCard payload={confirmationPayload()} actionable />);

    expect(screen.getByText('Mark task as Done')).toBeDefined();
    expect(screen.getByText(/Task · Edit the Naaz Furniture reel · 2026-07/)).toBeDefined();

    // Every row, both sides. A card that dropped one would be asking for consent to
    // a change the user cannot see.
    for (const row of summary.changes) {
      expect(screen.getByText(row.field), row.field).toBeDefined();
      expect(screen.getByText(row.from), row.from).toBeDefined();
      expect(screen.getByText(row.to), row.to).toBeDefined();
    }
  });

  test('Confirm dispatches the decision with the confirmationId — and nothing else', async () => {
    const onDecision = vi.fn();
    render(<BotCard payload={confirmationPayload()} actionable onDecision={onDecision} />);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('confirm', CONFIRMATION_ID);
  });

  test('Cancel dispatches cancel with the same id', async () => {
    const onDecision = vi.fn();
    render(<BotCard payload={confirmationPayload()} actionable onDecision={onDecision} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('cancel', CONFIRMATION_ID);
  });

  test('a resolved card shows the outcome and both buttons are disabled', () => {
    render(<BotCard payload={confirmationPayload({ resolved: 'confirm' })} actionable />);

    expect(screen.getByRole('button', { name: 'Confirmed' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
  });

  test('a cancelled card reads Cancelled', () => {
    render(<BotCard payload={confirmationPayload({ resolved: 'cancel' })} actionable />);
    expect(screen.getByRole('button', { name: 'Cancelled' })).toHaveProperty('disabled', true);
  });

  test('a card that is no longer the last message is inert', async () => {
    // This is the derived-state rule: any newer turn — including a typed "yes" the
    // card never saw — moves it off the end and the buttons stop working.
    const onDecision = vi.fn();
    render(<BotCard payload={confirmationPayload()} actionable={false} onDecision={onDecision} />);

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.click(confirm);
    expect(onDecision).not.toHaveBeenCalled();
  });

  test('a payload with no confirmationId cannot be actioned', async () => {
    const onDecision = vi.fn();
    render(<BotCard payload={confirmationPayload({ confirmationId: undefined })} actionable onDecision={onDecision} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onDecision).not.toHaveBeenCalled();
  });

  test('a summary with no changes still renders its headline', () => {
    render(<BotCard payload={confirmationPayload({ summary: { ...summary, changes: [] } })} actionable />);
    expect(screen.getByText('Mark task as Done')).toBeDefined();
  });

  test('the period is omitted when the server did not send one', () => {
    const { action, entity, target, changes } = summary;
    render(
      <BotCard payload={confirmationPayload({ summary: { action, entity, target, changes } })} actionable />,
    );
    expect(screen.getByText(/Task · Edit the Naaz Furniture reel/).textContent).not.toContain('·  ·');
  });
});

describe('MutationResultCard', () => {
  test('renders the outcome and a deep link', () => {
    render(
      <BotCard
        payload={{
          type: 'mutation_result',
          summary,
          link: '/tasks?period=2026-07&highlight=abc',
        }}
      />,
    );
    expect(screen.getByText(/Mark task as Done/)).toBeDefined();
    const link = screen.getByRole('link', { name: 'View' });
    expect(link.getAttribute('href')).toBe('/tasks?period=2026-07&highlight=abc');
  });

  test('renders without a link when the payload has none', () => {
    render(<BotCard payload={{ type: 'mutation_result', summary }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Mark task as Done/)).toBeDefined();
  });
});

describe("Sprint 8's fallback rule is unchanged", () => {
  test('an unknown card type renders nothing — the streamed text stands alone', () => {
    const { container } = render(<BotCard payload={{ type: 'something_new_in_sprint_12' }} />);
    expect(container.firstChild).toBeNull();
  });

  test('a query card still renders after the registry gained two entries', () => {
    render(<BotCard payload={{ type: 'task_list', tasks: [{ description: 'A task', status: 'To Do' }] }} />);
    expect(screen.getByText('A task')).toBeDefined();
  });
});
