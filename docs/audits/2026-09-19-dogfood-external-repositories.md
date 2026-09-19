# Dogfood run: issues found in other repositories

Date: 2026-09-19
Scope: every git repository under `/root` (54 checkouts), audited with
`nemesis audit --json` at default strictness.

This file records what the run said about **other** codebases. The defects it
exposed in Nemesis itself were fixed in the same session and are described in
the commit and in `README.md` / `docs/SPEC.md`, not here.

## Summary

No genuine contract drift was found in any repository's real code. Every
finding that survived the tool fixes sits in a fixture directory that is
*deliberately* broken: Nemesis' own `fixtures/` (20 findings) and Momus-MCP's
parser fixtures (12). Across the other 51 repositories the audit is clean.

That is a real result rather than a disappointing one: these are repositories
whose test suites were largely written alongside their production code, and the
failure mode Nemesis hunts is drift that accumulates when a signature changes
later. It does mean the run's value here was diagnostic rather than corrective,
so the rest of this file is about what the sweep revealed.

| Category | Repositories |
| --- | --- |
| Oversized generated files in the working tree | workflow-dockerized, ratio, glyphfall-mail |
| Linked git worktrees inside the checkout | usage-tracker, proxypilot, thin-ratio |
| Vendored third-party source in-tree | oogactx |
| Same class name across several languages | usage-tracker |
| Doubles that no static tool can verify | Chaos-MCP, Knossos-MCP, topolearn, glyphfall, reefermanseeds, proxypilot |
| Cannot self-audit without `--exclude` | Momus-MCP |
| Deliberately unparsable data under `tests/` | nekyia, oogactx, Argos-MCP, Knossos-MCP, mcpobservatory |
| Test corpus of miniature projects | mcpobservatory |
| Rust present, mockall used only in Momus-MCP's fixtures | Knossos-MCP, Chaos-MCP, expensis, glyphfall, 3d-wasm, talos, proxypilot, Momus-MCP, ratio, Sneaky-MCP, termaxa |
| Repository root reachable through its own symlink | oogactx |
| Mocks a framework base class whose members live in `vendor/` | thin-ratio, e-commerce-api |

## 1. Oversized generated files in the working tree

### workflow-dockerized (unresolved)

`database/seeds/` holds 16 PHP files that each exceed 2 MB, among them
`ContractsTableSeeder.php`, `OrganizationsTableSeeder.php` and
`NAbleNotificationsTableSeeder.php`. They are committed source, not build
output, so no ignore rule excludes them. Every one is skipped by the per-file
byte budget, which makes the scan partial and the exit code 2.

This is the one repository that still exits non-zero for a reason that is not a
deliberate fixture. The seeders inline their data as PHP array literals. Moving
that data to SQL dumps, CSV or JSON fixtures would shrink the files by orders of
magnitude, speed up every tool that parses the tree (including PHPStan, Psalm
and your IDE), and make the diffs readable.

### ratio

`var/cache/dev/ContainerK0QQXjT/srcApp_KernelDevDebugContainer.php` and one
sibling exceed 2 MB. These are Symfony's generated dependency-injection
containers. They are correctly gitignored, and Nemesis now skips them, but they
were being parsed before that: the audit took 14.2 s and reported a partial
scan. Clearing `var/cache/` between environments avoids the same cost in other
tools.

### glyphfall-mail

`build-electrobun/dev-linux-x64/GlyphFallMail-dev/Resources/app/bun/index.js`
is a >2 MB bundled artifact sitting in the checkout. Gitignored, so it is
skipped now. Worth pruning anyway, since a bundle in the tree gets picked up by
grep, search indexes and editor file watchers.

## 2. Linked git worktrees inside the checkout

Three repositories keep linked worktrees under a `.worktrees/` directory:

| Repository | Worktree | Test files it adds |
| --- | --- | --- |
| proxypilot | `.worktrees/quality-gates` | 174 |
| usage-tracker | `.worktrees/drop-heatmap-wireframes` | 145 |
| thin-ratio | `.worktrees/ci` | 55 |

