import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    // Each test file gets a fresh module graph so singleton state doesn't leak
    isolate: true,
    // node:sqlite requires this flag (vitest v4 top-level config)
    execArgv: ['--experimental-sqlite'],
  },
});
