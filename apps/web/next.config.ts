import type { NextConfig } from 'next';

const r2PublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL;
const r2Hostname = r2PublicUrl ? new URL(r2PublicUrl).hostname : null;

const config: NextConfig = {
  reactStrictMode: true,
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
