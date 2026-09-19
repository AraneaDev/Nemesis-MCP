// ---------------------------------------------------------------------------
// File discovery: classify repo files into test files vs production files.
// ---------------------------------------------------------------------------

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { LanguageId, ScanDiagnostic } from './types.js';
import { isExcluded, loadIgnoreFile } from './ignore.js';

const EXT_TO_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.rs': 'rust',
};

const TEST_DIR_NAMES = new Set(['tests', 'test', 'spec', '__tests__', '__specs__']);

/** PHP class-trait fixtures and similar are still production files; nothing special. */

export function languageForFile(file: string): LanguageId | null {
  return EXT_TO_LANG[path.extname(file)] ?? null;
}

export function isTestFile(relFile: string): boolean {
  const base = path.basename(relFile);
  const ext = path.extname(relFile);
  if (ext === '.php') {
    return /Test\.php$|TestCase\.php$/.test(base);
  }
  if (ext === '.py') {
    return /^test_.*\.py$|.*_test\.py$|^tests\.py$/.test(base);
  }
  if (ext === '.rs') {
    const segs = relFile.split('/');
    // Cargo's own layout: `tests/` and `benches/` are test targets. A
    // singular `test/` is not, and treating it as one classified the trait
    // source sitting beside a fixture as a test, so it never reached the
    // symbol graph and the drift beside it went unreported.
    if (segs.includes('tests') || segs.includes('benches')) return true;
    // Rust's dominant idiom is an inline `#[cfg(test)]` module rather than a
    // separate file, which `hasInlineRustTests` picks up during the walk.
    return /^test_.*\.rs$|.*_test\.rs$/.test(base);
  }
  // JS/TS family
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(base)) return true;
  const segs = relFile.split('/');
  return segs.slice(0, -1).some((s) => TEST_DIR_NAMES.has(s));
}

export interface DiscoveredFiles {
  testFiles: string[];
  productionFiles: string[];
}

/** Largest `.rs` file worth reading just to look for a `#[cfg(test)]` module. */
const INLINE_TEST_PROBE_LIMIT = 1_000_000;

const CFG_TEST = /#\s*\[\s*cfg\s*\(\s*(all\s*\(\s*)?test\s*[),]/;

/**
 * True when a Rust source file carries its tests inline. Most Rust unit tests
 * live in a `#[cfg(test)] mod tests` block beside the code rather than in a
 * separate file, so treating only `tests/` as test code left the common case
 * unscanned. Such a file is both production and test.
 */
async function hasInlineRustTests(abs: string): Promise<boolean> {
  try {
    const info = await stat(abs);
    if (info.size > INLINE_TEST_PROBE_LIMIT) return false;
    return CFG_TEST.test(await readFile(abs, 'utf8'));
  } catch {
    return false;
  }
}

/** Recursively collect source files under `rootDir`, split into tests / production. */
export async function discoverFiles(
  rootDir: string,
  opts: {
    extensions?: string[];
    extraExcludes?: string[];
    diagnostics?: ScanDiagnostic[];
    respectGitignore?: boolean;
  } = {},
): Promise<DiscoveredFiles> {
  const testFiles: string[] = [];
  const productionFiles: string[] = [];
  const exts = opts.extensions ?? Object.keys(EXT_TO_LANG);
  const patterns = opts.respectGitignore === false ? [] : loadIgnoreFile(rootDir);

  // Real paths already walked. A symlink pointing at a directory that the walk
  // has already covered, including the repository root, must not be descended
  // again: one repository here links `plugins/redactx` to its own root, which
  // walked and counted the entire tree twice.
  //
  // Every directory is resolved, not only those reached through a link,
  // because the first visit to a shared target is usually the direct one and
  // it is the visit that has to be recorded.
  const visited = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      real = path.resolve(dir);
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      opts.diagnostics?.push({
        file: path.relative(rootDir, dir).split(path.sep).join('/') || '.',
        stage: 'discovery',
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      const isLink = entry.isSymbolicLink();
      if (isLink) {
        // A symlinked directory used to be neither a directory nor a file to
        // the walk, so it was dropped without a word. A repository that
        // symlinks its source tree, which pnpm workspaces and many monorepo
        // layouts do, had that source silently missing from the graph and
        // every double pointing into it quietly went unchecked.
        try {
          const target = await stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // broken symlink
        }
      }

      if (isDir) {
        if (isExcluded(rel, opts.extraExcludes, patterns, true)) continue;
        await walk(abs);
      } else if (isFile) {
        const lang = languageForFile(entry.name);
        if (!lang || !exts.includes(path.extname(entry.name))) continue;
        if (isExcluded(rel, opts.extraExcludes, patterns, false)) continue;
        if (isTestFile(rel)) {
          testFiles.push(rel);
        } else {
          productionFiles.push(rel);
          if (lang === 'rust' && (await hasInlineRustTests(abs))) {
            testFiles.push(rel);
          }
        }
      }
    }
  }

  await walk(rootDir);
  testFiles.sort();
  productionFiles.sort();
  return { testFiles, productionFiles };
}

/** Narrow a discovered file list down to the requested languages. */
export function filterByLanguages(files: string[], languages: LanguageId[]): string[] {
  return files.filter((f) => {
    const lang = languageForFile(f);
    return lang !== null && languages.includes(lang);
  });
}
