import { describe, expect, it } from 'vitest';
import { compileIgnoreLine, isExcluded, matchesIgnorePatterns } from '../../src/core/ignore.js';

function compile(...lines: string[]) {
  return lines.map(compileIgnoreLine).filter((p): p is NonNullable<typeof p> => p !== null);
}

describe('always-excluded directories', () => {
  it('prunes an excluded directory by its own name', () => {
    // Regression: only the parent segments used to be checked, so the walker
    // descended into node_modules and discarded its files one by one.
    expect(isExcluded('node_modules', [], [], true)).toBe(true);
    expect(isExcluded('vendor', [], [], true)).toBe(true);
    expect(isExcluded('packages/app/node_modules', [], [], true)).toBe(true);
  });

  it('still excludes files nested under an excluded directory', () => {
    expect(isExcluded('node_modules/foo/index.ts')).toBe(true);
  });

  it('leaves ordinary paths alone', () => {
    expect(isExcluded('src/core/analyzer.ts')).toBe(false);
    expect(isExcluded('src', [], [], true)).toBe(false);
  });

  it('honours user-supplied excludes', () => {
    expect(isExcluded('legacy/thing.ts', ['legacy'])).toBe(true);
  });
});

describe('gitignore-lite matching', () => {
  it('ignores comments and blank lines', () => {
    expect(compileIgnoreLine('')).toBeNull();
    expect(compileIgnoreLine('   ')).toBeNull();
    expect(compileIgnoreLine('# a comment')).toBeNull();
  });

  it('matches a bare name at any depth', () => {
    const p = compile('cache');
    expect(matchesIgnorePatterns('cache', true, p)).toBe(true);
    expect(matchesIgnorePatterns('var/cache', true, p)).toBe(true);
    expect(matchesIgnorePatterns('var/cached', true, p)).toBe(false);
  });

  it('anchors a pattern that starts with a slash', () => {
    const p = compile('/build');
    expect(matchesIgnorePatterns('build', true, p)).toBe(true);
    expect(matchesIgnorePatterns('src/build', true, p)).toBe(false);
  });

  it('anchors a pattern containing a slash', () => {
    const p = compile('var/cache');
    expect(matchesIgnorePatterns('var/cache', true, p)).toBe(true);
    expect(matchesIgnorePatterns('app/var/cache', true, p)).toBe(false);
  });

  it('applies a trailing slash to directories only', () => {
    const p = compile('build/');
    expect(matchesIgnorePatterns('build', true, p)).toBe(true);
    expect(matchesIgnorePatterns('build', false, p)).toBe(false);
  });

  it('expands wildcards without crossing separators', () => {
    const p = compile('*.log');
    expect(matchesIgnorePatterns('debug.log', false, p)).toBe(true);
    expect(matchesIgnorePatterns('logs/debug.log', false, p)).toBe(true);
    expect(matchesIgnorePatterns('debug.log.txt', false, p)).toBe(false);
  });

  it('expands ** across separators', () => {
    const p = compile('src/**/generated');
    expect(matchesIgnorePatterns('src/generated', true, p)).toBe(true);
    expect(matchesIgnorePatterns('src/a/b/generated', true, p)).toBe(true);
  });

  it('lets a later negation win', () => {
    const p = compile('dist', '!dist/keep.ts');
    expect(matchesIgnorePatterns('dist', true, p)).toBe(true);
    expect(matchesIgnorePatterns('dist/keep.ts', false, p)).toBe(false);
  });

  it('treats regex metacharacters in a pattern literally', () => {
    const p = compile('a+b.txt');
    expect(matchesIgnorePatterns('a+b.txt', false, p)).toBe(true);
    expect(matchesIgnorePatterns('aaab.txt', false, p)).toBe(false);
    expect(matchesIgnorePatterns('aXbYtxt', false, p)).toBe(false);
  });

  it('feeds through isExcluded', () => {
    const p = compile('build-electrobun/');
    expect(isExcluded('build-electrobun', [], p, true)).toBe(true);
    expect(isExcluded('src/app.ts', [], p, false)).toBe(false);
  });
});

