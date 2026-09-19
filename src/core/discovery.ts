// ---------------------------------------------------------------------------
// File discovery: classify repo files into test files vs production files.
// ---------------------------------------------------------------------------

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { LanguageId } from './types.js';
import { isExcluded } from './ignore.js';

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
    // Rust tests are usually inline `#[cfg(test)]` modules; a file is a test
    // file only when it lives under a tests/ directory.
    const segs = relFile.split('/');
    return segs.includes('tests') || segs.includes('benches');
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

/** Recursively collect source files under `rootDir`, split into tests / production. */
export async function discoverFiles(
  rootDir: string,
  opts: { extensions?: string[]; extraExcludes?: string[] } = {},
): Promise<DiscoveredFiles> {
  const testFiles: string[] = [];
  const productionFiles: string[] = [];
  const exts = opts.extensions ?? Object.keys(EXT_TO_LANG);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (isExcluded(rel, opts.extraExcludes)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        const lang = languageForFile(entry.name);
        if (!lang || !exts.includes(path.extname(entry.name))) continue;
        if (isExcluded(rel, opts.extraExcludes)) continue;
        if (isTestFile(rel)) testFiles.push(rel);
        else productionFiles.push(rel);
      }
    }
  }

  await walk(rootDir);
  testFiles.sort();
  productionFiles.sort();
  return { testFiles, productionFiles };
}

/** Narrow a discovered file list down to the requested languages. */
export function filterByLanguages(
  files: string[],
  languages: LanguageId[],
): string[] {
  return files.filter((f) => {
    const lang = languageForFile(f);
    return lang !== null && languages.includes(lang);
  });
}
