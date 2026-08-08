'use client';

// The Bot module's error boundary (09-ERROR-HANDLING §5.2).
//
// One `error.tsx` per route segment IS the isolation: Next wraps this segment's
// subtree and nothing else, so a throw in Bot cannot take any other module down.
import { ModuleError } from '@/components/shared/module-error';

export default function BotError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ModuleError module="Bot" {...props} />;
}
