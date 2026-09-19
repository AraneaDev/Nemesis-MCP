// ---------------------------------------------------------------------------
// nemesis_stale_fixtures: check JSON/YAML fixtures against production DTO shapes.
// ---------------------------------------------------------------------------

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Finding, ScanDiagnostic, Strictness, SymbolGraph } from '../core/types.js';
import { emptyGraph, resolveType } from '../core/symbolGraph.js';
import { discoverFiles } from '../core/discovery.js';
import { indexTsFile } from '../extractors/ts/index.js';
import { indexPhpFile } from '../extractors/php/index.js';
import { indexPythonFile } from '../extractors/python/index.js';
import { indexRustFile } from '../extractors/rust/index.js';
import { similarity } from '../core/symbolGraph.js';
import { passesStrictness } from '../core/policy.js';

const FIXTURE_EXTS = new Set(['.json', '.yaml', '.yml']);

function languageOf(rel: string): 'typescript' | 'javascript' | 'php' | 'python' | 'rust' | null {
  const ext = path.extname(rel);
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.php') return 'php';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  return null;
}

/** Production graph restricted to type symbols carrying field maps. */
async function buildGraph(rootDir: string, files: string[], diagnostics: ScanDiagnostic[]): Promise<SymbolGraph> {
  const graph = emptyGraph();
  for (const rel of files) {
    const lang = languageOf(rel);
    if (!lang) continue;
    try {
      const source = await readFile(path.join(rootDir, rel), 'utf8');
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
      diagnostics.push({ file: rel, stage: 'index', message: error instanceof Error ? error.message : String(error), fatal: false });
    }
  }
  return graph;
}

interface DtoLike {
  name: string;
  fields: Map<string, { name: string; type: string | null; required: boolean }>;
  file: string;
}

/** Collect DTO-like symbols from every indexer that exposes field metadata. */
function collectDtoLikes(graph: SymbolGraph): DtoLike[] {
  const out: DtoLike[] = [];
  for (const t of graph.types.values()) {
    if (t.fields && t.fields.size > 0) {
      out.push({ name: t.name, fields: t.fields, file: t.file });
      continue;
    }
  }
  return out;
}

/** Best-match DTO for a fixture: prefer name overlap with file name or top keys. */
function matchDto(
  fixtureName: string,
  topKeys: string[],
  dtos: DtoLike[],
): DtoLike | null {
  const signals = [fixtureName, ...topKeys].map((s) => s.toLowerCase());
  let best: { dto: DtoLike; score: number } | null = null;
  let tied = false;
  for (const dto of dtos) {
    const short = (dto.name.split('\\').pop() ?? dto.name).toLowerCase();
    for (const s of signals) {
      const normalized = s.replace(/fixture|s\b/g, '');
      const baseShort = short.replace(/record|dto|model$/, '');
      const overlap = topKeys.filter((key) => dto.fields.has(key)).length;
      const score = s === short || normalized === baseShort
        ? 3 + overlap
        : s.includes(short) || short.includes(normalized)
          ? 1 + overlap
          : overlap > 0
            ? overlap
            : 0;
      if (score === 0) continue;
      if (!best || score > best.score) {
        best = { dto, score };
        tied = false;
      } else if (score === best.score && best.dto !== dto) {
        tied = true;
      }
    }
  }
  return best && !tied ? best.dto : null;
}

export interface FixtureCheckResult {
  violations: Finding[];
  scanned: number;
  diagnostics: ScanDiagnostic[];
}

export function filterFixtureFindings(findings: Finding[], strictness: Strictness): Finding[] {
  return findings.filter((finding) => passesStrictness(strictness, finding));
}

