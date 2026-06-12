import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      // R2 presigned URL host — fill in your actual R2 endpoint host
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
    ],
  },
  experimental: {
    // Reserve for future use
  },
};

export default config;
