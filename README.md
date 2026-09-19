# Nemesis-MCP

> *"Een stub voor een methode die allang niet meer bestaat, slaagt ook."*
> (A stub for a method that no longer exists also passes.)

Static contract-integrity inspection between **test doubles** (mocks, stubs,
spies) and **production code** across multi-language repositories. Nemesis
catches the most insidious failure mode of agent-written tests: a permanently
green suite guarding phantom code.

When an implementation signature changes, mocked unit tests keep passing
because the mock — not the production code — defines the contract. Nemesis
extracts doubles via AST analysis and checks them against the real
classes/interfaces/traits. No tests are executed; results are deterministic.

## The Four Contract Violations

| Type | Meaning |
| --- | --- |
| `GHOST_METHOD` | The double stubs a method that no longer exists on the target (includes "Did you mean …?" suggestions). |
| `ARITY_MISMATCH` | The double passes more arguments than the method accepts, or omits required ones. |
| `RETURN_DRIFT` | The stubbed return value cannot satisfy the declared return type. |
| `VISIBILITY_BREACH` | The double stubs a `private`/`protected` method directly. |

Findings carry a confidence: `definite` (block-worthy) or `warning`
(heuristic, e.g. dynamic targets).

`definite` is reserved for what syntax alone can prove. Two differing *named*
types are reported as `warning`, because the class that relates them normally
lives in `vendor/` or `node_modules/`, which are never walked. A Python method
with one leading underscore is a naming convention rather than access control,
so stubbing it is a `warning`; only a name-mangled `__member` is a definite
breach. A stubbed method whose name is not a literal, such as
`shouldReceive($method)` inside a loop, names nothing checkable and is skipped
entirely.

## Supported Ecosystems

| Language | Frameworks | Patterns |
| --- | --- | --- |
| TypeScript / JS | Vitest, Jest | `vi.spyOn` / `jest.spyOn`, `mockReturnValue`, `mockResolvedValue`, `toHaveBeenCalledWith`, `toHaveBeenCalledTimes` |
| PHP | PHPUnit, Pest, Mockery | `createMock`, `createStub`, `getMockBuilder()->getMock()`, `expects()->method()`, `with()`, `willReturn*`, `Mockery::mock`, `shouldReceive`, `andReturn*`, Pest `mock()` / `spy()` |
| Python | pytest-mock, unittest.mock | `mocker.patch`, `patch`, `patch.object`, `create_autospec`, `Mock(spec=X)`, `return_value=`, `assert_called_with` |
| Rust | mockall | `MockFoo::new()` / `MockFoo::default()` with `expect_<method>()`, arity from `.with(...)`, plus `#[automock]` and `mock! { }` declarations |

## Install & Run

```bash
npm install
npm run build          # emits dist/
node dist/cli/main.js audit   # or link the package to use `nemesis`
```

### CLI

```bash
nemesis audit [paths...] [options]
nemesis verify-symbol <SymbolName> [options]
nemesis fixtures [paths...] [options]
```

| Option | Meaning |
| --- | --- |
| `--json` | Machine-readable output instead of text. |
| `--strictness=<mode>` | `all`, `untyped_only` or `breaking_only` (default). |
| `--lang=<l1,l2>` | Restrict to some of `typescript, javascript, php, python, rust`. |
| `--include=<path>` | Extra path to scan; repeatable. |
| `--exclude=<dir>` | Directory name to skip; repeatable. |
| `--allow-partial` | Do not fail merely because files were skipped. |
| `-h, --help` / `-V, --version` | Help, version. |

An unknown command, an unknown option, an invalid strictness and an unknown
language are all errors. None of them is silently ignored, because a dropped
`--strictness` typo is a scan that passes for the wrong reason.

`untyped_only` reports the cases where nothing could be verified: a test pins a
concrete return value on a method that declares no return type. That is common
in plain JavaScript and in unannotated Python, so it is a `warning` and never
blocks the default run. `all` is exactly `breaking_only` plus `untyped_only`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Clean scan, nothing to report. |
| `1` | Violations found. `verify-symbol` uses this when any double no longer matches. |
| `2` | Operational error, or a partial scan. |

