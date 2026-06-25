import * as React from 'react';
import { SubmitButton } from '@skaly/web';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{ background: '#141417', padding: 24, borderRadius: 12, maxWidth: 380 }}
    >
      {children}
    </div>
  );
}

export function Default() {
  return (
    <Frame>
      <SubmitButton>Submit request</SubmitButton>
    </Frame>
  );
}

export function Loading() {
  return (
    <Frame>
      <SubmitButton loading>Submitting…</SubmitButton>
    </Frame>
  );
}

export function Disabled() {
  return (
    <Frame>
      <SubmitButton disabled>Submit request</SubmitButton>
    </Frame>
  );
}
