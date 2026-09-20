import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(root, 'src', 'cli', 'main.ts');

function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

describe('nemesis audit end-to-end', () => {
  // `audit .` is the most natural way to ask for the whole repository, and it
  // matched nothing: the requested path was compared verbatim against
  // repository-relative file paths, which never start with `./`. The audit
  // reported a clean, empty result and exited 0.
  it('scans the whole tree when the path is given as "."', () => {
    const pythonFixture = path.join(root, 'fixtures', 'python');
    const dot = JSON.parse(
      runCli(['audit', '.', '--strictness=all', '--json'], pythonFixture).stdout,
    );
    expect(dot.summary.scanned_test_files).toBeGreaterThan(0);
    expect(dot.summary.doubles_inspected).toBeGreaterThan(0);

    // The same scan, named from the repository root, has to agree.
    const named = JSON.parse(
      runCli(['audit', 'fixtures/python', '--strictness=all', '--json'], root).stdout,
    );
    expect(dot.summary.scanned_test_files).toBe(named.summary.scanned_test_files);
    expect(dot.summary.violations_count).toBe(named.summary.violations_count);
  }, 120_000);

  it('spells a requested path the same way however it is written', () => {
    const summaryFor = (p: string) =>
      JSON.parse(runCli(['audit', p, '--strictness=all', '--json'], root).stdout).summary;
    const plain = summaryFor('fixtures/python');
    for (const variant of ['./fixtures/python', 'fixtures/python/', 'fixtures/./python']) {
      expect(summaryFor(variant).scanned_test_files).toBe(plain.scanned_test_files);
    }
  }, 120_000);

  it('finds all four violation types across ecosystems', () => {
    const { stdout, status } = runCli(['audit', 'fixtures', '--strictness=all', '--json'], root);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.summary.scanned_test_files).toBeGreaterThanOrEqual(4);
    expect(result.summary.doubles_inspected).toBeGreaterThanOrEqual(13);

    const types = new Set(result.violations.map((v: { type: string }) => v.type));
    expect(types.has('GHOST_METHOD')).toBe(true);
    expect(types.has('ARITY_MISMATCH')).toBe(true);
    expect(types.has('RETURN_DRIFT')).toBe(true);
    expect(types.has('VISIBILITY_BREACH')).toBe(true);

    const files = new Set(result.violations.map((v: { file: string }) => v.file));
    expect([...files].some((f) => f.includes('/php/'))).toBe(true);
    expect([...files].some((f) => f.includes('/ts/'))).toBe(true);
    expect([...files].some((f) => f.includes('/python/'))).toBe(true);
  }, 120_000);

  it('returns an operational error for a missing scan path', () => {
    const { status } = runCli(['audit', 'fixtures/does-not-exist'], root);
    expect(status).toBe(2);
  }, 120_000);

  it('exit code 0 on clean repo', () => {
    const { status } = runCli(['audit', 'fixtures/rust'], root);
    expect(status).toBe(0);
  }, 120_000);

  it('dogfoods a repository-shaped TypeScript project', () => {
    const { stdout, status } = runCli(
      ['audit', 'fixtures/dogfood-repo', '--strictness=all', '--json'],
      root,
    );
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.summary.scanned_test_files).toBe(1);
    expect(result.summary.doubles_inspected).toBe(3);
    expect(new Set(result.violations.map((v: { type: string }) => v.type))).toEqual(
      new Set(['GHOST_METHOD', 'ARITY_MISMATCH', 'RETURN_DRIFT']),
    );
  }, 120_000);

  it('runs the multi-experiment matrix for every supported language', () => {
    const { stdout, status } = runCli(
      ['audit', 'fixtures/experiments', '--strictness=all', '--json'],
      root,
    );
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.summary.scanned_test_files).toBeGreaterThanOrEqual(16);
    expect(result.summary.doubles_inspected).toBeGreaterThanOrEqual(16);

    expect(result.summary.scanned_test_files).toBe(37);
    expect(result.summary.doubles_inspected).toBe(65);
    const files = result.violations.map((v: { file: string }) => v.file);
    for (const languageDir of ['typescript', 'javascript', 'php', 'python', 'rust']) {
      expect(files.some((file: string) => file.includes(`experiments/${languageDir}/`))).toBe(true);
    }
  }, 120_000);

  it('says nothing about a PHP class whose magic methods answer to anything', () => {
    // `__call` and `__get` make every name valid, and Mockery's proxy routes
    // through them. Both commands have to stay quiet.
    const audit = runCli(['audit', 'fixtures/magic-php', '--strictness=all', '--json'], root);
    expect(audit.status).toBe(0);
    expect(JSON.parse(audit.stdout).violations).toEqual([]);
    const fixtures = runCli(['fixtures', 'fixtures/magic-php', '--strictness=all', '--json'], root);
    expect(fixtures.status).toBe(0);
    expect(JSON.parse(fixtures.stdout).violations).toEqual([]);
  }, 120_000);

  it('keeps a clean repository-shaped project clean', () => {
    const { stdout, status } = runCli(['audit', 'fixtures/dogfood-clean', '--json'], root);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.summary.scanned_test_files).toBe(1);
    expect(result.violations).toEqual([]);
  }, 120_000);

  it('ghost method message includes did-you-mean', () => {
    const { stdout } = runCli(['audit', 'fixtures', '--strictness=all', '--json'], root);
    const result = JSON.parse(stdout);
    const ghost = result.violations.find((v: { type: string }) => v.type === 'GHOST_METHOD');
    expect(ghost.suggestion).toBeTruthy();
  }, 120_000);

  it('says how many doubles it actually compared', () => {
    // `doubles_inspected` counts doubles found, not doubles compared, and on a
    // large repository the two can differ by orders of magnitude. A clean
    // result has to carry the evidence for how clean it is.
    const { stdout } = runCli(['audit', 'fixtures', '--strictness=all', '--json'], root);
    const { summary } = JSON.parse(stdout);
    // Every inspected double lands in exactly one bucket, so the four have to
    // add up to the total. Asserted as an equality including
    // `doubles_untargeted`: with `<=` over three of the four, a double that
    // fell out of the count entirely still passed.
    const accounted =
      summary.doubles_checked +
      summary.doubles_unresolved +
      summary.doubles_unknowable +
      summary.doubles_untargeted;
    expect(accounted).toBe(summary.doubles_inspected);
    expect(summary.doubles_checked).toBeGreaterThan(0);
    expect(summary.doubles_unknowable).toBeGreaterThan(0);
  }, 120_000);
});
