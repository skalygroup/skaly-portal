import * as React from 'react';
import { Button } from '@skaly/web';

// Portal is dark-only — render on a dark brand surface with the `.dark` class
// so the shadcn tokens resolve to their dark-theme values (see conventions).
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{
        background: '#141417',
        padding: 24,
        borderRadius: 12,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  );
}

export function Variants() {
  return (
    <Frame>
      <Button>Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="outline">Export CSV</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">Learn more</Button>
    </Frame>
  );
}

export function Sizes() {
  return (
    <Frame>
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </Frame>
  );
}

export function Disabled() {
  return (
    <Frame>
      <Button disabled>Saving…</Button>
      <Button variant="outline" disabled>
        Export CSV
      </Button>
      <Button variant="secondary" disabled>
        Cancel
      </Button>
    </Frame>
  );
}
