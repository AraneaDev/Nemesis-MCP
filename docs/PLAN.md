# Nemesis-MCP — Implementation Plan (v0.1)

Companion to `docs/SPEC.md`. Ordering is dependency-driven; each phase ends in a
verifiable state. Every phase that changes code lands as its own commit
(authored as **AraneaDev**, no attribution/Co-Authored-By lines).

## Tech Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Language | TypeScript (Node ≥ 20, ESM) | MCP TS SDK, tree-sitter web runtime, single binary for CLI+server |
| Parsing | `web-tree-sitter` + `tree-sitter-wasms` | Prebuilt per-grammar WASM, no native builds, no CLI; lazy-load per language, skip gracefully |
| MCP | `@modelcontextprotocol/sdk` `registerTool` + zod | Current API; tools, stdio transport |
| Suggestion engine | none (v0.1) | Heuristic `did-you-mean` fallback per spec §5 |
| Testing | `vitest` | Fixture-driven + unit; fast, TS-native |
| Schema | zod (shared with MCP) | One validation language for tool params + JSON out |

## Repo Layout

```
package.json            bin: { nemesis, nemesis-mcp }, scripts
tsconfig.json
.gitignore              includes docs/superpowers
docs/SPEC.md  PLAN.md
src/
  core/
    types.ts            SymbolGraph, TestDouble, Finding, Severity, options
    discovery.ts        test-vs-production file classification (§7)
    symbolGraph.ts      graph construction + resolution (extends/impl/uses)
    resolver.ts         target resolution + did-you-mean suggestions
    analyzer.ts         four violation classifiers → findings
    report.ts           summary + ordering, exit-code mapping
    runtime.ts          shared engine bootstrap (walk, index, extract, analyze)
    ignore.ts           gitignore-lite excludes (node_modules, vendor, dist…)
  parser/
    loader.ts           web-tree-sitter + grammar WASM lazy cache, query runner
    queries.ts          per-language tree-sitter query strings
  extractors/
    ts/                 index.ts (production), doubles.ts (vitest/jest)
    php/                index.ts, doubles.ts (PHPUnit/Mockery/Pest)
    python/             index.ts, doubles.ts (unittest.mock/pytest-mock)
    rust/               index.ts, doubles.ts (mockall/automock — experimental)
  fixtures/             stale JSON/YAML fixture checker (tool 3)
  cli/                  arg parsing, text/JSON rendering, exit codes
  mcp/                  server.ts (3 tools), zod schemas
test/
  fixtures/             mini repos: ts/, php/, python/, rust/, fixtures-data/
  unit/                 resolver, analyzer, discovery
  e2e/                  CLI JSON runs, exit codes
  mcp.smoke.test.ts     stdio server smoke test
```

## Phases

### Phase 0 — Scaffold

- `package.json` (deps: web-tree-sitter, tree-sitter-wasms, @modelcontextprotocol/sdk, zod, yaml, vitest; dev: typescript, @types/node, tsx).
- `tsconfig.json`, `.gitignore` (+ `docs/superpowers/`), npm install.
- **Verify:** `tsc --noEmit` passes on empty barrel.

### Phase 1 — Core types + parsing infra

- `core/types.ts`, `parser/loader.ts` (lazy WASM loader + query helper),
  `parser/queries.ts` stubs, `core/ignore.ts`, `core/discovery.ts`.
- **Verify:** loader parses a TS/PHP/PY/RS snippet in vitest.

### Phase 2 — Symbol graph + resolver

- Production indexers per language building `SymbolGraph`
  (classes/interfaces/traits/enums/functions/methods, params with defaults/
  variadics/promoted props, return types, extends/implements/uses edges).
- `core/resolver.ts` with qualified + short-name resolution, ancestor walk,
  similarity-ranked suggestions.
- **Verify:** unit tests: resolve `App\PaymentGateway::chargeWithToken`,
  interface-through-implementation, unknown → did-you-mean.

### Phase 3 — Double extractors (four languages)

- TS: `vi.spyOn|jest.spyOn`, `vi.fn|jest.fn` with `as Foo`/`: Foo`, inline stub
  objects in `Object.assign`, component props, `mockReturnValue(…)`,
  `mockResolvedValue(…)` vs `Promise<T>`, `mockImplementation` returns,
  `toBeCalledWith`/`toHaveBeenCalledWith` arity (definite when spy target known).
- PHP: `createMock/createStub/getMockBuilder`, `Mockery::mock`,
  `expects()->method('x')`, `->method('x')->willReturn/Map/Callback`,
  `with(…)` arity.
- Python: `mocker.patch('x.y.z')`, `patch.object`, `mock.patch`,
  `Mock(spec=X)`, `create_autospec(X)`, `return_value=` return drift,
  `assert_called_with` arity.
- Rust: `#[automock]` traits, `mock!` blocks, expect-method contract checks.
- **Verify:** extractor unit tests per language over fixture files.

### Phase 4 — Analyzer + reporting

- Four classifiers per spec §5, confidence + suppression
  (`nemesis-ignore`), severity mapping, deterministic ordering, exit codes.
- **Verify:** unit tests per violation type; suppression test.

### Phase 5 — CLI + runtime

- `nemesis audit|verify-symbol|fixtures` with `--json`, `--strictness`,
  `--include/--exclude`, `--lang`; text render + exit codes 0/1/2.
- **Verify:** e2e runs against `test/fixtures/*` with asserted JSON payloads.

### Phase 6 — Fixtures tool (`nemesis_stale_fixtures`)

- JSON/YAML fixture → nearest DTO/class shape; missing required fields,
  removed fields, did-you-mean renames.
- **Verify:** fixture-data tests.

### Phase 7 — MCP server

- `nemesis-mcp --serve` over stdio; registerTool × 3 with zod schemas; shared
  runtime with CLI.
- **Verify:** stdio smoke test (list tools + audit call).

### Phase 8 — Docs + hardening + commits

- README (usage, tool docs, agent workflows incl. Chaos/Momus CI slot), tune
  per-file budget, full test run.
- Commits (each phase = one commit):
  1. `chore: scaffold project with gitignore, package and docs`
  2. `feat: core symbol graph, drift analyzer and tree-sitter runtime`
  3. `feat: language extractors for ts, php, python and rust test doubles`
  4. `feat: cli and mcp server with audit, verify-symbol and fixtures tools`
  5. `test: fixture suites and end-to-end coverage`
  (Adjust boundaries as implementation dictates; keep messages attribution-free.)

## Risk Register

| Risk | Mitigation |
| --- | --- |
| web-tree-sitter WASM loading quirks | Lazy per-grammar cache; fallback skip + notice (spec §9) |
| Query API version drift across grammars | Central `queries.ts`, defensive cursor walking instead of raw captures where fragile |
| Mockery/PHPUnit fluent chains | Cursor-based chain walker, not regex |
| Rust macro parsing variance | Experimental tier; failures skip silently with count |
| MCP SDK minor API shifts | Pin exact version; single `mcp/server.ts` surface |