They are gitignored, so Nemesis skips them now. Before that it scanned them and
reported every finding twice, which is why usage-tracker's count halved from 26
to 13 the moment `.gitignore` was honoured.

This is worth knowing beyond Nemesis. Any tool that walks the tree rather than
asking git for the file list will double-count here: coverage reporters,
duplicate-code detectors, license scanners, secret scanners. If a linting tool
in one of these repositories ever reports a suspiciously round doubling of
findings, this is the reason.

## 3. Vendored third-party source in-tree

`oogactx` carries `ref/context-mode-src` (161 test files) and `ref/caveman-src`
(12), copies of other projects kept for reference. They are gitignored and now
skipped, and they accounted for 173 of the 266 test files the first run
reported. Any metric taken over that repository before this run was measuring
two other projects more than it was measuring oogactx.

## 4. The same class name in several languages

`usage-tracker` ships a `UsageTracker` class three times:

- `sdk/node/src/index.ts` with `captureException`
- `sdk/python/usage_tracker/__init__.py` with `capture_exception`
- `sdk/php/src/UsageTracker.php`

It also has a Python `Transport` in `sdk/python/usage_tracker/transport.py`.

Nothing is wrong with this layout, and the naming symmetry across SDKs is
deliberate and good. It is worth recording because any tool that resolves
symbols by name alone will cross the SDK boundary here. Nemesis did exactly
that and produced 13 confident-but-wrong findings, claiming the TypeScript
`captureException` did not exist and suggesting the Python `capture_exception`
instead. If another analyser in this repository ever offers a suggestion in the
wrong naming convention, this is the shape of the bug.

## 5. Doubles that no static tool can verify

None of these are defects. They bound what contract checking can tell you about
these suites.

**Spies on built-ins.** In Chaos-MCP (100 doubles), glyphfall (198),
Knossos-MCP (66) and topolearn (63), nearly every double is
`vi.spyOn(Date, 'now')`, `vi.spyOn(process, 'cwd')` or a `console` spy. They
carry no application contract, so the audit is clean because there was nothing
to check, not because the contracts were verified. Read a high
`doubles_inspected` with a zero violation count in that light.

**Mock names built at runtime.** reefermanseeds and Momus-MCP configure mocks
in a loop:

```php
foreach (array_merge($defaults, $methods) as $method => $returnValue) {
    $mock->shouldReceive($method)->andReturn($returnValue);
}
```

`$method` is a runtime value, so no static tool can tell whether those methods
still exist. The helper is a reasonable way to keep tests short; the trade-off
is that renaming `getUnreadCount` on `InboxStorageService` will not be caught by
anything until the suite runs. For the services where that matters, a handful of
literal `shouldReceive('getUnreadCount')` calls restores static checkability.

**Module-attribute patching.** proxypilot patches module-level imports heavily:
`patch("core.webhook.manager.get_db")`, `patch("core.webhook.manager.decrypt")`,
`patch("core.webhook.manager.logger")`. This is ordinary Python and it is the
right tool for injecting a fake `get_db`. It is invisible to class-contract
checking, because the target is a module attribute rather than a method.

**Tests against protected internals.** proxypilot stubs 22 underscore-prefixed
methods across two files: 15 `_check_*` methods of `PostureEvaluator` in
`backend/tests/unit/core/security_scanners/test_posture.py`, and 7
`_send_webhook*` methods of `WebhookManager` in
`backend/tests/unit/core/test_webhook_manager.py`. Python has no access
control and this is a common pattern, so Nemesis now reports it as a warning
rather than a breach, which is why the default run is clean. It is still worth
a look: a test setup that stubs fifteen internal methods of one class is
asserting against the shape of the implementation, and will need rewriting
whenever that shape changes.

## 6. Repositories that cannot audit themselves

`Momus-MCP` produces 12 findings, all of them intentional: drift fixtures under
`packages/parser-php/test/fixtures/`, `packages/parser-python/test/fixtures/`
and `experiments/fixtures/`. Running Nemesis in its CI needs

