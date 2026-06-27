import * as React from 'react';

/**
 * Decorative full-bleed backdrop for the auth canvas (signup redesign) — a
 * gold aurora wash plus a masked dot grid. Purely decorative; pointer-events
 * off. Ported from the Claude Design signup template.
 */
export function AuthBackdrop({ variant = 'aurora' }: { variant?: 'aurora' | 'grid' | 'minimal' }) {
  const layer = (style: React.CSSProperties) => (
    <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', ...style }} />
  );

  const aurora = layer({
    background:
      'radial-gradient(120% 90% at 6% 2%, rgba(253,194,87,0.15) 0%, rgba(253,194,87,0) 42%),' +
      'radial-gradient(90% 70% at 100% 0%, rgba(253,194,87,0.06) 0%, rgba(253,194,87,0) 48%),' +
      'radial-gradient(130% 100% at 50% 118%, rgba(253,194,87,0.05) 0%, rgba(253,194,87,0) 55%)',
  });
  const grid = (opacity: number, size: string) =>
    layer({
      backgroundImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
      backgroundSize: `${size} ${size}`,
      opacity,
      WebkitMaskImage: 'radial-gradient(120% 100% at 50% 0%, #000 0%, transparent 75%)',
      maskImage: 'radial-gradient(120% 100% at 50% 0%, #000 0%, transparent 75%)',
    });

  if (variant === 'minimal') {
    return layer({
      background: 'radial-gradient(100% 80% at 50% 0%, rgba(253,194,87,0.08) 0%, rgba(253,194,87,0) 55%)',
    });
  }
  if (variant === 'grid') {
    return (
      <>
        {layer({ background: 'radial-gradient(110% 80% at 8% 0%, rgba(253,194,87,0.08) 0%, rgba(253,194,87,0) 45%)' })}
        {grid(1, '24px')}
      </>
    );
  }
  return (
    <>
      {aurora}
      {grid(1, '26px')}
    </>
  );
}
