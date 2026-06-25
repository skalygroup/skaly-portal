import * as React from 'react';
import { FormBanner } from '@skaly/web';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{ background: '#141417', padding: 24, borderRadius: 12, maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      {children}
    </div>
  );
}

export function Error() {
  return (
    <Frame>
      <FormBanner variant="error">Email or password is incorrect.</FormBanner>
    </Frame>
  );
}

export function Info() {
  return (
    <Frame>
      <FormBanner variant="info">Your request is under review — we&apos;ll email you.</FormBanner>
    </Frame>
  );
}

export function Success() {
  return (
    <Frame>
      <FormBanner variant="success">Your account is ready. Redirecting…</FormBanner>
    </Frame>
  );
}