```bash
nemesis audit --exclude=fixtures
```

Nemesis has the same problem with its own `fixtures/` tree and the same
workaround. Any repository whose purpose is to detect broken code will keep
broken code on purpose; a tool of this kind should expect that of its peers.

## 7. What the second cycle added

The first cycle only exercised `nemesis audit`. Running `nemesis fixtures`
across the same 54 checkouts turned up nothing wrong with those repositories
and a great deal wrong with the command, which is recorded in the commit
rather than here. Two observations about the repositories are worth keeping.

**Deliberately broken data is everywhere, and that is correct.** Fixture
directories legitimately contain files that will never parse:

| Repository | File | Why it does not parse |
| --- | --- | --- |
| nekyia | `test/fixtures/cursor/chats/.../meta.json` | Truncated on purpose, to exercise the recovery path. |
| oogactx | `tests/fixtures/playwright-console.json` | Contains Markdown, not JSON. |
| mcpobservatory | `tests/analysis/corpus/.../.cursor/mcp.json` | Carries a Unicode right-to-left override, as a security corpus case. |
| Argos-MCP | `tests/tsconfig.json` | JSONC: valid TypeScript config, invalid JSON. |
| Knossos-MCP | `tests/Fixtures/mixed/frontend/tsconfig.json` | Same. |

Any tool that treats an unparsable file under `tests/` as its own failure will
fail in most of these repositories. It is data the tests own, not input the
tool is entitled to. Nemesis now reaches the first three, names them in
`unparsable_fixtures` and does not call the scan partial; the two `tsconfig`
files it never opens, because a TypeScript config is not a fixture wherever it
sits.

**Test corpora look like projects.** mcpobservatory's
`tests/analysis/corpus/cases/` holds dozens of miniature packages, each with
its own `package.json`. Counting those as project metadata, or as fixtures,
both give the wrong answer. A corpus of fake projects is one of the harder
shapes for any repository-walking tool to classify, and it is worth knowing it
is there before pointing a new linter at that repository.

## 8. What the third cycle added

The third cycle targeted the surfaces the first two never touched:
`verify-symbol`, the Rust tier, and the shape of the filesystem itself.

**Momus-MCP's fixtures found a bug in Nemesis.** Momus keeps a Rust drift
corpus under `packages/parser-rust/test/fixtures/drift/`, written against
mockall and annotated with what each case must and must not report.
`supertrait_test.rs` carries a comment saying that a mock of
`trait Derived : Base` stubbing the inherited `add` must not be flagged.
Nemesis flagged it, because the Rust indexer never read supertrait bounds.
`drift_test.rs` plants a `save2` method that does not exist on `Repo`, which
Nemesis now reports. Pointing the two tools at each other was worth more than
any amount of scanning application code, and it is the cheapest review
available: a peer tool's fixtures are a specification someone else wrote down.

**Rust is a minority language here, and it hid a dead feature.** Twelve
checkouts contain Rust (Knossos-MCP, Chaos-MCP, expensis, glyphfall, 3d-wasm,
talos, proxypilot, Momus-MCP, ratio, Sneaky-MCP, termaxa and this one).
Momus-MCP is the only one using mockall, and it does so only inside fixtures.
Every other Rust test in the corpus is a plain `#[cfg(test)]` module with no
test doubles at all. The Rust tier reporting nothing across the corpus was
therefore correct, and it also meant the corpus could never reveal that the
tier did not work. A gap in the sample is not a clean bill of health.

**One repository links its own root.** `oogactx/plugins/redactx` is a symlink
to `/root/oogactx`. Nothing is wrong with that, but any tool that starts
following symlinks without tracking real paths will walk the whole tree twice
and report every finding twice. It caught exactly that regression here within
one sweep.

**Rust test layout varies more than the other languages.** Momus-MCP keeps
Rust test files under a singular `test/` directory next to the non-test source
they exercise, rather than in Cargo's `tests/`. Classifying by directory alone
gets both wrong: the tests are missed, or the neighbouring trait source is
mistaken for a test and never indexed.

