import * as React from 'react';
import { useForm } from 'react-hook-form';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  Input,
  Button,
} from '@skaly/web';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{
        background: '#141417',
        padding: 24,
        borderRadius: 12,
        maxWidth: 400,
      }}
    >
      {children}
    </div>
  );
}

// The shadcn Form stack: react-hook-form context + FormField/FormItem/
// FormLabel/FormControl/FormDescription/FormMessage composed into a real form.
export function ProfileForm() {
  const form = useForm({
    defaultValues: { displayName: 'Aisha Khan', email: 'aisha@skalygroup.com' },
  });
  return (
    <Frame>
      <Form {...form}>
        <form style={{ display: 'grid', gap: 18 }}>
          <FormField
            control={form.control}
            name="displayName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input placeholder="Your name" {...field} />
                </FormControl>
                <FormDescription>Shown to your team across the portal.</FormDescription>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Work email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="you@skalygroup.com" {...field} />
                </FormControl>
              </FormItem>
            )}
          />
          <Button type="submit">Save profile</Button>
        </form>
      </Form>
    </Frame>
  );
}

// FormMessage rendering a validation error (error state pre-seeded).
export function WithError() {
  const form = useForm({ defaultValues: { email: 'not-an-email' } });
  React.useEffect(() => {
    form.setError('email', { message: 'Enter a valid email address.' });
  }, [form]);
  return (
    <Frame>
      <Form {...form}>
        <form style={{ display: 'grid', gap: 18 }}>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Work email</FormLabel>
                <FormControl>
                  <Input type="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
    </Frame>
  );
}
