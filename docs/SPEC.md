# Nemesis-MCP — Specification

> *"Een stub voor een methode die allang niet meer bestaat, slaagt ook."*
> (A stub for a method that no longer exists also passes.)

**Version:** 1.0 — Status: approved scope for v0.1

---

## 1. Problem

AI coding agents lean on unit tests to reach a "green" state quickly. When an agent
renames a method, changes a signature, or alters a return type, mocked unit tests
keep passing because the mock — not the production code — defines the contract.
The result is a permanently green suite guarding phantom code.

Nemesis-MCP statically inspects test doubles (mocks, stubs, spies) and checks them
against the concrete definitions in the production code. No tests are executed;
the analysis is purely syntactic and semantic-lite.

## 2. Goals & Non-Goals

### Goals

- G1 — Detect four violation classes (below) across TS/JS, PHP, Python, Rust.
- G2 — Zero-config discovery: standard test dirs + glob fallback for any layout.
- G3 — Expose the analysis as MCP tools *and* a standalone CLI (`nemesis`).
- G4 — Agent-friendly: fast (< ~2 s for 1k files, budget-based), structured JSON
  output, actionable messages ("Did you mean 'chargeWithToken'?").
- G5 — Confidence-scored findings: `definite` (block-worthy) vs `warning`
  (heuristic), with suggestion formatting that degrades gracefully without a
  suggestion engine.

### Non-Goals (v0.1)

- Running or instrumenting tests.
- Framework-specific runtime shims (e.g. intercepting Mockery at runtime).
- Non-JS hosting: MCP server ships as a Node CLI (`npx nemesis-mcp`).
- Full type-system modelling (no tsc, no Psalm; syntactic types + heuristics).
- Mutation-style dynamic validation.

## 3. Supported Ecosystems

| Ecosystem | Test frameworks | Double patterns detected | Parser | Production types |
| --- | --- | --- | --- | --- |
| TypeScript/JS | Vitest, Jest | `vi.spyOn`, `jest.spyOn`, `vi.fn()`, `jest.fn()`, `mockReturnValue`, `mockResolvedValue`, `mockImplementation`, inline object stubs, `as Foo` / `: Foo` casts | tree-sitter (typescript/tsx/javascript) | interfaces, type aliases, classes, methods, functions, enums |
| PHP | PHPUnit, Pest, Mockery | `createMock()`, `createStub()`, `$this->mock()`, `Mockery::mock()`, `expects($this->once())->method('x')`, `->method(...)->willReturn(...)`, `->method(...)->willReturnMap(...)`, `->method(...)->willReturnCallback(...)`, magic `->method('name')` method chains | tree-sitter-php | classes, interfaces, traits, enums, methods with param/return types |
| Python | pytest-mock, unittest.mock | `mocker.patch(...)`, `patch(...)`, `mock.patch.object(...)`, `patch.object(...)`, `Mock(spec=X)`, `create_autospec(X)`, `unittest.mock.Mock(spec_set=...)` | tree-sitter-python | classes, methods, functions |
| Rust | mockall, mockiato | `#[automock]` on traits, `mock! { }` blocks, double-vs-trait contract verification | tree-sitter-rust | traits, fns, structs, enums, impls |

Fixture checking (tool 3) inspects JSON and YAML fixtures against production
DTO/class/record shapes. Field extraction covers TypeScript interfaces,
type aliases/classes, PHP properties, Python class attributes, and Rust struct
fields; unsupported or ambiguous matches are reported diagnostically.

## 4. Architecture

```
┌────────────────────┐      ┌─────────────────────────┐
│ Test AST Parser    │      │ Production AST Index    │
│ (finds doubles)    │      │ (types & signatures)    │
└─────────┬──────────┘      └────────────┬────────────┘
          │                              │
          ▼                              ▼
  Double Manifest                 Symbol Manifest
  - target symbol / method        - method signature
  - argument counts/types         - parameter types & defaults
  - mocked return types           - concrete return type
          │                              │
          └──────────────┬───────────────┘
                         ▼
          ┌──────────────────────────────┐
          │      Drift Analyzer          │
          │  (four violation classes)    │
          └──────────────┬───────────────┘
                         ▼
            JSON  /  MCP tool responses  /  CLI report
```

