#!/usr/bin/env node
// ---------------------------------------------------------------------------
// nemesis CLI: audit / verify-symbol / fixtures.
// ---------------------------------------------------------------------------

import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAudit, verifySymbol } from '../core/runtime.js';
import { checkFixtures, filterFixtureFindings } from '../fixtures/staleFixtures.js';
import { exitCodeFor, renderJson, renderText } from '../core/report.js';
import { packageVersion } from '../core/version.js';
import type { LanguageId, ScanDiagnostic, Strictness } from '../core/types.js';

const COMMANDS = ['audit', 'verify-symbol', 'fixtures'] as const;
type Command = (typeof COMMANDS)[number];

const STRICTNESS: Strictness[] = ['all', 'untyped_only', 'breaking_only'];
const LANGUAGES: LanguageId[] = ['typescript', 'javascript', 'php', 'python', 'rust'];

export interface CliArgs {
  command: Command;
  positional: string[];
  json: boolean;
  strictness: Strictness;
  languages: LanguageId[];
  includes: string[];
  excludes: string[];
  allowPartial: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = `nemesis — static contract-integrity inspection for test doubles

Usage:
  nemesis audit [paths...] [options]
  nemesis verify-symbol <SymbolName> [options]
  nemesis fixtures [paths...] [options]

Options:
  --json                 Emit machine-readable JSON instead of text.
  --strictness=<mode>    ${STRICTNESS.join(' | ')} (default: breaking_only)
  --lang=<l1,l2>         ${LANGUAGES.join(', ')} (default: all)
  --include=<path>       Extra path to scan; repeatable.
  --exclude=<dir>        Directory name to skip; repeatable.
  --allow-partial        Do not fail merely because files were skipped.
  -h, --help             Show this help.
  -V, --version          Show the version.

Exit codes:
  0  clean scan, nothing to report
  1  violations found
  2  operational error, or a partial scan (see --allow-partial)
`;

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  const args: CliArgs = {
    command: 'audit',
    positional: [],
    json: false,
    strictness: 'breaking_only',
    languages: [...LANGUAGES],
    includes: [],
    excludes: [],
    allowPartial: false,
    help: false,
    version: false,
  };

  const rest = argv.filter((a) => a !== '--');
  let sawCommand = false;

  for (const a of rest) {
    if (!a) continue;

    if (a === '--json') {
      args.json = true;
    } else if (a === '--allow-partial') {
      args.allowPartial = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--version' || a === '-V') {
      args.version = true;
    } else if (a.startsWith('--strictness=')) {
      const v = a.slice('--strictness='.length);
      if (!STRICTNESS.includes(v as Strictness)) {
        return {
          ok: false,
          error: `Invalid --strictness '${v}'. Expected one of: ${STRICTNESS.join(', ')}.`,
        };
      }
      args.strictness = v as Strictness;
    } else if (a.startsWith('--lang=')) {
      const raw = a
        .slice('--lang='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (raw.length === 0) {
        return { ok: false, error: '--lang needs at least one language.' };
      }
      const unknown = raw.filter((s) => !LANGUAGES.includes(s as LanguageId));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `Unknown language ${unknown.map((u) => `'${u}'`).join(', ')}. Expected one of: ${LANGUAGES.join(', ')}.`,
        };
      }
      args.languages = raw as LanguageId[];
    } else if (a.startsWith('--include=')) {
      const v = a.slice('--include='.length);
      if (v === '') return { ok: false, error: '--include needs a path.' };
      args.includes.push(v);
    } else if (a.startsWith('--exclude=')) {
      const v = a.slice('--exclude='.length);
      if (v === '') return { ok: false, error: '--exclude needs a directory name.' };
      args.excludes.push(v);
    } else if (a.startsWith('-')) {
      // A silently ignored flag is a silently wrong scan: a typo in
      // `--strictness` used to leave the default in place and exit 0.
      return { ok: false, error: `Unknown option '${a}'.` };
    } else if (!sawCommand) {
      // The first bare word is the command. Treating an unknown one as a scan
      // path turned `nemesis verifysymbol Foo` into an audit of two paths that
      // do not exist, reported as an operational error about a missing file.
      if (!COMMANDS.includes(a as Command)) {
        return {
          ok: false,
          error: `Unknown command '${a}'. Expected one of: ${COMMANDS.join(', ')}.`,
        };
      }
      args.command = a as Command;
      sawCommand = true;
    } else {
      args.positional.push(a);
    }
  }

  return { ok: true, args };
}

