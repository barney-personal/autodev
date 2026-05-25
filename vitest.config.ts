import { defineConfig } from 'vitest/config';
import path from 'path';

// Hermetic test env: strip inherited auth/provider tokens before workers spawn
// so `npm test` behaves the same in a developer shell, CI, and an orchestrator
// agent that may have AUTH_TOKEN / ANTHROPIC_API_KEY / GITHUB_PERSONAL_ACCESS_TOKEN
// set for the running server.
delete process.env.AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
// React Testing Library requires React's dev/test build; force it even if the
// caller shell has NODE_ENV=production.
process.env.NODE_ENV = 'test';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts', 'src/test/**/*.test.tsx'],
    // Each test file gets a fresh module graph so singleton state doesn't leak
    isolate: true,
    // node:sqlite requires this flag (vitest v4 top-level config)
    execArgv: ['--experimental-sqlite'],
    coverage: {
      provider: 'v8',
      include: ['src/client/**/*.{ts,tsx}'],
      exclude: [
        'src/client/main.tsx',
        'src/client/index.html',
        'src/client/css-modules.d.ts',
        'src/client/styles/**',
      ],
      reporter: ['text', 'text-summary', 'html'],
      thresholds: {
        statements: 20,
        branches: 15,
        functions: 15,
        lines: 20,
      },
    },
  },
});
