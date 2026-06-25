import * as React from 'react';
import { DateField } from '@skaly/web';

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
      <DateField label="Date of birth" defaultValue="1995-05-20" />
    </Frame>
  );
}

export function Empty() {
  return (
    <Frame>
      <DateField label="Date of birth" />
    </Frame>
  );
}

export function WithError() {
  return (
    <Frame>
      <DateField label="Date of birth" error="Invalid date" />
    </Frame>
  );
}
