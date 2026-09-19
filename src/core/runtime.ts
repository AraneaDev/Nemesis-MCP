// ---------------------------------------------------------------------------
// Runtime engine: walk → index → extract → analyze. Shared by CLI and MCP.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnalyzeOptions,
  AuditResult,
  Finding,
  LanguageId,
  Strictness,
  SymbolGraph,
  TestDouble,
  TypeSymbol,
} from './types.js';
import { discoverFiles, filterByLanguages } from './discovery.js';
import { emptyGraph } from './symbolGraph.js';
import { analyzeDoubles } from './analyzer.js';
import { indexTsFile } from '../extractors/ts/index.js';
import { extractTsDoubles } from '../extractors/ts/doubles.js';
import { indexPhpFile } from '../extractors/php/index.js';
import { extractPhpDoubles } from '../extractors/php/doubles.js';
import { indexPythonFile } from '../extractors/python/index.js';
import { extractPythonDoubles } from '../extractors/python/doubles.js';
import { indexRustFile } from '../extractors/rust/index.js';
import { extractRustDoubles } from '../extractors/rust/doubles.js';

/** Scan roots for the audit: repo-relative directories to walk. */
export interface RuntimeOptions extends AnalyzeOptions {
  /** Absolute repo root. */
  rootDir: string;
  /** Repo-relative paths to restrict the scan to (files or directories). */
  paths?: string[];
  extraExcludes?: string[];
}

async function readIfPossible(relFile: string, rootDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(rootDir, relFile), 'utf8');
  } catch {
    return null;
  }
}

/** Index production files into the symbol graph. */
async function indexProduction(
  files: string[],
  rootDir: string,
  graph: SymbolGraph,
): Promise<void> {
  for (const rel of files) {
    const source = await readIfPossible(rel, rootDir);
    if (source === null) continue;
    const lang = languageOf(rel);
    if (!lang) continue;
    try {
      if (lang === 'typescript' || lang === 'javascript') {
        await indexTsFile(rel, source, graph);
      } else if (lang === 'php') {
        await indexPhpFile(rel, source, graph);
      } else if (lang === 'python') {
        await indexPythonFile(rel, source, graph);
      } else if (lang === 'rust') {
        await indexRustFile(rel, source, graph);
      }
    } catch {
      // per-file index failures are non-fatal
    }
  }
}

function languageOf(rel: string): LanguageId | null {
  const ext = path.extname(rel);
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.php') return 'php';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  return null;
}

/** Extract doubles from test files. */
async function extractDoubles(
  files: string[],
  rootDir: string,
): Promise<{ doubles: TestDouble[]; fileLines: Map<string, string[]> }> {
  const doubles: TestDouble[] = [];
  const fileLines = new Map<string, string[]>();
  for (const rel of files) {
    const source = await readIfPossible(rel, rootDir);
    if (source === null) continue;
    fileLines.set(rel, source.split('\n'));
    const lang = languageOf(rel);
    if (!lang) continue;
    try {
      if (lang === 'typescript' || lang === 'javascript') {
        const r = await extractTsDoubles(rel, source, lang);
        doubles.push(...r.doubles);
      } else if (lang === 'php') {
        doubles.push(...(await extractPhpDoubles(rel, source)));
      } else if (lang === 'python') {
        doubles.push(...(await extractPythonDoubles(rel, source)));
      } else if (lang === 'rust') {
        doubles.push(...(await extractRustDoubles(rel, source)));
      }
    } catch {
      // per-file extraction failures are non-fatal
    }
  }
  return { doubles, fileLines };
}

/** Run a full audit: discovery → indexing → extraction → analysis. */
export async function runAudit(opts: RuntimeOptions): Promise<AuditResult> {
  const { rootDir } = opts;
  const discovered = await discoverFiles(rootDir, { extraExcludes: opts.extraExcludes ?? [] });

  const restrict = (files: string[]): string[] => {
    if (!opts.paths || opts.paths.length === 0) return files;
    return files.filter((f) =>
      opts.paths!.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')),
    );
  };

  const testFiles = restrict(filterByLanguages(discovered.testFiles, opts.languages));
  const productionFiles = filterByLanguages(discovered.productionFiles, opts.languages);

  const graph = emptyGraph();
  await indexProduction(productionFiles, rootDir, graph);

  const { doubles, fileLines } = await extractDoubles(testFiles, rootDir);

  const findings = analyzeDoubles({ doubles, graph, fileLines, options: opts });
  const filtered = findings.filter((f) => passesStrict(opts.strictness, f));

  return {
    summary: {
      scanned_test_files: testFiles.length,
      doubles_inspected: doubles.length,
      violations_count: filtered.length,
      ...(graph.skippedLanguages.length ? { skipped_languages: graph.skippedLanguages } : {}),
    },
    violations: filtered,
  };
}