### 4.1 Production Indexer

- Walks non-test source files (see §7 discovery rules).
- One tree-sitter parser per language; per-grammar WASM loaded lazily and cached.
- Builds a `SymbolGraph`: namespaces/classes/interfaces/traits/enums/functions,
  methods with parameter lists (name, type, default, variadic, promoted ctor
  properties) and return types, plus structural edges (extends/implements/uses).

### 4.2 Double Extractor

- Traverses test files, pattern-matching framework idioms per language via
  tree-sitter queries, producing `TestDouble` records with file/line anchors.
- Every double records: `framework`, `targetSymbol`, `method`, `arity`,
  `returnTypeHint`, `returnExpr`, `confidence`.

### 4.3 Drift Analyzer

- Resolves each double's `targetSymbol` through the `SymbolGraph` (follows
  extends/implements/uses chains up to a depth cap; unresolved → `UNRESOLVED`
  and skipped, not guessed).
- Classifies divergence into the four violation types; emits findings with
  file/line, evidence text, confidence, and optional `Did you mean …?`
  suggestions (plain heuristic when a suggestion engine is unavailable).

## 5. The Four Contract Violations

1. **`GHOST_METHOD`** — the double stubs a method that does not exist on the
   resolved target (renamed/deleted). Confidence `definite` when the target is
   resolved and has ≥1 known member; `warning` when the target has unknown
   members (dynamic `__call`, spread-typed objects, `#[allow]`-style escapes).
2. **`ARITY_MISMATCH`** — configured argument count exceeds the method's
   parameter count, or omits a required non-default parameter.
   Variadics and optional params are honoured; PHP promoted constructor
   properties count as parameters; when the target's parameter list is unknown
   (e.g. `...$args` spread in test), no finding is emitted.
3. **`RETURN_DRIFT`** — the stub's return value cannot satisfy the declared
   return type of the real method. Both sides are reduced to a canonical
   lattice first, so a `true` literal satisfies `boolean`, `bool` and `Bool`
   alike; an array literal satisfies `T[]`, `Array<T>`, `list[T]`, `Vec<T>`
   and PHP `iterable`; and a declared union, `Optional[T]`, `?T`, `Option<T>`
   or `Promise<T>` is satisfied by any of its members. Confidence drops to
   `warning` when both sides name concrete types, because the inheritance that
   would relate them lives in a dependency directory that is never walked.
4. **`VISIBILITY_BREACH`** — the double stubs a `private`/`protected` method
   directly, bypassing the public interface. Python has no access control, so
   a single leading underscore yields `warning`; only a name-mangled
   `__member` is `definite`.

A stubbed member whose name is not a literal (`shouldReceive($method)` driven
by a loop variable, an interpolated or templated name) identifies nothing that
can be checked and produces no finding at all.

**Severity:** `breaking_only` = `GHOST_METHOD`, `ARITY_MISMATCH`,
`RETURN_DRIFT`, `VISIBILITY_BREACH` (all exit-1 in CLI mode; hard-fail in CI).
`untyped_only` = violations where the relevant side (stub value or production
signature) is missing type information. `all` = everything, including
`UNRESOLVED`-adjacent soft warnings (naming-similarity hints).

**Suppression:** inline `// nemesis-ignore` / `# nemesis-ignore` comment on the
line above the match or trailing on the same line; `--ignore-rule`/`strictness`
via CLI; no config file in v0.1.

## 6. MCP Interface

Stdio MCP server (`nemesis-mcp` binary, `nemesis-mcp --serve`). Three tools:

### `nemesis_audit`

Scans the repo (or given paths) for double drift.

- Params: `paths?: string[]` (files or dirs; default = discovery rules §7),
  `strictness?: "all" | "untyped_only" | "breaking_only"` (default `breaking_only`),
  `lang?: ("typescript"|"javascript"|"php"|"python"|"rust")[]` (default all four).
- Response: `{ summary: { scanned_test_files, doubles_inspected, violations_count },
  violations: [{ file, line, endLine?, type, confidence, double_type, target,
  message, suggestion? }] }` — violations sorted file → line → type.

### `nemesis_verify_symbol`

- Params: `symbol: string` (e.g. `App\\Services\\InvoiceService`, `UserService`,
  or a short name resolved case-sensitively against the graph).
