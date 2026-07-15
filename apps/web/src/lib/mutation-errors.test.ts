// @vitest-environment node
// Logic test: handleMutationError routes each ApiError code to the right toast
// and hands back the structured detail the grid needs (the dependency task that
// drives the "Blocked by" badge + chip shake on a DEPENDENCY_UNRESOLVED reject).
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { handleMutationError } from '@/lib/mutation-errors';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
// api.ts imports the browser Supabase client at module load; stub it so importing
// ApiError in a node test never initialises Supabase.
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

afterEach(() => vi.clearAllMocks());

describe('handleMutationError', () => {
  it('DEPENDENCY_UNRESOLVED → warning toast + returns the dependency task', () => {
    const dep = { id: 'd1', description: 'Shoot the reel', status: 'In Progress' };
    const err = new ApiError(400, 'DEPENDENCY_UNRESOLVED', 'blocked', { dependencyTask: dep });

    const res = handleMutationError(err);

    expect(res).toEqual({ code: 'DEPENDENCY_UNRESOLVED', dependencyTask: dep });
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR (cycle) → error toast with the message', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'This dependency would create a cycle');
    const res = handleMutationError(err);
    expect(res.code).toBe('VALIDATION_ERROR');
    expect(toast.error).toHaveBeenCalledWith('This dependency would create a cycle');
  });

  it('PERIOD_LOCKED → error toast', () => {
    handleMutationError(new ApiError(423, 'PERIOD_LOCKED', 'locked'));
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it('an unknown ApiError code still surfaces a toast', () => {
    const res = handleMutationError(new ApiError(500, 'WEIRD', 'boom'));
    expect(res.code).toBe('WEIRD');
    expect(toast.error).toHaveBeenCalled();
  });

  it('a non-ApiError falls back to a generic toast', () => {
    const res = handleMutationError(new Error('network'));
    expect(res.code).toBe('UNKNOWN');
    expect(toast.error).toHaveBeenCalled();
  });
});