## 9. What the fourth cycle added

The fourth cycle worked through every double pattern the README and the spec
advertise, one probe per pattern, instead of testing what the code already
did. That is a cheap and repeatable exercise and it found six defects in
Nemesis, recorded in the commit. One observation about this corpus is worth
keeping.

**Mocking a framework base class is normal, and it defeats static member
checking.** thin-ratio's `api/tests/Feature/Health/HealthChecksTest.php` builds
a partial mock of a Laravel model and stubs `getAttribute`:

```php
$cred = Mockery::mock(ProviderCredential::class)->makePartial();
$cred->shouldReceive('getAttribute')->with('credentials')->andReturn($config);
```

`ProviderCredential` declares none of that; `getAttribute` comes from
`Illuminate\Database\Eloquent\Model`, which lives in `vendor/` and is never
walked. Nemesis reported it as a definite ghost method until the ancestry check
landed, and it is now a warning.

The same shape appears wherever a framework supplies behaviour through
inheritance: Eloquent models, Symfony controllers, Django models, React
components. Any tool reasoning about members from source alone will either
report these as missing or has already decided not to look. It is worth
knowing which, before trusting a clean result on a framework-heavy repository.

## Method

Each repository was audited from its root with `nemesis audit --json` at default
strictness (`breaking_only`), with a 300 s timeout, both before and after the
tool fixes landed. Timings are wall clock from a sequential sweep on one
machine and are good to a few percent, not better. Totals across the 54 checkouts:

| | Before | After |
| --- | --- | --- |
| Violations reported | 139 | 32 |
| Repositories exiting 0 | 45 | 51 |
| Repositories exiting 2 (operational) | 3 | 1 |
| Total wall time | ~151 s | ~55 s |

All 32 remaining findings are the deliberate fixtures in Nemesis (20) and
Momus-MCP (12). The drop from 139 is false positives removed, not detection
lost: a control run that renamed a production method and changed a declared
return type in an otherwise clean repository still reported both.

A second cycle repeated the sweep for `nemesis fixtures`:

| | Before | After |
| --- | --- | --- |
| Files treated as fixtures | 19,431 | 205 |
| Violations reported | 17,728 | 2 |
| Repositories exiting 0 | 0 | 52 |
| Repositories exiting 2 | 52 | 1 |
| Timeouts and crashes | 2 | 0 |
| Total wall time | ~371 s | ~34 s |

The two surviving findings are the intentionally stale fixture in this
repository. The single exit 2 is workflow-dockerized, for the reason in
section 1.

A third cycle repeated both sweeps after the Rust and symlink fixes. Nothing
changed for any repository other than this one, which gained two findings from
the Rust drift fixtures added alongside the fix:

| | Cycle 2 | Cycle 3 |
| --- | --- | --- |
| Audit violations | 32 | 35 |
| Audit repositories exiting 0 | 51 | 51 |
| Rust test files newly discovered | 0 | 54 |
| Fixture violations | 2 | 2 |
| Fixture repositories exiting 0 | 52 | 52 |

Of the three extra audit findings, two are this repository's new Rust drift
fixtures and one is the genuine `save2` drift in Momus-MCP's Rust corpus. No
other repository's count moved. The 54 additional test files are the inline
`#[cfg(test)]` modules now scanned across seven Rust repositories (termaxa 21,
3d-wasm 9, talos 8, Momus-MCP 5, Knossos-MCP 4, glyphfall 4, and this one 3);
none of them contains a test double, so none of them changed a count.

`audit` and `verify-symbol` were also compared directly over every flagged
symbol in this repository and in Momus-MCP: the two produce identical finding
sets, 22 and 12 respectively.

A fourth cycle probed every documented double pattern and fixed six defects in
Nemesis. Nothing moved across the corpus: audit 51 clean and 35 violations,
fixtures 52 clean and 2, one partial scan in each. The only repository whose
result changed during the cycle was thin-ratio, which briefly gained a finding
from the Laravel model in section 9 before the ancestry check reclassified it
as a warning.