Audits enforce default limits of 10,000 discovered files, 2 MB per file,
200 MB total input, and 120 seconds per audit. Files that are skipped or fail
to parse appear as diagnostics in the summary and are always explained on
stderr, so an exit 2 never arrives without a reason.

A partial scan exits 2 rather than reporting clean, because a file the symbol
graph never saw could be hiding a ghost method. When the gap is known and
acceptable, for instance a repository that commits multi-megabyte generated
seeders, `--allow-partial` falls back to the finding-based code. A file the
walk could not read at all stays an exit 2 either way.

### MCP Server

```bash
nemesis-mcp --serve    # stdio MCP server
```

Three tools:

1. **`nemesis_audit`** — scan the repo (or `paths`) for drift.
   Params: `paths?`, `strictness?`, `lang?`, `exclude?`.
   Returns `{ summary: { scanned_test_files, doubles_inspected, violations_count }, violations: [...] }`.
2. **`nemesis_verify_symbol`** — list every double pointing at a symbol and
   whether each remains valid after your latest edit.
   Params: `symbol` (e.g. `App\Services\InvoiceService` or `UserService`),
   `strictness?`, `exclude?`. Returns the report plus
   `summary: { doubles, invalid }` so an agent can branch without counting.
3. **`nemesis_stale_fixtures`** — check JSON/YAML fixtures against current
   DTO shapes (missing/renamed/removed fields). Strictness filtering is shared
   with the CLI and supports `all`, `untyped_only`, and `breaking_only`.
   Params: `paths?`, `strictness?`. Returns `unmatched_fixtures` alongside
   `scanned_fixtures`, plus `unparsable_fixtures` when any fixture-shaped file
   is not valid JSON or YAML.

A failing scan comes back as a tool error with `isError`, rather than a
transport-level rejection the agent cannot read.

## What counts as a fixture

`nemesis fixtures` only inspects JSON and YAML that lives where fixtures live:
under `fixtures/`, `__fixtures__/`, `testdata/`, `__snapshots__/`,
`cassettes/`, `stubs/`, `mocks/`, `factories/`, `seeds/`, `samples/`, or inside
a test root. Configuration keeps its own identity wherever it sits, so
`package.json`, `tsconfig*.json`, lockfiles, `docker-compose*.yml`, OpenAPI
documents and anything under `.github/`, `.vscode/` or `.cursor/` are never
treated as fixtures, even inside a test corpus.

A fixture is bound to a DTO by name or by shape. A shape match needs at least
three shared fields covering most of both the fixture and the DTO, because two
shared keys is coincidence. A top-level key counts as a name only when it
actually holds records: `{"users": [{...}]}` names `UserRecord`, while
`{"edition": "2026-q1"}` is a string that happens to share a word with a class.

A fixture that matches no DTO is counted, not reported: most fixtures describe
no DTO at all. A fixture that will not parse is named in the summary and does
not make the scan partial, because test corpora deliberately contain truncated
and malformed files.

Example `nemesis_audit` response:

```json
{
  "summary": { "scanned_test_files": 42, "doubles_inspected": 187, "violations_count": 3 },
  "violations": [
    {
      "file": "tests/Unit/BillingServiceTest.php",
      "line": 54,
      "type": "GHOST_METHOD",
      "confidence": "definite",
      "double_type": "PHPUnit_MockObject",
      "target": "App\\Contracts\\PaymentGateway::chargeWithToken",
      "message": "Method 'chargeWithToken' does not exist on 'App\\Contracts\\PaymentGateway'. Did you mean 'chargeToken'?",
      "suggestion": "chargeToken"
    }
  ]
}
```

## Agent Workflow

1. **Before an agent finishes a refactor** — call `nemesis_verify_symbol` on
   the modified symbol to see which doubles need signature updates.
2. **Pre-merge audit** — run `nemesis_audit` in CI or pre-commit (exit 1 fails
   the check). Designed to run alongside Chaos-MCP and Momus-MCP.

## Suppression

Add a `nemesis-ignore` comment on the finding's line or the line above:

```php
$gateway->method('legacyName')->willReturn(1); // nemesis-ignore
```

## Discovery (zero-config)

