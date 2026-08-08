'use client';

// The Content Dropper module's error boundary (09-ERROR-HANDLING §5.2).
//
// One `error.tsx` per route segment IS the isolation: Next wraps this segment's
// subtree and nothing else, so a throw in Content Dropper cannot take any other module down.
import { ModuleError } from '@/components/shared/module-error';

export default function ContentDropperError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ModuleError module="Content Dropper" {...props} />;
}
