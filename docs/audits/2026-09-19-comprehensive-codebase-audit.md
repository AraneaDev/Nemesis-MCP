# Nemesis-MCP Comprehensive Codebase Audit

**Date:** 2026-09-19  
**Scope:** `src/`, `test/`, `fixtures/`, package/configuration files, and project documentation  
**Method:** Read-only execution-path review across correctness, control flow, data integrity, security, performance, architecture, and test coverage, corroborated by typecheck, tests, lint, and source-wide coverage.

## Executive assessment

The core pipeline is understandable and the existing fixture matrix covers the headline violation types. The main production risks are trust-boundary failures: requested scan scope is not consistently enforced, fixture failures can look clean, and some advertised language/framework support is only partial. The implementation also performs a large amount of sequential, repeated AST work while the enforced coverage gate excludes most of the code that determines correctness.

## Findings

## Issue: Audit path restrictions do not constrain production indexing

### Severity
High

### Location
`src/core/runtime.ts`, `runAudit`; `restrict()` and the `productionFiles` selection.

### Description
When `paths` is supplied, test files are filtered through `restrict(...)`, but production files are selected from the complete language-filtered discovery result. A scan requested for one directory can therefore index production files outside the requested scope.

### Why it matters
Results can include findings caused by unrelated repository code, violate caller expectations about scan scope, increase latency, and expose information outside the requested subtree to an MCP caller. It also makes targeted refactor verification non-deterministic when unrelated files change.

### Evidence
`runAudit` computes `testFiles = bounded(restrict(...))`, then computes `productionFiles = bounded(filterByLanguages(...))` without `restrict(...)`. The CLI and MCP both pass user-controlled `paths` into this option.

### Recommended Fix
Define one scope resolver that validates and normalizes requested paths, then apply it to both test and production files. Decide explicitly whether a test-only path should include its dependency closure; if so, implement that as a documented separate mode rather than silently scanning the whole repository. Add tests proving out-of-scope files do not affect targeted results.

### Confidence
High

## Issue: Fixture scanning converts operational failures into a clean result

### Severity
High

### Location
`src/fixtures/staleFixtures.ts`, `checkFixtures()` and `collectFixtureFiles()`; CLI `fixtures` command; MCP `nemesis_stale_fixtures`.

### Description
Fixture directory reads, fixture reads, and JSON/YAML parse errors are caught and discarded. A missing fixture path, unreadable file, or malformed fixture can therefore produce `scanned: 0` and exit code 0 with no diagnostic.

### Why it matters
A stale-fixture check can claim success without checking the requested inputs. This is especially dangerous in CI because malformed or inaccessible test data is treated as “no violations.”

### Evidence
`collectFixtureFiles()` returns on `readdir` failure; `checkFixtures()` continues on `readFile` and parse failures; the CLI returns `0` whenever filtered violations are empty and has no diagnostic channel for this tool.

### Recommended Fix
Return structured fixture diagnostics and a `partial`/`operational_error` status. Missing explicit paths should be fatal; malformed files should be reported and produce exit code 2 by default. Surface the same diagnostics in CLI JSON and MCP responses, and add tests for missing, unreadable, and malformed fixtures.

### Confidence
High

## Issue: Discovery silently hides unreadable directories

### Severity
High

### Location
`src/core/discovery.ts`, recursive `walk()`.

### Description
Any `readdir` failure is caught and treated as an empty directory. Unlike file read/index/extraction failures, it is not added to `ScanDiagnostic` and cannot make the result partial.

### Why it matters
Permission failures, filesystem errors, and broken mounts can remove entire subtrees from analysis while preserving a clean exit code. This undermines the tool’s central contract that a clean result represents an inspected repository.

### Evidence
The `catch` in `discoverFiles.walk()` contains only `return`; `runAudit` receives no callback or failure list from discovery.

### Recommended Fix
Make discovery return diagnostics or accept a diagnostic sink. Distinguish optional skipped directories from explicit requested roots, and fail with code 2 for an explicit root that cannot be traversed. Test nested unreadable directories and permission errors.

### Confidence
High

## Issue: Grammar failures are not represented in `skipped_languages`

### Severity
Medium

### Location
`src/core/types.ts`, `SymbolGraph.skippedLanguages`; `src/core/runtime.ts`; parser loader and extractor catches.

### Description
The summary advertises `skipped_languages`, but no runtime path adds a language to `graph.skippedLanguages`. Grammar/index/extraction failures are recorded only as file diagnostics, and a grammar-wide failure is not summarized by language.

### Why it matters
Consumers cannot tell whether an entire ecosystem was unavailable versus a few files failing. The human report can omit the documented “skipped language” warning even when all files of that language were missed.

