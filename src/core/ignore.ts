// ---------------------------------------------------------------------------
// gitignore-lite exclusion rules for repository walks.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Directories always skipped during walks. */
export const ALWAYS_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.parcel-cache',
  'bower_components',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

/** One compiled `.gitignore` line. */
export interface IgnorePattern {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

const REGEX_SPECIALS = /[.+^${}()|\\]/g;

/** Translate one gitignore glob body into a regex source string. */
function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading directories; bare `**` any chars.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
        continue;
      }
      out += '\\[';
      continue;
    }
    out += ch.replace(REGEX_SPECIALS, '\\$&');
  }
  return out;
}

/** Compile a single `.gitignore` line, or null when it carries no rule. */
export function compileIgnoreLine(line: string): IgnorePattern | null {
  let p = line.trim();
  if (p === '' || p.startsWith('#')) return null;

  let negated = false;
  if (p.startsWith('!')) {
    negated = true;
    p = p.slice(1);
  }

  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.replace(/\/+$/, '');
  }
  if (p === '') return null;

  // A pattern with a leading or embedded slash is anchored to the root;
  // anything else matches at any depth.
  let anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  else if (p.includes('/')) anchored = true;
  if (p === '') return null;

  const body = globToRegex(p);
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { negated, dirOnly, regex: new RegExp(`${prefix}${body}$`) };
}

/**
 * Read `<rootDir>/.gitignore`, if present. Nested `.gitignore` files are not
 * consulted — this is the "lite" in gitignore-lite.
 */
export function loadIgnoreFile(rootDir: string): IgnorePattern[] {
  let text: string;
  try {
    text = readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const patterns: IgnorePattern[] = [];
  for (const line of text.split(/\r?\n/)) {
    const compiled = compileIgnoreLine(line);
    if (compiled) patterns.push(compiled);
  }
  return patterns;
}

/** True when `relPath` is ignored by the compiled patterns (last match wins). */
export function matchesIgnorePatterns(
  relPath: string,
  isDir: boolean,
  patterns: IgnorePattern[],
): boolean {
  let ignored = false;
  for (const p of patterns) {
    if (p.dirOnly && !isDir) continue;
    if (p.regex.test(relPath)) ignored = !p.negated;
  }
  return ignored;
}

/** Extra excludes supplied by the user (exact match on path segments). */
export function isExcluded(
  relPath: string,
  extraExcludes: string[] = [],
  patterns: IgnorePattern[] = [],
  isDir = false,
): boolean {
  const segments = relPath.split('/');
  // Check every segment, including the last: a directory entry is passed in by
  // its own path, so skipping the basename would descend into `node_modules`
  // and only discard its files afterwards.
  for (const seg of segments) {
    if (ALWAYS_EXCLUDED_DIRS.has(seg)) return true;
    if (extraExcludes.some((e) => e === seg)) return true;
  }
  if (patterns.length > 0 && matchesIgnorePatterns(relPath, isDir, patterns)) {
    return true;
  }
  return false;
}
