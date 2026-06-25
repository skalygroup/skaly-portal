// next/link shim for the design-sync bundle: renders a plain <a>.
import * as React from 'react';

type Props = {
  href?: string | { pathname?: string };
  children?: React.ReactNode;
  [key: string]: unknown;
};

export default function Link({ href, children, ...rest }: Props) {
  const h = typeof href === 'string' ? href : href?.pathname ?? '#';
  return (
    <a href={h} {...rest}>
      {children}
    </a>
  );
}
