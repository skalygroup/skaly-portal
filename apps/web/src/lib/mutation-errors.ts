import { toast } from 'sonner';

import { ApiError } from '@/lib/api';

/**
 * One place that turns a failed mutation's ApiError into the right toast, and
 * hands structured detail back to the caller for inline UI (09-ERROR-HANDLING
 * §5.1). Used by every task mutation (Sprint 4 Step 7).
 *
 * NOTE (ADR-008): tasks are unversioned, so there is deliberately NO STALE_DATA
 * branch here — a task PATCH can never return 409. The default branch covers any
 * unexpected code without a task-specific stale-conflict UI.
 */
export interface DependencyTask {
  id: string;
  description: string;
  status: string;
}

export interface MutationErrorResult {
  code: string;
  /** Present for DEPENDENCY_UNRESOLVED — drives the "Blocked by" badge + chip shake. */
  dependencyTask?: DependencyTask;
}

export function handleMutationError(err: unknown, fallback = 'Something went wrong. Please try again.'): MutationErrorResult {
  if (!(err instanceof ApiError)) {
    toast.error(fallback);
    return { code: 'UNKNOWN' };
  }

  switch (err.code) {
    case 'DEPENDENCY_UNRESOLVED': {
      const dep = err.details?.dependencyTask as DependencyTask | undefined;
      toast.warning(
        dep ? `Blocked by an unresolved dependency: ${dep.description}` : 'This task is blocked by an unresolved dependency.',
      );
      return { code: err.code, dependencyTask: dep };
    }
    case 'VALIDATION_ERROR':
      // The dependency-cycle rejection surfaces here with its message.
      toast.error(err.message || 'That change is not allowed.');
      return { code: err.code };
    case 'PERIOD_LOCKED':
      toast.error('This period is locked. Changes are disabled.');
      return { code: err.code };
    case 'PERMISSION_DENIED':
      toast.error("You don't have permission to make that change.");
      return { code: err.code };
    default:
      toast.error(err.message || fallback);
      return { code: err.code };
  }
}
