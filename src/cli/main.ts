#!/usr/bin/env node
// ---------------------------------------------------------------------------
// nemesis CLI: audit / verify-symbol / fixtures.
// ---------------------------------------------------------------------------

import path from 'node:path';
import process from 'node:process';
import { runAudit, verifySymbol } from '../core/runtime.js';
import { checkFixtures } from '../fixtures/staleFixtures.js';
import { renderJson, renderText } from '../core/report.js';
import type { LanguageId, Strictness } from '../core/types.js';

interface CliArgs {
  command: string;
  positional: string[];
  json: boolean;
  strictness: Strictness;
  languages: LanguageId[];
  includes: string[];
  excludes: string[];
  help: boolean;
}

const USAGE = `nemesis — static contract-integrity inspection for test doubles

Usage:
  nemesis audit [paths...] [--json] [--strictness=<mode>] [--lang=<l1,l2>]
  nemesis verify-symbol <SymbolName> [--json]
  nemesis fixtures [paths...] [--json]

Modes: all | untyped_only | breaking_only (default: breaking_only)
Languages: typescript, javascript, php, python, rust (default: all)

Exit codes: 0 = clean, 1 = violations found, 2 = operational error.
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'audit',
    positional: [],
    json: false,
    strictness: 'breaking_only',
    languages: ['typescript', 'javascript', 'php', 'python', 'rust'],
    includes: [],
    excludes: [],
    help: false,
  };
  const rest = argv.filter((a) => a !== '--');
  let i = 0;
  let first = true;
  while (i < rest.length) {
    const a = rest[i];
    i++;
    if (!a) continue;
    if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--strictness=')) {
      const v = a.split('=')[1] as Strictness;
      if (['all', 'untyped_only', 'breaking_only'].includes(v)) args.strictness = v;
    } else if (a.startsWith('--lang=')) {
      const langs = (a.split('=')[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is LanguageId =>
          ['typescript', 'javascript', 'php', 'python', 'rust'].includes(s),
        );
      if (langs.length) args.languages = langs;
    } else if (a.startsWith('--include=')) {
      args.includes.push(a.split('=')[1] ?? '');
    } else if (a.startsWith('--exclude=')) {
      args.excludes.push(a.split('=')[1] ?? '');
    } else if (!a.startsWith('--')) {
      if (first && ['audit', 'verify-symbol', 'fixtures'].includes(a)) {
        args.command = a;
        first = false;
      } else {
        args.positional.push(a);
        first = false;
      }
    }
  }
  return args;
}

function toStrictness(v: string | undefined): Strictness {
  return v === 'all' || v === 'untyped_only' || v === 'breaking_only' ? v : 'breaking_only';
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const rootDir = process.cwd();
  const runtimeOpts = {
    rootDir,
    ...(args.positional.length ? { paths: args.positional } : {}),
    strictness: toStrictness(args.strictness as string),
    languages: args.languages,
    extraExcludes: args.excludes,
    testRoots: args.includes,
  };

  try {
    if (args.command === 'audit') {
      const result = await runAudit(runtimeOpts);
      if (args.json) {
        console.log(renderJson(result));
      } else {
        console.log(renderText(result));
      }
      return result.violations.length > 0 ? 1 : 0;
    }

    if (args.command === 'verify-symbol') {
      const symbol = args.positional[0];
      if (!symbol) {
        console.error('verify-symbol requires a symbol name');
        return 2;
      }
      // Note: the symbol occupies the positional slot; no path restriction.
      const report = await verifySymbol(
        {
          rootDir,
          strictness: toStrictness(args.strictness as string),
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
          return 0;
        }
        console.log(`Symbol: ${report.symbol}`);
        if (report.signature) console.log(`  ${report.signature}`);
        if (report.doubles.length === 0) {
          console.log('  No test doubles point at this symbol.');
        } else {
          for (const d of report.doubles) {
            console.log(
              `  ${d.valid ? '✓ valid' : '✗ INVALID'}  ${d.file}:${d.line}  (${d.framework}${d.method ? ` :: ${d.method}` : ''})`,
            );
            for (const v of d.violations) console.log(`      ${v.type}: ${v.message}`);
          }
        }
      }
      return 0;
    }

    if (args.command === 'fixtures') {
      const result = await checkFixtures(rootDir, args.positional);
      const resultJson = {
        summary: { scanned_fixtures: result.scanned, violations_count: result.violations.length },
        violations: result.violations,
      };
      console.log(args.json ? JSON.stringify(resultJson, null, 2) : renderText({
        summary: {
          scanned_test_files: result.scanned,
          doubles_inspected: 0,
          violations_count: result.violations.length,
        },
        violations: result.violations,
      }));
      return result.violations.length > 0 ? 1 : 0;
    }

    console.error(`Unknown command: ${args.command}`);
    return 2;
  } catch (err) {
    console.error(`nemesis: operational error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

main().then((code) => {
  process.exitCode = code;
});
