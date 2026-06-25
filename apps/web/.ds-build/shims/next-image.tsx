// next/image shim for the design-sync bundle: renders a plain <img> so the
// component bundles + previews outside Next. Strips Next-only props that a
// native <img> would warn on. Supports both string src and static imports.
import * as React from 'react';
// Inline known public/ assets the bundled components reference by absolute URL
// (those paths 404 in the preview/design environment since there's no Next
// server). esbuild's png/svg loaders turn these imports into data URIs.
import skalyLogo from '../../public/brand/skaly-logo.png';

const PUBLIC_ASSETS: Record<string, string> = {
  '/brand/skaly-logo.png': skalyLogo as unknown as string,
};

type Props = {
  src: string | { src?: string; default?: { src?: string } };
  alt?: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
  // Next-only props — accepted then dropped:
  priority?: boolean;
  unoptimized?: boolean;
  fill?: boolean;
  quality?: number;
  placeholder?: string;
  loader?: unknown;
  sizes?: string;
  [key: string]: unknown;
};

export default function Image(props: Props) {
  const {
    src,
    alt = '',
    priority,
    unoptimized,
    fill,
    quality,
    placeholder,
    loader,
    style,
    ...rest
  } = props;
  const raw =
    typeof src === 'string' ? src : src?.src ?? src?.default?.src ?? '';
  const resolved = PUBLIC_ASSETS[raw] ?? raw;
  const fillStyle: React.CSSProperties | undefined = fill
    ? { position: 'absolute', inset: 0, width: '100%', height: '100%', ...style }
    : style;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} alt={alt} style={fillStyle} {...rest} />;
}