/** One line per distinct reason, so an exit 2 always explains itself. */
function warnAboutDiagnostics(diagnostics: ScanDiagnostic[]): void {
  const fatal = diagnostics.filter((d) => d.fatal);
  const skipped = diagnostics.filter((d) => !d.fatal);
  if (fatal.length > 0) {
    console.error(`nemesis: ${fatal.length} file(s) could not be scanned:`);
    for (const d of fatal.slice(0, 5)) {
      console.error(`  ${d.file}: ${d.message}`);
    }
    if (fatal.length > 5) console.error(`  ... and ${fatal.length - 5} more`);
  }
  if (skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const d of skipped) {
      reasons.set(d.message, (reasons.get(d.message) ?? 0) + 1);
    }
    console.error(
      `nemesis: partial scan, ${skipped.length} file(s) skipped. The result cannot be called clean.`,
    );
    for (const [message, count] of reasons) {
      console.error(`  ${count}x ${message}`);
    }
    console.error('  Exclude them with --exclude=<dir>, or accept the gap with --allow-partial.');
  }
}

/**
 * Execute a parsed command. `rootDir` is a parameter rather than a read of
 * `process.cwd()` so the commands can be driven in a test without a
 * subprocess and without mutating the working directory.
 */
export async function run(args: CliArgs, rootDir = process.cwd()): Promise<number> {
  try {
    return await execute(args, rootDir);
  } catch (err) {
    console.error(
      `nemesis: operational error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
}

async function execute(args: CliArgs, rootDir: string): Promise<number> {
  const runtimeOpts = {
    rootDir,
    ...(args.positional.length || args.includes.length
      ? { paths: [...args.positional, ...args.includes] }
      : {}),
    strictness: args.strictness,
    languages: args.languages,
    extraExcludes: args.excludes,
  };

  if (args.command === 'audit') {
    const result = await runAudit(runtimeOpts);
    console.log(args.json ? renderJson(result) : renderText(result));
    const diagnostics = result.summary.diagnostics ?? [];
    if (diagnostics.length > 0) warnAboutDiagnostics(diagnostics);
    return exitCodeFor(result, args.strictness, {
      allowPartial: args.allowPartial,
    });
  }

  if (args.command === 'verify-symbol') {
    const symbol = args.positional[0];
    if (!symbol) {
      console.error('verify-symbol requires a symbol name.');
      return 2;
    }
    const report = await verifySymbol(
      {
        rootDir,
        strictness: args.strictness,
        languages: args.languages,
        extraExcludes: args.excludes,
      },
      symbol,
    );

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (!report.resolved) {
        console.log(`Symbol '${report.symbol}' could not be resolved in the production code.`);
      } else {
        console.log(`Symbol: ${report.symbol}`);
        if (report.signature) console.log(`  ${report.signature}`);
      }
      if (report.doubles.length === 0) {
        if (report.resolved) console.log('  No test doubles point at this symbol.');
      } else {
        for (const d of report.doubles) {
          console.log(
            `  ${d.valid ? '✓ valid' : '✗ INVALID'}  ${d.file}:${d.line}  (${d.framework}${d.method ? ` :: ${d.method}` : ''})`,
          );
          for (const v of d.violations) console.log(`      ${v.type}: ${v.message}`);
        }
      }
    }

    const diagnostics = report.diagnostics ?? [];
    if (diagnostics.length > 0) warnAboutDiagnostics(diagnostics);
    if (diagnostics.some((d) => d.fatal)) return 2;
    if (diagnostics.length > 0 && !args.allowPartial) return 2;
    // A double that no longer matches its target is the whole point of the
    // command; reporting it and exiting 0 made it useless as a CI gate.
    return report.doubles.some((d) => !d.valid) ? 1 : 0;
  }

  // fixtures
  const result = await checkFixtures(rootDir, args.positional);
  const violations = filterFixtureFindings(result.violations, args.strictness);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          summary: {
            scanned_fixtures: result.scanned,
            unmatched_fixtures: result.unmatched,
            ...(result.unparsable.length ? { unparsable_fixtures: result.unparsable } : {}),
            violations_count: violations.length,
            ...(result.diagnostics.length
              ? { diagnostics: result.diagnostics, partial: true }
              : {}),
          },
          violations,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      renderText({
        summary: {
          scanned_test_files: result.scanned,
          doubles_inspected: 0,
          violations_count: violations.length,
        },
        violations,
      }),
    );
  }
  if (result.diagnostics.length > 0) warnAboutDiagnostics(result.diagnostics);
  if (result.diagnostics.some((d) => d.fatal)) return 2;
  if (result.diagnostics.length > 0 && !args.allowPartial) return 2;
  return violations.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `nemesis: could not read arguments: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  if (!parsed.ok) {
    console.error(`nemesis: ${parsed.error}`);
    console.error(`\n${USAGE}`);
    return 2;
  }

  const { args } = parsed;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.version) {
    console.log(packageVersion());
    return 0;
  }

  return run(args);
}

/**
 * True only when this file is what node was asked to run. Without the guard,
 * importing `parseArgs` from a test kicks off a full audit of the working
 * directory and leaks its exit code into the caller.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // `npm link` installs the bin as a symlink, so argv[1] is /usr/bin/nemesis
  // while import.meta.url points at the real dist file. Compare real paths.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  try {
    return real(entry) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(
        `nemesis: unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 2;
    });
}
