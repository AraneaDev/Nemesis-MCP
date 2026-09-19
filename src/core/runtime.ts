// ---------------------------------------------------------------------------
// Runtime engine: walk → index → extract → analyze. Shared by CLI and MCP.
// ---------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises';
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
  ScanDiagnostic,
} from './types.js';
import { discoverFiles, filterByLanguages } from './discovery.js';
import { emptyGraph, normalizeSymbolName } from './symbolGraph.js';
import { analyzeDoubles } from './analyzer.js';
import { passesStrictness } from './policy.js';
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
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDurationMs?: number;
}

async function readIfPossible(
  relFile: string,
  rootDir: string,
  diagnostics: ScanDiagnostic[],
  maxFileBytes: number,
  budget: { bytes: number; deadline: number },
): Promise<string | null> {
  const absolute = path.join(rootDir, relFile);
  if (Date.now() > budget.deadline) {
    diagnostics.push({ file: relFile, ...(languageOf(relFile) ? { language: languageOf(relFile)! } : {}), stage: 'budget', message: 'Audit duration limit exceeded', fatal: true });
    return null;
  }
  try {
    const info = await stat(absolute);
    if (info.size > maxFileBytes) {
      diagnostics.push({ file: relFile, ...(languageOf(relFile) ? { language: languageOf(relFile)! } : {}), stage: 'budget', message: `File exceeds ${maxFileBytes} byte limit`, fatal: false });
      return null;
    }
    const source = await readFile(absolute, 'utf8');
    budget.bytes += Buffer.byteLength(source, 'utf8');
    return source;
  } catch (error) {
    diagnostics.push({ file: relFile, ...(languageOf(relFile) ? { language: languageOf(relFile)! } : {}), stage: 'read', message: error instanceof Error ? error.message : String(error), fatal: true });
    return null;
  }
}

/** Index production files into the symbol graph. */
async function indexProduction(
  files: string[],
  rootDir: string,
  graph: SymbolGraph,
  diagnostics: ScanDiagnostic[],
  maxFileBytes: number,
  budget: { bytes: number; deadline: number },
): Promise<void> {
  for (const rel of files) {
    const source = await readIfPossible(rel, rootDir, diagnostics, maxFileBytes, budget);
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
    } catch (error) {
      const language = languageOf(rel);
      diagnostics.push({ file: rel, ...(language ? { language } : {}), stage: 'index', message: error instanceof Error ? error.message : String(error), fatal: false });
      if (language && !graph.skippedLanguages.includes(language) && /grammar|language|wasm/i.test(error instanceof Error ? error.message : String(error))) graph.skippedLanguages.push(language);
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
  diagnostics: ScanDiagnostic[],
  maxFileBytes: number,
  budget: { bytes: number; deadline: number },
): Promise<{ doubles: TestDouble[]; fileLines: Map<string, string[]> }> {
  const doubles: TestDouble[] = [];
  const fileLines = new Map<string, string[]>();
  for (const rel of files) {
    const source = await readIfPossible(rel, rootDir, diagnostics, maxFileBytes, budget);
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
    } catch (error) {
      const language = languageOf(rel);
      diagnostics.push({ file: rel, ...(language ? { language } : {}), stage: 'extract', message: error instanceof Error ? error.message : String(error), fatal: false });
    }
  }
  return { doubles, fileLines };
}

