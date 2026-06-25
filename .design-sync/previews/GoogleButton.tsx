import * as React from 'react';
import { GoogleButton } from '@skaly/web';

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
      <GoogleButton>Continue with Google</GoogleButton>
    </Frame>
  );
}

export function Loading() {
  return (
    <Frame>
      <GoogleButton loading>Continue with Google</GoogleButton>
    </Frame>
  );
}