### Evidence
`emptyGraph()` initializes an empty list; `loadLanguage()` throws on failure; runtime catches extractor/indexer errors but never mutates `skippedLanguages`.

### Recommended Fix
Track grammar-load state centrally and record each failed language once. Separate grammar-unavailable diagnostics from per-file parse/index failures, include both in JSON/MCP output, and add a simulated loader-failure test.

### Confidence
High

## Issue: `untyped_only` strictness is implemented as confidence filtering

### Severity
High

### Location
`src/core/runtime.ts`, `passesStrict()`; `src/core/analyzer.ts`, confidence assignment.

### Description
`untyped_only` returns every finding with `confidence === 'warning'`, but confidence is not a representation of whether the production signature or stub value is untyped. Warnings are also used for unresolved/empty-member heuristics, while many untyped return values are treated as compatible and emit no finding at all.

### Why it matters
The public strictness mode can include typed heuristic ghost findings and omit the untyped drift cases users explicitly requested. CI policies based on this mode are semantically unreliable.

### Evidence
`passesStrict()` returns `f.confidence === 'warning'`; `classify()` assigns ghost confidence from member knowledge and return-drift confidence from inferred type, while the finding model has no explicit untyped reason/side.

### Recommended Fix
Add an explicit finding classification field (for example `typed`, `untyped_production`, `untyped_stub`, `unresolved`) or carry type-evidence metadata through analysis. Implement strictness against that field, define fixture semantics separately, and add tests for each combination of typed/untyped sides.

### Confidence
High

## Issue: PHP method lookup is case-sensitive despite PHP method names being case-insensitive

### Severity
Medium

### Location
`src/core/symbolGraph.ts`, `resolveMember()`; PHP indexer/double extractor.

### Description
Methods are stored and looked up by their source spelling. `resolveMember()` uses `type.methods.get(method)` without normalizing the method key, so a PHP double that configures the same method with different casing is reported as a ghost.

### Why it matters
This creates false positives for valid PHPUnit/Mockery usage and can make CI fail on a language-level naming rule that does not exist.

### Evidence
Type names are normalized through `key()`, but method names are not; PHP permits case-insensitive method calls and common codebases do not necessarily preserve declaration casing in mocks.

### Recommended Fix
Make member-name comparison language-aware: normalize PHP method names case-insensitively while preserving case-sensitive behavior for TypeScript, JavaScript, Python, and Rust. Add a PHP mixed-case regression fixture.

### Confidence
High

## Issue: Rust production methods in `impl` blocks are not indexed

### Severity
Medium

### Location
`src/extractors/rust/index.ts`.

### Description
The Rust indexer creates symbols for traits, structs, enums, and free functions, but does not attach methods from `impl` blocks to their owning struct/trait symbol. The advertised production symbol graph therefore lacks common concrete Rust methods.

### Why it matters
Rust doubles targeting concrete types or methods can be unresolved or falsely treated as having no members, producing false negatives for ghost, arity, visibility, and return checks.

### Evidence
The indexer walks `trait_item`, `struct_item`, `enum_item`, and top-level `function_item`; there is no `impl_item` handling or owner association.

### Recommended Fix
Index `impl_item` blocks, resolve their type and optional trait target, and merge methods into the appropriate symbol with visibility and signatures. Add fixtures for inherent impls and trait impls, including stale expectations.

### Confidence
High

## Issue: Stale-fixture support is narrower than the public contract

### Severity
Medium

### Location
`src/fixtures/staleFixtures.ts`, `collectDtoLikes()` and `buildGraph()`; README and `docs/SPEC.md` fixture-tool claims.

### Description
Fixture validation only collects symbols carrying `fields`, and the current field extraction is primarily TypeScript interface/type-alias parsing. PHP, Python, Rust, and ordinary TypeScript class DTOs are indexed but generally have no field map, so their fixtures are silently ignored.

### Why it matters
Users can receive a clean fixture result for supported languages and DTO shapes that were never validated. The documentation suggests broader DTO/class/record checking than the implementation provides.

### Evidence
`collectDtoLikes()` explicitly falls back to “TS type_alias/interface field maps”; class members are not extracted as fields, and no other extractor populates `TypeSymbol.fields`.

### Recommended Fix
Either narrow the documented support matrix immediately or implement field extraction per language and for class properties/records. Emit an “unsupported shape” diagnostic rather than silently skipping a selected fixture when no DTO can be matched.

### Confidence
High

## Issue: Fixture-to-DTO matching can validate against the wrong model

### Severity
Medium

### Location
`src/fixtures/staleFixtures.ts`, `matchDto()`.

### Description
DTO selection is based on filename and top-level-key substring heuristics. Equal scores retain the first map entry, and there is no import/module context or field-overlap verification.

