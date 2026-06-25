import * as React from 'react';
import { TextField } from '@skaly/web';

// Auth form surface is the dark bg-surface; fields are full-width in a column.
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

const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 5L2 7" />
  </svg>
);

export function Default() {
  return (
    <Frame>
      <TextField label="Full name" placeholder="Jane Doe" />
    </Frame>
  );
}

export function WithIcon() {
  return (
    <Frame>
      <TextField label="Email" type="email" icon={<MailIcon />} defaultValue="jane@skalygroup.com" />
    </Frame>
  );
}

export function WithHint() {
  return (
    <Frame>
      <TextField
        label="Mobile number"
        type="tel"
        defaultValue="+91 98765 43210"
        hint="Include your country code, e.g. +91 for India."
      />
    </Frame>
  );
}

export function WithError() {
  return (
    <Frame>
      <TextField label="Email" type="email" defaultValue="jane@@bad" error="Invalid email" />
    </Frame>
  );
}

export function Disabled() {
  return (
    <Frame>
      <TextField label="Email" value="jane@skalygroup.com" readOnly disabled />
    </Frame>
  );
}