- Response: every double pointing at that symbol plus validity flags
  (`valid: true|false`), violation entries for broken ones, and the production
  signature when resolved.

### `nemesis_stale_fixtures`

- Params: `paths?: string[]`, `strictness?` as above.
- Response: violations list for JSON/YAML fixtures whose required schema fields
  no longer match current model/DTO structures (missing required fields with
  defaults, removed fields, renamed fields per heuristic `did-you-mean`).

## 7. Discovery Rules (zero-config)

- Test roots: `tests/`, `test/`, `spec/`, `__tests__/`, `src/**/*.spec.*`,
  `src/**/*.test.*`, `**/*.spec.ts|tsx|js|mjs|cjs`, `**/*.test.*`,
  `**/*Test.php`, `**/*TestCase.php`, `**/test_*.py`, `**/*_test.py`,
  `**/tests.py`.
- Production = all parsed source files that are not tests; languages detected
  by extension (`ts/tsx/js/jsx/mjs/cjs`, `php`, `py`, `rs`).
- Excludes `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `.git`,
  virtualenvs, and framework build/cache directories (`.next`, `.nuxt`,
  `.svelte-kit`, `.turbo`, `.pytest_cache`, …) unconditionally, both as a
  directory entry and as a path segment, so an excluded tree is pruned rather
  than walked and discarded file by file.
- Reads the scan root's `.gitignore` and applies it (comments, negation,
  trailing-slash directory rules, `*`, `?`, `**` and character classes, last
  match wins). Nested `.gitignore` files are not consulted. This keeps
  generated trees and linked git worktrees out of the scan, which otherwise
  report the same drift twice.
- Honors `--exclude` overrides.

### 7.1 Symbol resolution

A target name is resolved against every declaration that shares its lookup key,
narrowed in order by: the language family of the test that named it
(TypeScript and JavaScript count as one), then the declaration closest to that
test in the directory tree. An unbroken tie leaves the target unresolved and
silent. For a dotted Python target the final segment must match a class name
case-sensitively, so `patch('pkg.transport.urlopen')` cannot resolve the module
`transport` to the class `Transport`.

## 8. Output & Exit Codes

- CLI text output is human-readable grouped by violation type; `--json` emits
  the same object as `nemesis_audit`.
- Exit codes: `0` = complete clean scan, `1` = violations found,
  `2` = operational error or partial scan (diagnostics are present).
- The MCP server never exits non-zero for findings; it returns structured
  results for the agent to interpret.

## 9. Performance & Reliability

- File walk with per-file byte, total-byte, duration, and file-count budgets;
  hard caps on diagnostic volume. Budget exhaustion is reported as a partial
  scan and never as clean.
- Grammar WASM loaded lazily per language; if a grammar fails to load, that
  language is skipped with a structured diagnostic and the summary reports the
  partial scan. Explicitly requested roots/files that cannot be inspected are
  operational errors, not clean results. Requested paths scope both production
  and test inputs.
- Deterministic output ordering for stable diffs.

## 10. Testing Strategy

- Unit tests for the resolver and each extractor against fixture repos under
  `fixtures/` covering all four ecosystems and all four violation types.
- A fixture experiment matrix under `fixtures/experiments/` keeps three
  repository-shaped variants per supported language and framework family.
- End-to-end: run the CLI in JSON mode against fixtures; assert exit codes and
  violation payloads.
- MCP smoke: start the server over stdio, list tools, call `nemesis_audit`,
  assert response shape.
- Golden rule: every supported framework idiom in §3 has at least one fixture.

## 11. Acceptance Criteria (v0.1)

- [x] `nemesis audit --json` returns the summary/violations shape from the idea doc.
- [x] Ghost method, arity, return drift, visibility findings all reproduce on fixtures.
- [x] `nemesis verify-symbol` resolves a symbol and lists doubles + validity.
- [x] `nemesis fixtures` flags stale JSON/YAML fixtures.
- [x] MCP server starts over stdio and serves the three tools.
- [x] Zero-config run on a repo with mixed TS/PHP/Python/Rust produces findings
      for each ecosystem without config.
- [x] A clean repo exits 0; a violating fixture repo exits 1.
