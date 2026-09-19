import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture repos under fixtures/ are static-analysis inputs, not runnable tests.
    exclude: ['**/node_modules/**', 'fixtures/**', 'dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // Keep the gate focused on deterministic, directly unit-tested core helpers.
      // CLI/MCP subprocesses are intentionally covered by e2e assertions instead.
      include: ['src/core/ignore.ts', 'src/core/report.ts', 'src/core/symbolGraph.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 77,
        statements: 90,
      },
    },
  },
});
