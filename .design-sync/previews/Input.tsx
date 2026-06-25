import * as React from 'react';
import { Input, Label } from '@skaly/web';

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

export function Default() {
  return (
    <Frame>
      <Input placeholder="you@skalygroup.com" />
    </Frame>
  );
}

export function WithLabel() {
  return (
    <Frame>
      <div style={{ display: 'grid', gap: 8 }}>
        <Label htmlFor="client">Client name</Label>
        <Input id="client" defaultValue="Acme Studios" />
      </div>
    </Frame>
  );
}

export function Types() {
  return (
    <Frame>
      <Input type="email" placeholder="Email address" />
      <Input type="password" defaultValue="supersecret" />
      <Input type="date" />
    </Frame>
  );
}

export function States() {
  return (
    <Frame>
      <Input placeholder="Disabled" disabled />
      <Input defaultValue="Invalid value" aria-invalid />
    </Frame>
  );
}
