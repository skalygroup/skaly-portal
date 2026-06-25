import * as React from 'react';
import { Label, Input } from '@skaly/web';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dark"
      style={{
        background: '#141417',
        padding: 24,
        borderRadius: 12,
        display: 'grid',
        gap: 16,
        maxWidth: 360,
      }}
    >
      {children}
    </div>
  );
}

// Label is almost always paired with a field — the canonical usage.
export function WithInput() {
  return (
    <Frame>
      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="email">Work email</Label>
        <Input id="email" type="email" placeholder="you@skalygroup.com" />
      </div>
    </Frame>
  );
}

export function WithCheckbox() {
  return (
    <Frame>
      <Label>
        <input type="checkbox" defaultChecked />
        Send me a daily attendance summary
      </Label>
    </Frame>
  );
}

export function Standalone() {
  return (
    <Frame>
      <Label>Project status</Label>
    </Frame>
  );
}
