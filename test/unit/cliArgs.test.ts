import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/main.js';

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.args;
}

function err(argv: string[]): string {
  const r = parseArgs(argv);
  if (r.ok) throw new Error('expected a parse error');
  return r.error;
}

describe('command dispatch', () => {
  it('defaults to audit with no arguments', () => {
    expect(ok([]).command).toBe('audit');
  });

  it('accepts each documented command', () => {
    expect(ok(['audit']).command).toBe('audit');
    expect(ok(['verify-symbol', 'Foo']).command).toBe('verify-symbol');
    expect(ok(['fixtures']).command).toBe('fixtures');
  });

  it('rejects an unknown command rather than scanning it as a path', () => {
    // `nemesis verifysymbol Foo` used to audit two nonexistent paths and fail
    // with a confusing "scan path does not exist" error.
    expect(err(['verifysymbol', 'Foo'])).toContain("Unknown command 'verifysymbol'");
  });

  it('keeps later bare words as positionals', () => {
    expect(ok(['audit', 'src', 'tests']).positional).toEqual(['src', 'tests']);
    expect(ok(['verify-symbol', 'App\\Service']).positional).toEqual(['App\\Service']);
  });
});

describe('option validation', () => {
  it('rejects an unknown option instead of ignoring it', () => {
    expect(err(['audit', '--strictnes=all'])).toContain("Unknown option '--strictnes=all'");
    expect(err(['audit', '--jsonn'])).toContain("Unknown option '--jsonn'");
    expect(err(['audit', '-x'])).toContain("Unknown option '-x'");
  });

  it('rejects an invalid strictness', () => {
    expect(err(['audit', '--strictness=nonsense'])).toContain('Invalid --strictness');
    expect(ok(['audit', '--strictness=all']).strictness).toBe('all');
    expect(ok(['audit', '--strictness=untyped_only']).strictness).toBe('untyped_only');
  });

  it('rejects an unknown language and keeps known ones', () => {
    expect(err(['audit', '--lang=cobol'])).toContain("Unknown language 'cobol'");
    expect(err(['audit', '--lang=php,cobol'])).toContain("Unknown language 'cobol'");
    expect(err(['audit', '--lang='])).toContain('at least one language');
    expect(ok(['audit', '--lang=php,python']).languages).toEqual(['php', 'python']);
  });

  it('rejects an empty include or exclude', () => {
    expect(err(['audit', '--include='])).toContain('needs a path');
    expect(err(['audit', '--exclude='])).toContain('needs a directory name');
  });

  it('collects repeated includes and excludes', () => {
    const a = ok(['audit', '--exclude=fixtures', '--exclude=vendor', '--include=src']);
    expect(a.excludes).toEqual(['fixtures', 'vendor']);
    expect(a.includes).toEqual(['src']);
  });

  it('parses the standalone flags', () => {
    expect(ok(['audit', '--json']).json).toBe(true);
    expect(ok(['audit', '--allow-partial']).allowPartial).toBe(true);
    expect(ok(['--help']).help).toBe(true);
    expect(ok(['-h']).help).toBe(true);
    expect(ok(['--version']).version).toBe(true);
    expect(ok(['-V']).version).toBe(true);
  });

  it('ignores a bare -- separator', () => {
    expect(ok(['audit', '--', 'src']).positional).toEqual(['src']);
  });
});
