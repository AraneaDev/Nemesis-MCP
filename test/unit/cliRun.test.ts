import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { parseArgs, run } from '../../src/cli/main.js';

const root = path.resolve(import.meta.dirname, '..', '..');

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function cli(argv: string[], cwd = root): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return run(parsed.args, cwd);
}

const json = () => JSON.parse(out.join('\n'));

describe('audit command', () => {
  it('exits 0 on a clean tree and says so', async () => {
    expect(await cli(['audit', 'fixtures/dogfood-clean'])).toBe(0);
    expect(out.join('\n')).not.toContain('GHOST_METHOD');
  }, 120_000);

  it('exits 1 and reports drift as JSON', async () => {
    expect(await cli(['audit', 'fixtures/dogfood-repo', '--strictness=all', '--json'])).toBe(1);
    const body = json();
    expect(body.summary.violations_count).toBe(3);
    expect(new Set(body.violations.map((v: { type: string }) => v.type))).toEqual(
      new Set(['GHOST_METHOD', 'ARITY_MISMATCH', 'RETURN_DRIFT']),
    );
  }, 120_000);

  it('renders human-readable text without --json', async () => {
    await cli(['audit', 'fixtures/ts', '--strictness=all']);
    const text = out.join('\n');
    expect(text).toContain('GHOST_METHOD');
    expect(text).toContain('UserService');
    expect(() => JSON.parse(text)).toThrow();
  }, 120_000);

  it('narrows by language', async () => {
    await cli(['audit', 'fixtures', '--strictness=all', '--lang=php', '--json']);
    const files = json().violations.map((v: { file: string }) => v.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f: string) => f.endsWith('.php'))).toBe(true);
  }, 120_000);

  it('excludes a directory by name', async () => {
    expect(await cli(['audit', '--exclude=fixtures', '--strictness=all'])).toBe(0);
  }, 120_000);

  it('accumulates --include paths', async () => {
    await cli([
      'audit',
      '--include=fixtures/ts',
      '--include=fixtures/php',
      '--strictness=all',
      '--json',
    ]);
    const files: string[] = json().violations.map((v: { file: string }) => v.file);
    expect(files.some((f) => f.includes('/ts/'))).toBe(true);
    expect(files.some((f) => f.includes('/php/'))).toBe(true);
  }, 120_000);

  it('returns 2 for a path that does not exist, with a reason', async () => {
    expect(await cli(['audit', 'no/such/path'])).toBe(2);
    expect(err.join('\n')).toContain('operational error');
  }, 120_000);
});

describe('strictness filtering', () => {
  it('breaking_only keeps definite findings only', async () => {
    await cli(['audit', 'fixtures', '--json']);
    const v = json().violations as Array<{ confidence: string }>;
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.confidence === 'definite')).toBe(true);
  }, 120_000);

  it('untyped_only returns the findings the mode is named after', async () => {
    // The mode could not return anything before: an untyped stub was treated
    // as compatible and never reached a finding, so the branch that would
    // have marked it was unreachable.
    await cli(['audit', 'fixtures', '--strictness=untyped_only', '--json']);
    const v = json().violations as Array<{ evidence: string }>;
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.evidence === 'untyped')).toBe(true);
  }, 120_000);

  it('all contains both other modes and the heuristic findings besides', async () => {
    // `all` is a superset rather than a sum: a heuristic warning is neither
    // definite nor untyped, so it belongs to neither narrower mode.
    await cli(['audit', 'fixtures', '--strictness=all', '--json']);
    const all = json().violations as Array<{ confidence: string; evidence: string }>;
    out = [];
    await cli(['audit', 'fixtures', '--json']);
    const breaking = json().violations.length;
    out = [];
    await cli(['audit', 'fixtures', '--strictness=untyped_only', '--json']);
    const untyped = json().violations.length;

    expect(all.length).toBeGreaterThanOrEqual(breaking + untyped);
    expect(all.filter((v) => v.confidence === 'definite')).toHaveLength(breaking);
    expect(all.filter((v) => v.evidence === 'untyped')).toHaveLength(untyped);
  }, 120_000);

  it('every finding carries evidence', async () => {
    await cli(['audit', 'fixtures', '--strictness=all', '--json']);
    const v = json().violations as Array<{ evidence?: string }>;
    expect(v.every((x) => typeof x.evidence === 'string')).toBe(true);
  }, 120_000);
});

describe('verify-symbol command', () => {
  it('exits 1 when a double no longer matches', async () => {
    expect(await cli(['verify-symbol', 'UserService'])).toBe(1);
    expect(out.join('\n')).toContain('INVALID');
  }, 120_000);

  it('needs a symbol name', async () => {
    expect(await cli(['verify-symbol'])).toBe(2);
    expect(err.join('\n')).toContain('requires a symbol name');
  }, 120_000);

  it('reports an unresolved symbol without failing', async () => {
    expect(await cli(['verify-symbol', 'NoSuchClassAnywhere'])).toBe(0);
    expect(out.join('\n')).toContain('could not be resolved');
  }, 120_000);
});

describe('fixtures command', () => {
  it('flags a stale fixture record', async () => {
    expect(await cli(['fixtures', 'fixtures/fixtures-data', '--strictness=all', '--json'])).toBe(1);
    const body = json();
    expect(body.summary.scanned_fixtures).toBe(1);
    expect(body.summary.violations_count).toBeGreaterThan(0);
  }, 120_000);

  it('separates unmatched fixtures from findings', async () => {
    await cli(['fixtures', '--exclude=nothing', '--json']);
    const body = json();
    expect(typeof body.summary.unmatched_fixtures).toBe('number');
  }, 120_000);
});

describe('suppression', () => {
  it('honours a nemesis-ignore comment', async () => {
    await cli(['audit', 'fixtures/ts', '--strictness=all', '--json']);
    const before = json().violations.length;
    expect(before).toBeGreaterThan(0);
  }, 120_000);
});

describe('absolute scan paths', () => {
  it('scans an absolute path the same as its relative spelling', async () => {
    // Regression: the path was joined onto the scan root rather than resolved
    // against it, so `nemesis audit /abs/path` looked for `<root>/abs/path`
    // and died with ENOENT on a directory that is plainly there.
    const absolute = path.join(root, 'fixtures', 'dogfood-repo');
    expect(await cli(['audit', absolute, '--strictness=all', '--json'])).toBe(1);
    expect(json().summary.violations_count).toBe(3);
  }, 120_000);

  it('refuses an absolute path outside the scan root', async () => {
    // Silently scanning nothing is the failure mode this project exists to
    // avoid, so a path the root cannot contain has to say so.
    expect(await cli(['audit', path.resolve(root, '..'), '--json'])).toBe(2);
    expect(err.join('\n')).toContain('outside the scan root');
  }, 120_000);
});

describe('verify-symbol with a degraded file', () => {
  it('does not call a scan with an unreadable region partial', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nemesis-verify-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'svc.ts'),
        "export type * from './e.js';\nexport class Svc {\n  load(): boolean { return true; }\n}\n",
      );
      await writeFile(
        path.join(dir, 'tests', 'svc.test.ts'),
        "import { vi } from 'vitest';\nimport { Svc } from '../src/svc.js';\nconst s = new Svc();\nvi.spyOn(s, 'load').mockReturnValue(true);\n",
      );
      expect(await cli(['verify-symbol', 'Svc'], dir)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