### Why it matters
Common names such as `User`, `UserSummary`, and `AdminUser` can cause a fixture to be checked against an unrelated shape, yielding both false stale findings and false clean results.

### Recommended Fix
Use exact normalized filename matches first, then qualified/module context, then field overlap. Treat unresolved ties as an explicit ambiguity diagnostic. Add colliding DTO fixtures and wrapper-key cases.

### Confidence
Medium

## Issue: Audit work is sequential and repeats full parsing/traversal

### Severity
Medium

### Location
`src/core/runtime.ts`, `indexProduction()` and `extractDoubles()`; parser loader; all language extractors.

### Description
Files are read and parsed one at a time. Production and test files are independently walked, and each file creates a fresh mutable parser even though immutable grammars are cached. There is a file-count and per-file byte limit, but no total-byte, parse-time, total-duration, or cancellation budget.

### Why it matters
Large repositories and concurrent MCP calls can experience avoidable latency and memory pressure. A single pathological parse can hold an MCP request for an unbounded time, and repeated scans redo all work instead of reusing safe indexes.

### Recommended Fix
Add abortable total scan and per-file parse budgets, bounded worker concurrency, and explicit resource diagnostics. Profile before parallelizing parser work; then consider sharing parsed/indexed results within a request and caching by file content hash across requests. Add large-tree and concurrent-request benchmarks.

### Confidence
High

## Issue: Enforced coverage excludes the high-risk pipeline

### Severity
Medium

### Location
`vitest.config.ts`, coverage `include`; `package.json`, `lint`/`quality` scripts.

### Description
The enforced threshold covers only `ignore.ts`, `report.ts`, and `symbolGraph.ts`. Runtime, all language indexers/double extractors, fixture checking, CLI, MCP, and most parser behavior are outside the gate. The source-wide report confirms only 19.01% statements and 18.93% lines overall.

### Why it matters
The green quality gate does not protect the code most likely to produce false negatives or operational failures. Existing e2e tests validate selected happy paths but do not provide branch coverage for error and edge behavior.

### Recommended Fix
Keep the focused pure-core gate, but add a separately named integration coverage target for runtime/extractors/fixtures and raise it incrementally. Add direct tests for each extractor, error path, language-specific normalization, budgets, and MCP/CLI policy parity. Update documentation so the focused threshold is not presented as whole-project coverage.

### Confidence
High

## Issue: Advertised framework support is presence-only for Python and Rust patterns

### Severity
Medium

### Location
`src/extractors/python/doubles.ts`; `src/extractors/rust/doubles.ts`; `src/core/analyzer.ts`; README/spec support tables.

### Description
Python `create_autospec`/`Mock(spec=...)` and Rust `#[automock]`/`mock!` often produce a double record without configured method expectations that can be compared against production members. Recording that a double exists is not equivalent to checking its contract.

### Why it matters
The most important stale-double failure—an expectation for a removed or renamed method—can pass unnoticed for advertised idioms. This is a false-negative risk, not merely missing convenience support.

### Recommended Fix
Extract method access and expectation chains for Python spec mocks and parse Rust mock macro declarations/expectations, including impl ownership. Until then, mark these patterns as presence-only/experimental in public docs and add negative tests proving the current limitation.

### Confidence
High

## Issue: Policy and diagnostics are duplicated across interfaces

### Severity
Low

### Location
`src/core/runtime.ts`, `src/fixtures/staleFixtures.ts`, `src/cli/main.ts`, `src/mcp/server.ts`, `src/core/report.ts`.

### Description
Audit strictness, fixture strictness, diagnostics, and exit behavior are implemented in separate paths. `exitCodeFor()` accepts a strictness argument but does not use it, and fixture commands have different failure/reporting behavior from audits.

### Why it matters
A new violation type or policy change can be applied to one public interface and missed in another, creating inconsistent automation results.

### Recommended Fix
Create shared policy functions for finding classification/filtering, diagnostics, and exit status. Use them from CLI and MCP and add cross-interface golden tests.

### Confidence
High

## Issue: Documentation overstates operational and language guarantees

### Severity
Low

### Location
README.md; `docs/SPEC.md` sections 4, 7, 9, and 10.

### Description
The documentation promises reported grammar skips, streaming/budgeted behavior, and broad fixture/framework coverage, while the implementation has silent discovery/fixture failures, no timeout/cancellation budget, incomplete Rust indexing, and presence-only patterns.

### Why it matters
For a static analyzer, unsupported behavior that appears clean is more harmful than an explicit limitation. Agents and CI operators may rely on guarantees the implementation does not provide.

