import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
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
