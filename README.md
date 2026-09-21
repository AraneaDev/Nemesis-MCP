<div align="center">

# Nemesis-MCP

**A mock outlives the code it stands for, and the suite goes green anyway.**

[![Release](https://img.shields.io/github/v/release/AraneaDev/Nemesis-MCP?label=release)](https://github.com/AraneaDev/Nemesis-MCP/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/AraneaDev/Nemesis-MCP/ci.yml?label=CI)](https://github.com/AraneaDev/Nemesis-MCP/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FAraneaDev%2FNemesis-MCP%2Fgh-pages%2Fcoverage.json)](https://github.com/AraneaDev/Nemesis-MCP/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/AraneaDev/Nemesis-MCP?label=license&color=yellow&cacheSeconds=3600)](./LICENSE)
[![Language](https://img.shields.io/github/languages/top/AraneaDev/Nemesis-MCP)](https://github.com/AraneaDev/Nemesis-MCP)
[![Last commit](https://img.shields.io/github/last-commit/AraneaDev/Nemesis-MCP?label=last%20commit)](https://github.com/AraneaDev/Nemesis-MCP/commits/main)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![Status](https://img.shields.io/badge/status-in%20development-orange)](#install)

</div>

> **Nemesis** (Νέμεσις) is the Greek goddess who deals out what is due. Her name comes from
> _némein_, to apportion, and her business is proportion: she takes back what was claimed beyond its
> warrant. A test double claims to stand in for something real. This tool checks whether it still
> has the right to.

**TL;DR:** Nemesis reads your test doubles and your production code, and reports every place a mock,
stub or spy no longer matches the thing it replaces. It runs no tests. Nothing is executed, imported
or booted, so the answer is the same every time you ask.

The failure it exists for is specific. When a signature changes, a mocked unit test keeps passing,
because the mock defines the contract rather than the code does. The suite stays green while the
thing it guards has moved. Agent-written tests reach that state faster than handwritten ones,
because a generated mock records the shape of the code on the day it was generated and nothing ever
revisits it.

> **Status:** pre-release. Nemesis-MCP is **not yet published to npm**. The source is public on
> [GitHub](https://github.com/AraneaDev/Nemesis-MCP), so install from source, see
> [Install](#install). Any `npm install -g` or `npx` line in this README describes the planned
> published experience and does not work yet.

**Contents:** [What it finds](#what-it-finds) · [Install](#install) · [Quick start](#quick-start) ·
[Languages](#supported-ecosystems) · [Fixtures](#fixtures) · [Discovery](#discovery) ·
[Suppression](#suppression) · [Development](#development)

---

## What it finds

Four violation types, and nothing else. The set is fixed on purpose: a checker that grows a category
per bug becomes a checker nobody reads.

| Type                | Meaning                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHOST_METHOD`      | The double stubs a member that is not there any more, with a did-you-mean from edit distance. Also covers an imported target that the module no longer exports, and a module mock supplying a key the module does not have.                                                                    |
| `ARITY_MISMATCH`    | The double passes more arguments than the method accepts, omits required ones, passes a literal of the wrong type, names an argument matching no parameter, or supplies a replacement function whose own signature the method no longer offers.                                                |
| `RETURN_DRIFT`      | The pinned return value cannot satisfy the declared return type. Includes an object literal missing a required field or carrying a stale one, an enum case the enum no longer has, a promise handed back by a method that is not awaitable, and a fluent chain on a method that is not fluent. |
| `VISIBILITY_BREACH` | The double replaces a member it cannot legitimately replace: a private or protected method, a final method, a final class, a static reached through an instance double, an accessor spied without an access type, or a PHP constructor.                                                        |

Every finding carries a confidence. `definite` is what syntax alone can prove and is worth failing a
build over. `warning` is a heuristic, and the difference is deliberate: two differing named types
are only a warning, because the class relating them usually lives in `vendor/` or `node_modules/`,
which are never walked. A Python method with one leading underscore is a naming convention rather
than access control, so stubbing it warns; only a name-mangled `__member` is a definite breach. A
return value written behind a type assertion is read through the cast, because that is where drift
hides, but a field missing from it only warns: `as unknown as T` is also how a deliberate partial
stub is written, and syntax cannot tell the two apart. A stubbed method whose name is built at
runtime, such as `shouldReceive($method)` inside a loop, names nothing checkable and is skipped
entirely.

**Where the evidence runs out, the answer is silence.** A warning that is wrong most of the time
teaches people to ignore the tool, which costs more than the finding was worth.

## Install

```bash
git clone https://github.com/AraneaDev/Nemesis-MCP.git
cd Nemesis-MCP
npm install
npm run build
```

That gives you two binaries, `nemesis` for the command line and `nemesis-mcp` for the MCP server.

> **Planned, not available yet:** once published, this becomes `npm install -g nemesis-mcp`, or
> `npx nemesis-mcp` on demand. Neither works until the package ships.

## Quick start

```bash
# Every double in the repository, checked against the code it stands for
node dist/cli/main.js audit

# One symbol, and the state of every double that names it
node dist/cli/main.js verify-symbol PaymentGateway

# JSON fixtures against the DTOs they are supposed to describe
node dist/cli/main.js fixtures
```

`audit` exits 0 when clean, 1 on a violation, and 2 when a file was not read, so it works as
a pre-merge gate without further wiring. `--strictness=all` includes warnings,
`--strictness=breaking_only` is the default, and `--allow-partial` accepts an incomplete scan
knowingly rather than failing on it.

A file the grammar could not fully read is a third case, and it is not exit 2. The parse recovers,
everything around the unreadable region is still indexed, and the run says how many files that
happened to. Only a file that was not read at all, because of a read error or a size budget, leaves
a gap in the symbol graph and makes the scan partial.

The summary says how much of the scan it actually compared:

```
Scanned 174 test file(s), inspected 4772 double(s).
  2772 compared, 1521 unresolved, 475 with no contract to check, 4 unnamed.
```

That second line matters more than the first. A double whose target cannot be resolved was counted,
not checked, and a clean result over mostly-unresolved doubles means the scan found nothing because
it could see nothing.

### As an MCP server

```json
{
  "mcpServers": {
    "nemesis": {
      "command": "node",
      "args": ["/absolute/path/to/Nemesis-MCP/dist/mcp/main.js"]
    }
  }
}
```

Three tools: `nemesis_audit` for a whole tree, `nemesis_verify_symbol` for one symbol before you
change it, and `nemesis_stale_fixtures` for JSON and YAML fixtures against their DTOs.

The useful habit for an agent is to call `nemesis_verify_symbol` before editing a class and
`nemesis_audit` after, so a rename that stranded a mock is caught in the same turn that made it
rather than in review.

## Supported ecosystems

| Language               | Frameworks                 | Patterns                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, JavaScript | Vitest, Jest               | `vi.spyOn` and `jest.spyOn`, `vi.mocked`, `vi.mock` with a factory, manual mocks in `__mocks__`, `mockReturnValue`, `mockResolvedValue`, `mockRejectedValue`, `mockImplementation`, `mockReturnThis`, `toHaveBeenCalledWith`, spies on statics and on `Klass.prototype`, and module members reached through a namespace or default import                  |
| PHP                    | PHPUnit, Pest, Mockery     | `createMock`, `createStub`, `createConfiguredMock`, `createPartialMock`, `getMockBuilder()->onlyMethods()`, `getMockForAbstractClass`, `getMockForTrait`, `expects()->method()`, `with()`, every value of `willReturnOnConsecutiveCalls`, `willReturnCallback`, `Mockery::mock` including the `'Foo[a,b]'` partial form, `shouldReceive`, `andReturnUsing` |
| Python                 | pytest-mock, unittest.mock | `mocker.patch`, `patch`, `patch.object`, `patch.multiple`, `create_autospec`, `Mock(spec=X)`, `return_value=`, `side_effect=` with a lambda, `assert_called_with`, and module attributes patched where they are used rather than where they are defined                                                                                                    |
| Rust                   | mockall                    | `MockFoo::new()` and `::default()` with `expect_<method>()`, arity from `.with(...)`, return values from `return_const(...)` and `returning(...)`, plus `#[automock]` and `mock! { }` blocks                                                                                                                                                               |

A module is a first-class target, not only a class. `patch("core.system.subprocess_runner.run")` and
`vi.mock('../db.js', factory)` both resolve to the file they name, and a name that file imports is a
member of it, because that is where Python convention says to patch it.

## Fixtures

`nemesis fixtures` compares JSON and YAML fixtures against the DTOs they describe: a missing
required field, a field that no longer exists, a value of the wrong type, an enum case that was
renamed, and the same questions asked again inside nested objects and arrays.

A fixture is matched to a DTO by name or by shape overlap, and an ambiguous match is left alone.
Config files, lock files and anything under a config directory are never treated as fixtures.

## Discovery

Zero configuration. Test files are found by the conventions each ecosystem already uses, and
`.gitignore` is honoured, along with `.nemesisignore` if you add one. `node_modules`, `vendor`,
`dist`, `build` and the rest are never walked. Symlinks are followed once, by real path, so a
directory linked into its own tree cannot make the walk loop.

Scans are bounded: 2 MB per file, 10,000 files, 200 MB in total and 120 seconds. Hitting a bound
exits 2 rather than reporting a clean result over a partial read.

## Suppression

```ts
// nemesis-ignore-next-line
vi.spyOn(legacy, 'gone').mockReturnValue(true);
```

One line, one comment, no configuration file. A suppression that has to be found in a separate file
is a suppression nobody revisits.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Never pipe a gate into `grep` or `tail`. A pipe reports the exit status of the last command, so a
failing gate reads as a passing one. That mistake shipped a commit through a red test suite during
development, twice.

Fixtures under `fixtures/experiments/` are deliberately broken, one directory per drift scenario,
and each one is expected to produce exactly the findings its README comment describes.

## License

[MIT](LICENSE).

---

Built by [Tim Schipper](https://tim-schipper.nl/en) and released as open source under
[Aranea Development](https://aranea-development.nl).
