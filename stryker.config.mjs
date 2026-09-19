// StrykerJS configuration for mutation testing.
//
// Named `stryker.config.mjs` on purpose: chaos-mcp discovers this name in an
// audited workspace and uses it as the base of the config it generates, so the
// MCP tool and a local `npm run mutation` run agree on how tests are selected.
//
// Two constraints are load-bearing.
//
// 1. vitest is pinned to 4.x. Against vitest 5, @stryker-mutator/vitest-runner
//    10 never activates a mutant inside a function body: only module-level
//    constants die, every other mutant comes back "Survived" having run zero
//    tests, and the score reads 2% where it should read 60%. The runner
//    dev-depends on vitest 4.1.x, which is the combination that works.
//
// 2. Tests run from `vitest.mutation.config.ts`, which excludes the suites that
//    spawn a subprocess. Those escape the sandbox and grade the unmutated
//    original, and with related-mode off they fail the dry run outright.
//
// `mutate` is empty so a bare run is a no-op rather than an unbounded sweep;
// pass a target explicitly:
//
//   npm run mutation -- src/core/ignore.ts
export default {
  // TypeScript 7 removed `ts.parseConfigFileTextToJson`, which Stryker's
  // tsconfig preprocessor calls. Nothing here needs that rewrite, so point it
  // at a name that does not exist and the preprocessor stands down.
  tsconfigFile: 'tsconfig.stryker-absent.json',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  coverageAnalysis: 'perTest',
  mutate: [],
  reporters: ['clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
  concurrency: 2,
};
