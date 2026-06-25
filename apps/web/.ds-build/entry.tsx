// design-sync bundle entry — re-exports ONLY the scoped design-system
// components so the synth bundle never pulls in the whole Next.js app.
// Committed: re-sync rebuilds from this. Internal `@/…` and `next/image`
// imports resolve via .ds-build/tsconfig.json (tsconfigPathsPlugin).
export { Alert, AlertTitle, AlertDescription } from '../src/components/ui/alert';
export { Button, buttonVariants } from '../src/components/ui/button';
export { Input } from '../src/components/ui/input';
export { Label } from '../src/components/ui/label';
export {
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
  useFormField,
} from '../src/components/ui/form';
export { BrandPanel } from '../src/components/auth/brand-panel';