Test roots: `tests/`, `test/`, `spec/`, `__tests__/`, `*.spec.*`, `*.test.*`,
`*Test.php`, `test_*.py`, `tests/*.rs`, … Everything else with a known source
extension is production code. `node_modules`, `vendor`, `dist`, `build`,
`target`, etc. are always skipped.

Symlinked directories are followed, because a repository that reaches its
source through a link (pnpm workspaces, many monorepo layouts) would otherwise
have that source missing from the graph and every double pointing into it
silently unchecked. Directories are tracked by real path, so a link back to
somewhere already walked, including the repository root, ends the descent
instead of walking the tree twice.

Rust is discovered differently from the rest: `tests/` and `benches/` are
Cargo's test targets, `*_test.rs` and `test_*.rs` are tests by name, and a
source file carrying a `#[cfg(test)]` module is scanned as both production and
test, because that inline module is where most Rust unit tests live.

The repository's own `.gitignore` is honoured as well, so generated trees
(`var/cache/`, `build-electrobun/`, a linked `.worktrees/` checkout, a vendored
`ref/` copy of someone else's source) are neither scanned nor counted twice.
Nested `.gitignore` files are not read, only the one at the scan root. Pass
`--exclude=<dir>` for anything else, including a repository's own intentionally
broken drift fixtures:

```bash
nemesis audit --exclude=fixtures
```

### Same-named symbols

A target is resolved against the language of the test that named it, then
against the declaration closest to that test in the directory tree. A monorepo
holding one `CatalogService` per package resolves each to its own package, and
an SDK repo shipping a `UsageTracker` class in TypeScript, Python and PHP never
checks a TypeScript test against the Python class. When neither rule settles it,
the target is left unresolved and nothing is reported — Nemesis does not guess.

## Architecture

```
Test AST Parser ──► Double Manifest ┐
                                    ├──► Drift Analyzer ──► JSON / MCP / CLI
Production Indexer ──► Symbol Graph ┘
```

- **parser/** — web-tree-sitter + per-grammar WASM (`@vscode/tree-sitter-wasm`),
  lazily loaded; a grammar that fails to load skips its language gracefully.
- **core/** — discovery, symbol graph (extends/implements/uses resolution),
  drift analyzer, suppression, reporting.
- **extractors/** — per-language production indexers and double extractors.
- **fixtures/** — stale JSON/YAML fixture checker.
- **mcp/** — stdio MCP server; **cli/** — the `nemesis` binary.

## Development and quality gates

```bash
npm run typecheck    # strict TypeScript contract check
npm test             # unit + e2e + MCP smoke tests
npm run lint         # Prettier source check + Markdown documentation lint
npm run test:coverage     # focused V8 gate with high thresholds
npm run test:coverage:all  # whole-source visibility report
npm run quality            # lint + both coverage reports: the CI/pre-merge gate
npm run format       # apply the repository formatting policy locally
```

The focused coverage gate requires at least **90% lines, functions, and statements** and
**77% branches** for deterministic core helpers (`ignore`, `report`, and
`symbolGraph`). `npm run test:coverage:all` reports every production module
and enforces a baseline floor of 15% lines, functions, and statements (10%
branches); this whole-pipeline floor is raised as extractor and operational-path
tests are added. CLI/MCP subprocess behavior is covered by the e2e and smoke
suites.

Fixture repositories under `fixtures/` exercise every violation type in every
ecosystem. Fixture checking supports field metadata from TypeScript interfaces,
type aliases, and class properties, PHP properties, Python class attributes,
and Rust struct fields; unsupported or ambiguous shapes are reported as
diagnostics rather than treated as clean. `fixtures/experiments/` contains three focused experiments per
supported language (TypeScript/Vitest, JavaScript/Jest, PHP/PHPUnit-Mockery-Pest,
Python/unittest.mock, and Rust/mockall). `fixtures/dogfood-repo` is a
repository-shaped TypeScript example with stale doubles, while
`fixtures/dogfood-clean` proves the clean path. They are static-analysis inputs,
not runnable tests.

See `docs/SPEC.md` (specification) and `docs/PLAN.md` (implementation plan).
