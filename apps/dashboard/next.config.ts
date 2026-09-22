import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      ],
    },
    {
      source: '/api/:path*',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: 'https://app.whiteroom.tech' },
        { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
        { key: 'Access-Control-Allow-Headers', value: 'Content-Type, x-fleet-token' },
        { key: 'Access-Control-Max-Age', value: '86400' },
      ],
    }];
  },
  // @whiteroom/ui ships raw .ts/.tsx source over a local file: link, so Next
  // has to transpile it rather than treat it as pre-built node_modules code.
  transpilePackages: ['@whiteroom/ui'],
  // This repo has no root package.json, so Turbopack would otherwise infer the
  // project root as apps/dashboard and refuse to resolve the sibling
  // packages/ui. Point it at the repo root so the file: link resolves.
  turbopack: {
    root: path.join(__dirname, '..', '..'),
  },
  // Same reasoning as turbopack.root, but for the production build's file
  // tracer (used by output: 'standalone' to bundle only what's needed).
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
};

export default nextConfig;
