import type { NextConfig } from 'next';

const r2PublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
const r2Hostname = r2PublicUrl ? new URL(r2PublicUrl).hostname : null;

const config: NextConfig = {
  reactStrictMode: true,
  // @skaly/shared is symlinked from the monorepo. transpilePackages routes it
  // through Next's transform, but only if webpack keeps the node_modules path.
  transpilePackages: ['@skaly/shared'],
  webpack: (webpackConfig) => {
    // Don't resolve the symlink to its real path (outside node_modules).
    // Otherwise Next treats the compiled CommonJS as first-party source and
    // injects the Fast Refresh footer (import.meta.webpackHot) it can't parse,
    // and transpilePackages fails to match. Keeping the node_modules path fixes
    // both.
    webpackConfig.resolve.symlinks = false;
    return webpackConfig;
  },
  images: {
    remotePatterns: [
      // R2 presigned URL host — added automatically when NEXT_PUBLIC_R2_PUBLIC_URL is set
      ...(r2Hostname
        ? [{ protocol: 'https' as const, hostname: r2Hostname }]
        : []),
    ],
  },
  experimental: {
    // Reserve for future use
  },
};

export default config;
