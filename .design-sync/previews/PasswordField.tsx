import * as React from 'react';
import { PasswordField } from '@skaly/web';

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
      <PasswordField
        label="Password"
        placeholder="Create a password"
        defaultValue="Sk@ly2026!"
        hint="At least 10 characters, with upper & lower case, a digit, and a symbol."
      />
    </Frame>
  );
}

export function WithError() {
  return (
    <Frame>
      <PasswordField
        label="Password"
        defaultValue="weak"
        error="Password needs an uppercase, a lowercase, a digit, and a special character"
      />
    </Frame>
  );
}