/** Run a full audit: discovery → indexing → extraction → analysis. */
export async function runAudit(opts: RuntimeOptions): Promise<AuditResult> {
  const { rootDir } = opts;
  const diagnostics: ScanDiagnostic[] = [];
  const maxFileBytes = opts.maxFileBytes ?? 2_000_000;
  const maxFiles = opts.maxFiles ?? 10_000;
  const maxTotalBytes = opts.maxTotalBytes ?? 200_000_000;
  const budget = { bytes: 0, deadline: Date.now() + (opts.maxDurationMs ?? 120_000) };
  try {
    const root = await stat(rootDir);
    if (!root.isDirectory()) throw new Error(`Scan root is not a directory: ${rootDir}`);
  } catch (error) {
    throw new Error(`Cannot scan root '${rootDir}': ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const requested of opts.paths ?? []) {
    try {
      await stat(path.join(rootDir, requested));
    } catch (error) {
      throw new Error(`Requested scan path '${requested}' does not exist: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const discovered = await discoverFiles(rootDir, { extraExcludes: opts.extraExcludes ?? [], diagnostics });
  const discoveredCount = discovered.testFiles.length + discovered.productionFiles.length;
  if (discoveredCount > maxFiles) {
    diagnostics.push({ stage: 'budget', message: `Scan contains ${discoveredCount} files; limit is ${maxFiles}`, fatal: true });
  }
  let remainingFiles = maxFiles;
  const bounded = (files: string[]): string[] => {
    const selected = files.slice(0, remainingFiles);
    remainingFiles -= selected.length;
    return selected;
  };

  const restrict = (files: string[]): string[] => {
    if (!opts.paths || opts.paths.length === 0) return files;
    return files.filter((f) =>
      opts.paths!.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')),
    );
  };

  const testFiles = bounded(restrict(filterByLanguages(discovered.testFiles, opts.languages)));
  const productionFiles = bounded(restrict(filterByLanguages(discovered.productionFiles, opts.languages)));

  const graph = emptyGraph();
  await indexProduction(productionFiles, rootDir, graph, diagnostics, maxFileBytes, budget);

  const { doubles, fileLines } = await extractDoubles(testFiles, rootDir, diagnostics, maxFileBytes, budget);
  if (budget.bytes > maxTotalBytes) {
    diagnostics.push({ stage: 'budget', message: `Audit read ${budget.bytes} bytes; limit is ${maxTotalBytes}`, fatal: true });
  }

  const findings = analyzeDoubles({ doubles, graph, fileLines, options: opts });
  const filtered = findings.filter((f) => passesStrictness(opts.strictness, f));

  return {
    summary: {
      scanned_test_files: testFiles.length,
      doubles_inspected: doubles.length,
      violations_count: filtered.length,
      ...(graph.skippedLanguages.length ? { skipped_languages: graph.skippedLanguages } : {}),
      ...(diagnostics.length ? { diagnostics, partial: true } : {}),
    },
    violations: filtered,
  };
}

/** List doubles targeting a specific symbol, with validity flags. */
export interface SymbolReport {
  symbol: string;
  resolved: boolean;
  signature: string | null;
  diagnostics?: ScanDiagnostic[];
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
  const diagnostics: ScanDiagnostic[] = [];
  const discovered = await discoverFiles(rootDir, { extraExcludes: opts.extraExcludes ?? [], diagnostics });
  const productionFiles = filterByLanguages(discovered.productionFiles, opts.languages);
  const testFiles = restrict(
    filterByLanguages(discovered.testFiles, opts.languages),
    opts.paths,
  );

  const graph = emptyGraph();
  const budget = { bytes: 0, deadline: Date.now() + (opts.maxDurationMs ?? 120_000) };
  await indexProduction(productionFiles, rootDir, graph, diagnostics, opts.maxFileBytes ?? 2_000_000, budget);

  // Resolve the symbol: qualified or short name.
  const wanted = normalizeSymbolName(symbolName);
  let found: TypeSymbol | null = null;
  for (const [k, t] of graph.types) {
    const normalized = normalizeSymbolName(k);
    if (normalized === wanted || normalized.endsWith(`.${wanted}`) || normalized.split('.').pop() === wanted) {
      if (found) return { symbol: symbolName, resolved: false, signature: null, ...(diagnostics.length ? { diagnostics } : {}), doubles: [] };
      found = t;
    }
  }
  if (!found) {
    return { symbol: symbolName, resolved: false, signature: null, ...(diagnostics.length ? { diagnostics } : {}), doubles: [] };
  }

  const { doubles, fileLines } = await extractDoubles(testFiles, rootDir, diagnostics, opts.maxFileBytes ?? 2_000_000, budget);
  const findings = analyzeDoubles({ doubles, graph, fileLines, options: opts });

  const report: SymbolReport['doubles'] = [];
  const targetLower = normalizeSymbolName(found.name);
  const shortLower = (normalizeSymbolName(found.name).split('.').pop() ?? normalizeSymbolName(found.name));

  // Candidate doubles for this symbol (in scan order).
  interface Candidate {
    double: TestDouble;
    methodNames: Set<string>;
  }
  const candidates: Candidate[] = [];
  for (const d of doubles) {
    if (!d.targetSymbol) continue;
    const t = normalizeSymbolName(d.targetSymbol);
    const short = t.split('.').pop() ?? t;
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

  return { symbol: found.name, resolved: true, signature, ...(diagnostics.length ? { diagnostics } : {}), doubles: report };
}

function restrict(files: string[], paths?: string[]): string[] {
  if (!paths || paths.length === 0) return files;
  return files.filter((f) =>
    paths.some((p) => f === p || f.startsWith(p.replace(/\/$/, '') + '/')),
  );
}
