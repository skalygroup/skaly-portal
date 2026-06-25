import * as React from 'react';
import { BrandPanel } from '@skaly/web';

// BrandPanel is the full-height left side of the auth split-screen. It ships
// its own dark field + tokens, so no wrapper theme is needed — just give it a
// tall frame to fill (it uses h-full).
export function Default() {
  return (
    <div
      style={{
        width: 560,
        height: 620,
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <BrandPanel />
    </div>
  );
}
