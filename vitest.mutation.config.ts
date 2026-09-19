import { defineConfig } from 'vitest/config';

// Mutation testing runs each mutant inside a sandbox copy of the repo. Tests
// that spawn a subprocess (the CLI e2e shells out to `npx tsx`, the MCP smoke
// test spawns a stdio server) escape that sandbox and grade the unmutated
// original, so they are excluded here.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'fixtures/**', 'dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
