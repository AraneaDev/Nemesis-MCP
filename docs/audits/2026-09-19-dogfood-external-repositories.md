# Dogfood run: issues found in other repositories

Date: 2026-09-19
Scope: every git repository under `/root` (53 checkouts), audited with
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

**Tests against protected internals.** `proxypilot`'s
`backend/tests/unit/core/security_scanners/test_posture.py` patches 22
`_check_*` methods of `PostureEvaluator` in a single test setup. Python has no
access control and this is a common pattern, so Nemesis now reports it as a
warning rather than a breach. It is still worth a look: a test that stubs 22
internal methods is asserting against the shape of the implementation, and will
need rewriting whenever that shape changes.

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

## Method

Each repository was audited from its root with `nemesis audit --json` at default
strictness (`breaking_only`), with a 300 s timeout, both before and after the
tool fixes landed. Totals across the 53 checkouts:

| | Before | After |
| --- | --- | --- |
| Violations reported | 139 | 32 |
| Repositories exiting 0 | 45 | 51 |
| Repositories exiting 2 (operational) | 3 | 1 |
| Total wall time | 150.9 s | 52.1 s |

All 32 remaining findings are the deliberate fixtures in Nemesis (20) and
Momus-MCP (12). The drop from 139 is false positives removed, not detection
lost: a control run that renamed a production method and changed a declared
return type in an otherwise clean repository still reported both.
