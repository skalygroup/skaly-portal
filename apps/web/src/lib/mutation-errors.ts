import { toast } from 'sonner';

import { ApiError } from '@/lib/api';

/**
 * One place that turns a failed mutation's ApiError into the right toast, and
 * hands structured detail back to the caller for inline UI (09-ERROR-HANDLING
 * §5.1). Used by every task mutation (Sprint 4 Step 7).
 *
 * NOTE (ADR-008): tasks + shoot slots are unversioned, so those callers never
 * hit STALE_DATA. Content pipelines ARE versioned (C-02) — the STALE_DATA branch
 * below routes the conflict detail back for the caller's inline "Refresh row" UI
 * (no disruptive toast; the inline banner is the message).
 */
export interface DependencyTask {
  id: string;
  description: string;
  status: string;
}

export interface StaleData {
  currentVersion: number;
  updatedBy: { staffId: string; name: string | null } | null;
}

export interface MutationErrorResult {
  code: string;
  /** Present for DEPENDENCY_UNRESOLVED — drives the "Blocked by" badge + chip shake. */
  dependencyTask?: DependencyTask;
  /** Present for STALE_DATA (versioned tables) — drives the inline "Updated by … — Refresh row" UI. */
  staleData?: StaleData;
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
    case 'STAGE_SEQUENCE_VIOLATION':
      // Belt-and-braces: the client pre-check normally blocks this before the
      // request, but a race can still land it here. Toast; the caller shakes.
      toast.error(err.message || 'Complete the previous stage first.');
      return { code: err.code };
    case 'STALE_DATA': {
      // Inline conflict UI shows the message — no toast here.
      const updatedBy = (err.details?.updatedBy as StaleData['updatedBy']) ?? null;
      return {
        code: err.code,
        staleData: { currentVersion: Number(err.details?.currentVersion ?? 0), updatedBy },
      };
    }
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