function passesStrict(strictness: Strictness, f: Finding): boolean {
  if (strictness === 'all') return true;
  if (strictness === 'breaking_only') return f.confidence === 'definite';
  return f.confidence === 'warning';
}

/** List doubles targeting a specific symbol, with validity flags. */
export interface SymbolReport {
  symbol: string;
  resolved: boolean;
  signature: string | null;
  doubles: Array<{
    file: string;
    line: number;
    framework: string;
    method: string | null;
    valid: boolean;
    violations: Finding[];
  }>;
}

export async function verifySymbol(
  opts: RuntimeOptions,
  symbolName: string,
): Promise<SymbolReport> {
  const { rootDir } = opts;
  const discovered = await discoverFiles(rootDir, { extraExcludes: opts.extraExcludes ?? [] });
  const productionFiles = filterByLanguages(discovered.productionFiles, opts.languages);
  const testFiles = restrict(
    filterByLanguages(discovered.testFiles, opts.languages),
    opts.paths,
  );

  const graph = emptyGraph();
  await indexProduction(productionFiles, rootDir, graph);

  // Resolve the symbol: qualified or short name.
  const wanted = symbolName.replace(/^\\+|\\+$/g, '').toLowerCase();
  let found: TypeSymbol | null = null;
  for (const [k, t] of graph.types) {
    if (k === wanted || k.endsWith('\\' + wanted) || k.split('\\').pop() === wanted) {
      found = t;
      break;
    }
  }
  if (!found) {
    return { symbol: symbolName, resolved: false, signature: null, doubles: [] };
  }

  const { doubles, fileLines } = await extractDoubles(testFiles, rootDir);
  const findings = analyzeDoubles({ doubles, graph, fileLines, options: opts });

  const report: SymbolReport['doubles'] = [];
  const targetLower = found.name.toLowerCase();
  const shortLower = (found.name.split('\\').pop() ?? found.name).toLowerCase();

  // Candidate doubles for this symbol (in scan order).
  interface Candidate {
    double: TestDouble;
    methodNames: Set<string>;
  }
  const candidates: Candidate[] = [];
  for (const d of doubles) {
    if (!d.targetSymbol) continue;
    const t = d.targetSymbol.replace(/^\\+/, '').toLowerCase();
    const short = t.split('\\').pop() ?? t;
    if (t !== targetLower && short !== shortLower) continue;
    candidates.push({ double: d, methodNames: new Set(d.methods.map((m) => m.name)) });
  }

  // Attribute each finding to its nearest owning double: a double that
  // configures the finding's method wins; otherwise the closest double at or
  // above the finding's line (chain setters/assertions live below the spy).
  const WINDOW = 8;
  const attribution = new Map<Finding, number>(); // finding → candidate index
  findings.forEach((f, fi) => {
    let best = -1;
    let bestDist = Infinity;
    let bestMethodMatch = false;
    candidates.forEach((c, ci) => {
      if (c.double.file !== f.file) return;
      const idx = f.target.indexOf('::');
      const fMethod = idx >= 0 ? f.target.slice(idx + 2) : null;
      const methodMatch = fMethod !== null && c.methodNames.has(fMethod);
      const dist = f.line - c.double.line;
      const inWindow = dist >= 0 && dist <= WINDOW;
      if (!methodMatch && !inWindow) return;
      if (methodMatch && !bestMethodMatch) {
        best = ci;
        bestDist = dist;
        bestMethodMatch = true;
        return;
      }
      if (methodMatch === bestMethodMatch && dist < bestDist) {
        best = ci;
        bestDist = dist;
      }
    });
    if (best >= 0) attribution.set(f, best);
    void fi;
  });

  candidates.forEach((c, ci) => {
    const viols = findings.filter((f) => attribution.get(f) === ci);
    report.push({
      file: c.double.file,
      line: c.double.line,
      framework: c.double.framework,
      method: c.double.method,
      valid: viols.length === 0,
      violations: viols,
    });
  });

  const methods = [...found.methods.values()];
  const signature = methods.length
    ? `${found.name} { ${methods.map((m) => `${m.name}(${m.params.map((p) => p.name).join(', ')})${m.returnType ? ': ' + m.returnType : ''}`).join('; ')} }`
    : `${found.name} (${found.kind})`;

  return { symbol: found.name, resolved: true, signature, doubles: report };
}

function restrict(files: string[], paths?: string[]): string[] {
  if (!paths || paths.length === 0) return files;
  return files.filter((f) =>
    paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')),
  );
}
