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
| Rust | mockall | `#[automock]`, `mock! { }` (experimental tier) |

## Install & Run

```bash
npm install
npm run build          # emits dist/
node dist/cli/main.js audit   # or link the package to use `nemesis`
```

### CLI

```bash
nemesis audit [paths...] [--json] [--strictness=<mode>] [--lang=<l1,l2>] [--exclude=<dir>]
nemesis verify-symbol <SymbolName> [--json]
nemesis fixtures [paths...] [--json]
```

- `--strictness=all | untyped_only | breaking_only` (default `breaking_only`)
- Exit codes: `0` clean, `1` violations found, `2` operational error or partial scan.
- Audits enforce default limits of 10,000 discovered files, 2 MB per file,
  200 MB total input, and 120 seconds per audit. Diagnostics are returned in
  the summary when files are skipped or fail to parse; partial scans exit 2
  rather than reporting clean.

### MCP Server

```bash
nemesis-mcp --serve    # stdio MCP server
```

Three tools:

1. **`nemesis_audit`** — scan the repo (or `paths`) for drift.
   Params: `paths?`, `strictness?`, `lang?`.
   Returns `{ summary: { scanned_test_files, doubles_inspected, violations_count }, violations: [...] }`.
2. **`nemesis_verify_symbol`** — list every double pointing at a symbol and
   whether each remains valid after your latest edit.
   Params: `symbol` (e.g. `App\Services\InvoiceService` or `UserService`).
3. **`nemesis_stale_fixtures`** — check JSON/YAML fixtures against current
   DTO shapes (missing/renamed/removed fields). Strictness filtering is shared
   with the CLI and supports `all`, `untyped_only`, and `breaking_only`.
   Params: `paths?`, `strictness?`.

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
