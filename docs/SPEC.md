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
| Rust | mockall | `MockFoo::new()` / `MockFoo::default()` bound to a variable or used inline, `expect_<method>()` expectations, arity from `.with(...)` (one predicate per parameter), `#[automock]` traits and `mock! { }` blocks | tree-sitter-rust | traits, fns, structs, enums, impls |

Fixture checking (tool 3) inspects JSON and YAML fixtures against production
DTO/class/record shapes. Field extraction covers TypeScript interfaces,
type aliases/classes, PHP properties, Python class attributes, and Rust struct
fields.

A file is a candidate fixture only when it carries a JSON/YAML extension, sits
under a fixture or test directory, is not a known configuration file
(`package.json`, `tsconfig*.json`, lockfiles, compose files, OpenAPI documents)
and is not inside a tooling directory (`.github/`, `.vscode/`, `.cursor/`, …).
The walk shares the audit's exclusions and `.gitignore` handling, and enforces
the same per-file byte and duration budgets.

Binding a fixture to a DTO requires a name match or a shape match. A shape
match needs at least three shared fields covering ≥60% of the fixture's keys
and ≥50% of the DTO's fields. Name signals come from the file name and from
top-level keys whose value actually holds records.

An unmatched fixture is counted in `unmatched_fixtures`, and an unparsable one
is listed in `unparsable_fixtures`. Neither makes the scan partial.

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

   The arguments themselves are compared too, where both sides are knowable:
   a literal passed to `with(...)` or `toHaveBeenCalledWith(...)` is checked
   against the declared parameter type through the same lattice used for
   return values. Only literals are compared, so a variable, a matcher such as
   `$this->anything()` or `expect.any(String)`, or any call is passed over. The
   check stops at a variadic parameter, ignores arguments beyond the declared
   list, and stands down entirely when any argument is named, since a named
   argument's position says nothing about which parameter it fills.
3. **`RETURN_DRIFT`** — the stub's return value cannot satisfy the declared
   return type of the real method. Both sides are reduced to a canonical
   lattice first, so a `true` literal satisfies `boolean`, `bool` and `Bool`
   alike; an array literal satisfies `T[]`, `Array<T>`, `list[T]`, `Vec<T>`
   and PHP `iterable`; and a declared union, `Optional[T]`, `?T`, `Option<T>`
   or `Promise<T>` is satisfied by any of its members. Confidence drops to
   `warning` when both sides name concrete types, because the inheritance that
   would relate them lives in a dependency directory that is never walked.

   When the stub returns an object literal and the declared type's fields are
   known, the fields are compared as well: a missing required field is
   `definite`, an unknown field is a `warning` with a did-you-mean. The check
   stands down when the literal spreads another value or uses a computed key,
   since the key set is then unknowable, and when the declared type inherits
   from outside the scanned tree, since it may declare more fields than are
   visible. A member the type declares as a property is never a ghost method.
4. **`VISIBILITY_BREACH`** — the double stubs a member it cannot legitimately
   replace. Three cases beyond `private`/`protected`:
   - A `final` PHP class cannot be doubled at all, because no subclass can be
     generated for it, so every mock of it fails the moment the class is
     sealed. Reported once per class per test file.
   - A `final` method cannot be overridden by a double.
   - A `static` method is not intercepted by an instance double, so stubbing
     one is configuration that never takes effect. Reported as a `warning`,
     since the double itself is still valid.

   Python has no access control, so a single leading underscore yields
   `warning`; only a name-mangled `__member` is `definite`.

A stubbed member whose name is not a literal (`shouldReceive($method)` driven
by a loop variable, an interpolated or templated name) identifies nothing that
can be checked and produces no finding at all.

**Severity:** `breaking_only` = `GHOST_METHOD`, `ARITY_MISMATCH`,
`RETURN_DRIFT`, `VISIBILITY_BREACH` (all exit-1 in CLI mode; hard-fail in CI).
`untyped_only` = violations where the relevant side is missing type
information: a stub pins a concrete return value on a method that declares no
return type, so there is no contract to check it against. These are always
`warning` with `evidence: 'untyped'`. Before, the mode could not return
anything at all from an audit, because an untyped stub is treated as
compatible and never reached a finding. `all` is exactly `breaking_only` plus
`untyped_only`, and every finding carries an `evidence` value. `all` = everything, including
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
- Follows symlinked directories, resolving real paths to end a loop. A tree
  containing no symlinks pays nothing for this. Source reachable only through
  a link would otherwise be absent from the graph, and the doubles pointing
  into it would be reported as clean rather than unresolved.
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
  `verify-symbol` exits 1 when any double no longer matches its target, so it
  can gate a merge on its own.
- A fatal diagnostic (a path that cannot be read, a grammar that fails to load)
  is always exit 2. A non-fatal one (a file skipped by a budget) is exit 2 by
  default and falls back to the finding-based code under `--allow-partial`.
- Every diagnostic is summarised on stderr, grouped by reason, so an exit 2 is
  never silent.
- Unknown commands, unknown options, invalid strictness values and unknown
  languages are rejected with exit 2 rather than ignored.
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