describe('glob translation, branch by branch', () => {
  const m = (pattern: string, p: string, isDir = false) =>
    matchesIgnorePatterns(p, isDir, compile(pattern));

  it('a single star stays inside one path segment', () => {
    expect(m('a*c', 'abc')).toBe(true);
    expect(m('a*c', 'ac')).toBe(true);
    // `*` must not cross a separator, which is what separates it from `**`.
    expect(m('a*c', 'a/c')).toBe(false);
    expect(m('a*c', 'ab/bc')).toBe(false);
  });

  it('a bare double star crosses separators', () => {
    expect(m('a**c', 'a/b/c')).toBe(true);
    expect(m('a**c', 'ac')).toBe(true);
  });

  it('double star followed by a slash matches zero or more directories', () => {
    expect(m('src/**/gen', 'src/gen', true)).toBe(true);
    expect(m('src/**/gen', 'src/a/gen', true)).toBe(true);
    expect(m('src/**/gen', 'src/a/b/gen', true)).toBe(true);
    expect(m('src/**/gen', 'other/gen', true)).toBe(false);
  });

  it('a question mark matches exactly one character, never a separator', () => {
    expect(m('a?c', 'abc')).toBe(true);
    expect(m('a?c', 'ac')).toBe(false);
    expect(m('a?c', 'abbc')).toBe(false);
    expect(m('a?c', 'a/c')).toBe(false);
  });

  it('honours a character class', () => {
    expect(m('a[bc]d', 'abd')).toBe(true);
    expect(m('a[bc]d', 'acd')).toBe(true);
    expect(m('a[bc]d', 'aed')).toBe(false);
  });

  it('treats an unclosed bracket as a literal', () => {
    expect(m('a[bc', 'a[bc')).toBe(true);
    expect(m('a[bc', 'ab')).toBe(false);
  });

  it('escapes regex metacharacters outside a class', () => {
    expect(m('a.c', 'a.c')).toBe(true);
    expect(m('a.c', 'abc')).toBe(false);
    expect(m('a+c', 'a+c')).toBe(true);
    expect(m('a+c', 'aac')).toBe(false);
    expect(m('a(b)c', 'a(b)c')).toBe(true);
    expect(m('a|b', 'a|b')).toBe(true);
    expect(m('a$b', 'a$b')).toBe(true);
  });
});

describe('pattern compilation edge cases', () => {
  it('strips repeated trailing slashes and still marks the rule directory-only', () => {
    const p = compile('build//');
    expect(matchesIgnorePatterns('build', true, p)).toBe(true);
    expect(matchesIgnorePatterns('build', false, p)).toBe(false);
  });

  it('yields no rule when nothing survives the prefixes', () => {
    expect(compileIgnoreLine('/')).toBeNull();
    expect(compileIgnoreLine('!')).toBeNull();
    expect(compileIgnoreLine('!/')).toBeNull();
    expect(compileIgnoreLine('///')).toBeNull();
  });

  it('anchors on a leading slash but not on a trailing one', () => {
    expect(matchesIgnorePatterns('a/build', true, compile('/build'))).toBe(false);
    expect(matchesIgnorePatterns('a/build', true, compile('build/'))).toBe(true);
  });

  it('keeps a negation that is also directory-only', () => {
    const p = compile('build/', '!build/keep/');
    expect(matchesIgnorePatterns('build', true, p)).toBe(true);
    expect(matchesIgnorePatterns('build/keep', true, p)).toBe(false);
    // The negation is directory-only, so a file of that name stays unmatched
    // by both rules rather than being re-included by the wrong one.
    expect(matchesIgnorePatterns('build/keep', false, p)).toBe(false);
  });
});