export async function checkFixtures(
  rootDir: string,
  paths?: string[],
): Promise<FixtureCheckResult> {
  const diagnostics: ScanDiagnostic[] = [];
  const { productionFiles } = await discoverFiles(rootDir, { diagnostics });
  const graph = await buildGraph(rootDir, productionFiles, diagnostics);
  const dtos = collectDtoLikes(graph);

  const violations: Finding[] = [];
  let scanned = 0;

  const fixtureFiles: string[] = [];
  for (const requested of paths ?? []) {
    try {
      const info = await stat(path.join(rootDir, requested));
      if (!info.isDirectory() && !FIXTURE_EXTS.has(path.extname(requested))) {
        diagnostics.push({ file: requested, stage: 'discovery', message: 'Requested fixture path is not a JSON/YAML file or directory', fatal: true });
      }
    } catch (error) {
      throw new Error(`Requested fixture path '${requested}' does not exist: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await collectFixtureFiles(rootDir, '', fixtureFiles, paths ?? [], diagnostics);

  for (const rel of fixtureFiles) {
    const abs = path.join(rootDir, rel);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch (error) {
      diagnostics.push({ file: rel, stage: 'read', message: error instanceof Error ? error.message : String(error), fatal: true });
      continue;
    }
    let data: unknown;
    try {
      data = FIXTURE_EXTS.has(path.extname(rel)) && /\.ya?ml$/.test(rel)
        ? parseYaml(raw)
        : JSON.parse(raw);
    } catch (error) {
      diagnostics.push({ file: rel, stage: 'parse', message: error instanceof Error ? error.message : String(error), fatal: true });
      continue;
    }
    scanned++;
    const topKeys = topKeyNames(data);
    const dto = matchDto(path.basename(rel, path.extname(rel)), topKeys, dtos);
    if (!dto) {
      diagnostics.push({ file: rel, stage: 'fixture', message: 'No unambiguous supported DTO shape matched this fixture', fatal: false });
      continue;
    }

    const records = recordsOf(data, dto);
    for (const rec of records) {
      for (const [field, meta] of dto.fields) {
        if (meta.required && !(field in rec)) {
          const suggestion = suggestField(rec, field, dto.fields);
          violations.push({
            file: rel,
            line: 1,
            type: 'GHOST_METHOD',
            confidence: 'definite',
            double_type: 'stale_fixture',
            target: `${dto.name}.${field}`,
            message: `Fixture '${path.basename(rel)}' is missing required field '${field}' of ${dto.name}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
            ...(suggestion ? { suggestion } : {}),
          });
        }
      }
      for (const key of Object.keys(rec)) {
        if (!dto.fields.has(key)) {
          const suggestion = suggestFieldKey(dto.fields, key);
          violations.push({
            file: rel,
            line: 1,
            type: 'RETURN_DRIFT',
            confidence: 'warning',
            evidence: 'untyped',
            double_type: 'stale_fixture',
            target: `${dto.name}.${key}`,
            message: `Fixture '${path.basename(rel)}' has field '${key}' which no longer exists on ${dto.name}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
            ...(suggestion ? { suggestion } : {}),
          });
        }
      }
    }
  }

  return { violations, scanned, diagnostics };
}

async function collectFixtureFiles(
  rootDir: string,
  rel: string,
  out: string[],
  paths: string[],
  diagnostics: ScanDiagnostic[],
): Promise<void> {
  const dir = path.join(rootDir, rel);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({ file: rel || '.', stage: 'discovery', message: error instanceof Error ? error.message : String(error), fatal: true });
    return;
  }
  for (const entry of entries) {
    const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (['node_modules', 'vendor', 'dist', '.git'].includes(entry.name)) continue;
      await collectFixtureFiles(rootDir, relEntry, out, paths, diagnostics);
    } else if (
      FIXTURE_EXTS.has(path.extname(entry.name)) &&
      (paths.length === 0 || paths.some((p) => relEntry === p || relEntry.startsWith(p + '/')))
    ) {
      out.push(relEntry);
    }
  }
}

function topKeyNames(data: unknown): string[] {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.keys(data as Record<string, unknown>);
  }
  return [];
}

/** Locate the records inside the fixture (top-level array, keyed wrapper, or single object). */
function recordsOf(data: unknown, dto: DtoLike): Array<Record<string, unknown>> {
  const short = (dto.name.split('\\').pop() ?? dto.name).toLowerCase();
  const out: Array<Record<string, unknown>> = [];

  const keyMatches = (k: string): boolean => {
    const kNorm = k.toLowerCase().replace(/[^a-z]/g, '');
    return (
      kNorm === short ||
      kNorm === short + 's' ||
      kNorm === short + 'es' ||
      // Wrapper keys like `users_fixture` / `userRecords`.
      kNorm.includes(short)
    );
  };

  const pushRecord = (v: unknown): void => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
    }
  };

  if (Array.isArray(data)) {
    for (const item of data) pushRecord(item);
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (keyMatches(k)) {
        if (Array.isArray(v)) {
          for (const item of v) pushRecord(item);
        } else {
          pushRecord(v);
        }
      }
    }
    if (out.length === 0) {
      // Fallback: any top-level array of objects is treated as the record list
      // (wrapper key naming may not overlap with the DTO name).
      for (const v of Object.values(data as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const item of v) pushRecord(item);
        }
      }
    }
    if (out.length === 0) out.push(data as Record<string, unknown>);
  }
  return out;
}

function suggestField(
  rec: Record<string, unknown>,
  field: string,
  fields: Map<string, { name: string; type: string | null; required: boolean }>,
): string | null {
  let best: { name: string; d: number } | null = null;
  for (const key of Object.keys(rec)) {
    const d = similarity(field, key);
    if (!best || d < best.d) best = { name: key, d };
  }
  void fields;
  const threshold = Math.max(2, Math.floor(field.length * 0.4));
  return best && best.d <= threshold ? best.name : null;
}

function suggestFieldKey(
  fields: Map<string, { name: string; type: string | null; required: boolean }>,
  key: string,
): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of fields.keys()) {
    const d = similarity(key, name);
    if (!best || d < best.d) best = { name, d };
  }
  const threshold = Math.max(2, Math.floor(key.length * 0.4));
  return best && best.d <= threshold ? best.name : null;
}

export { resolveType };
