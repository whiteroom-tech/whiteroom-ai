import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// .mts, not .ts: package.json has no "type": "module", so a .ts config is
// loaded as CommonJS and Vite warns about the ESM syntax in it.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@/*" path in tsconfig.json. Without it, any test that
      // pulls in a module importing through the alias fails at import time.
      '@': fileURLToPath(new URL('./src', import.meta.url)),

      // `server-only` ships a throwing index.js and an empty react-server
      // build, picked between by an export condition Next sets and vitest
      // doesn't — so importing it under test fails with "cannot be imported
      // from a Client Component". Point at the empty build directly. The
      // guard still does its job where it matters: `next build` resolves the
      // real package and fails on a client import.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