### Recommended Fix
Publish a generated or test-backed support matrix with `verified`, `presence-only`, `experimental`, and `unsupported` statuses. Synchronize operational guarantees with actual diagnostics and limits before expanding claims.

### Confidence
High

## Validation performed

- `npm run typecheck` — passed.
- `npm test` — passed: 8 test files, 41 tests.
- `npm run lint:code` — passed.
- `npm run lint:docs` — passed.
- `npm run test:coverage:all` — passed, but reported only 19.01% statements / 18.93% lines across `src/`, confirming the coverage finding.
- An attempted `npm test -- --runInBand` was invalid for Vitest (`--runInBand` is not supported); the repository’s normal `npm test` command was then run successfully.

## Prioritized remediation plan

### Phase 0 — Make scope and failure status trustworthy

1. Centralize path normalization and apply scope to both production and test files.
2. Add discovery and fixture diagnostics; make explicit missing/unreadable paths operational errors.
3. Represent grammar-wide failures in `skipped_languages`.
4. Define one partial-scan/exit-code contract for audit and fixture CLI/MCP tools.
5. Add regression tests for scope leakage, unreadable directories, malformed fixtures, and grammar failure simulation.

**Exit criterion:** every selected input is analyzed, explicitly diagnosed as skipped, or produces a clear operational failure; targeted scans cannot be affected by out-of-scope files.

### Phase 1 — Correct language and contract semantics

1. Implement language-aware member normalization, especially PHP case-insensitive lookup.
2. Index Rust `impl` methods and associate them with concrete/trait symbols.
3. Define real typed/untyped evidence and correct `untyped_only` filtering.
4. Decide and document the support level for Python spec/autospec and Rust macro patterns, then implement method/expectation extraction where supported.
5. Add direct extractor and analyzer tests for all changes.

**Exit criterion:** every emitted finding is based on the correct language semantics, and advertised patterns either produce contract checks or are explicitly marked limited.

### Phase 2 — Make fixture checking safe and accurate

1. Expand field extraction to supported DTO/class/record forms or narrow the public contract.
2. Replace heuristic-first DTO selection with exact/contextual matching and ambiguity diagnostics.
3. Share strictness and diagnostic policy with audit results.
4. Add fixture tests for unsupported shapes, collisions, malformed files, missing roots, and all strictness modes.

**Exit criterion:** fixture “clean” means a known DTO was checked successfully, not that the checker skipped the input.

### Phase 3 — Add resource controls and performance baselines

1. Add total-byte, per-file parse-time, total-duration, cancellation, and diagnostic-volume budgets.
2. Use bounded concurrency only after parser/resource behavior is tested.
3. Profile duplicate AST walks and introduce request-local or content-hash caching where safe.
4. Benchmark small, medium, generated, pathological, and concurrent MCP scans.

**Exit criterion:** documented latency/memory bounds hold and budget exhaustion is visible in results.

### Phase 4 — Make coverage representative

1. Retain the focused pure-core threshold as a named unit gate.
2. Add integration coverage for runtime, extractors, parser failure paths, fixtures, CLI, and MCP.
3. Raise layer thresholds incrementally, prioritizing false-negative paths and operational handling.
4. Add cross-interface golden tests for identical inputs and strictness modes.

**Exit criterion:** no high-risk production layer is silently excluded from quality reporting.

### Phase 5 — Synchronize documentation and remove policy duplication

1. Generate/update a support matrix from tests.
2. Document scan scope, partial results, limits, and fixture matching behavior.
3. Consolidate filtering, diagnostics, and exit status into shared policy code.
4. Remove dead parameters/helpers and add a changelog entry for behavior changes.

## Final summary

- **Total issues by severity:** Critical 0 / High 4 / Medium 8 / Low 2
- **Most dangerous logic flaw:** explicit targeted audits can analyze production files outside the requested scope, while fixture/discovery failures can still look clean.
- **Highest-risk architectural issue:** the runtime has no single scope/status/policy layer shared by CLI, MCP, audit, and fixture workflows.
- **Biggest maintainability problem:** duplicated policy and heuristic behavior across language extractors and public interfaces.
- **Largest performance opportunity:** introduce cancellation/resource budgets, then profile and eliminate repeated sequential parsing/traversal.
- **Biggest security concern:** untrusted repository paths/content can cause out-of-scope inspection and resource exhaustion in the MCP process.
- **Estimated overall code quality:** 5.5/10
- **Estimated production readiness:** 4.5/10
- **Estimated technical debt:** 6.5/10

### Single highest-impact improvement

Implement a shared, fail-closed scan-scope and diagnostic-status layer first. It prevents targeted-scan leakage and makes every skipped or failed input visible, which is the prerequisite for trusting subsequent extractor, performance, coverage, and CI improvements.
