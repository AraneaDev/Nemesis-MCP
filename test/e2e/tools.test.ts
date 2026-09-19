import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(root, 'src', 'cli', 'main.ts');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

describe('nemesis verify-symbol end-to-end', () => {
  it('lists doubles with validity flags and fails when one is invalid', () => {
    const { status, stdout } = runCli(['verify-symbol', 'UserService'], root);
    expect(stdout).toContain('fixtures/ts/tests/UserService.spec.ts:7');
    expect(stdout).toContain('✗ INVALID');
    expect(stdout).toContain('✓ valid');
    // Printing a stale double and exiting 0 made the command useless as a
    // pre-merge gate, which is the one job it has.
    expect(status).toBe(1);
  }, 120_000);

  it('exits 0 when every double still matches', () => {
    const { status, stdout } = runCli(
      ['verify-symbol', 'CatalogService', '--exclude=dogfood-repo'],
      root,
    );
    expect(stdout).not.toContain('✗ INVALID');
    expect(status).toBe(0);
  }, 120_000);

  it('reports unresolved symbols', () => {
    const { status, stdout } = runCli(['verify-symbol', 'NoSuchClass'], root);
    expect(stdout).toContain('could not be resolved');
    expect(status).toBe(0);
  }, 120_000);
});

describe('nemesis CLI argument handling', () => {
  it('rejects an unknown command instead of scanning it as a path', () => {
    const { status, stderr } = runCli(['verifysymbol', 'UserService'], root);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command 'verifysymbol'");
  }, 120_000);

  it('rejects an unknown option instead of ignoring it', () => {
    // `--strictnes=all` used to be dropped, leaving the default strictness
    // in place and the run exiting 0.
    const { status, stderr } = runCli(['audit', '--strictnes=all'], root);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option '--strictnes=all'");
  }, 120_000);

  it('rejects an invalid strictness value', () => {
    const { status, stderr } = runCli(['audit', '--strictness=nonsense'], root);
    expect(status).toBe(2);
    expect(stderr).toContain("Invalid --strictness 'nonsense'");
  }, 120_000);

  it('rejects an unknown language', () => {
    const { status, stderr } = runCli(['audit', '--lang=cobol'], root);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown language 'cobol'");
  }, 120_000);

  it('prints help and the version without scanning', () => {
    const help = runCli(['--help'], root);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    const version = runCli(['--version'], root);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 120_000);
});

describe('nemesis fixtures end-to-end', () => {
  it('flags stale fixture records', () => {
    const { status, stdout } = runCli(
      ['fixtures', 'fixtures/fixtures-data', '--strictness=all', '--json'],
      root,
    );
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.summary.scanned_fixtures).toBe(1);
    const messages = result.violations.map((v: { message: string }) => v.message);
    expect(messages.some((m: string) => m.includes("missing required field 'name'"))).toBe(true);
    expect(messages.some((m: string) => m.includes("'username' which no longer exists"))).toBe(
      true,
    );
  }, 120_000);
});

describe('audit and verify-symbol agree', () => {
  it('reports the same findings through both commands', () => {
    // The two commands share an analyzer but not a code path into it. If they
    // ever disagree, one of them is lying about the state of the repository.
    const audit = runCli(['audit', 'fixtures', '--strictness=all', '--json'], root);
    const violations = JSON.parse(audit.stdout).violations as Array<{
      file: string;
      line: number;
      type: string;
      target: string;
      double_type: string;
    }>;
    expect(violations.length).toBeGreaterThan(0);

    const key = (v: { file: string; line: number; type: string; target: string }) =>
      `${v.file}:${v.line}:${v.type}:${v.target}`;
    // A manual mock in `__mocks__` belongs to a module rather than to a
    // symbol, so verify-symbol, which is asked about one symbol, never
    // reports it. Everything else has to line up.
    const attributable = violations.filter((v) => v.double_type !== 'manual_mock');
    const fromAudit = new Set(attributable.map(key));
    const symbols = [...new Set(attributable.map((v) => v.target.split('::')[0]))];

    const fromVerify = new Set<string>();
    for (const symbol of symbols) {
      const out = runCli(['verify-symbol', symbol as string, '--strictness=all', '--json'], root);
      const report = JSON.parse(out.stdout) as {
        resolved: boolean;
        doubles: Array<{ violations: typeof violations }>;
      };
      // A target that audit reports on always has doubles here, whether or not
      // the name resolves: an unresolvable name is the deleted-target finding,
      // and answering it with silence would make this comparison vacuous.
      expect(report.doubles.length).toBeGreaterThan(0);
      for (const double of report.doubles) {
        for (const v of double.violations) fromVerify.add(key(v));
      }
    }

    expect([...fromVerify].sort()).toEqual([...fromAudit].sort());
  }, 300_000);
});
