// ---------------------------------------------------------------------------
// nemesis_stale_fixtures: check JSON/YAML fixtures against production DTO shapes.
// ---------------------------------------------------------------------------

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Finding, ScanDiagnostic, Strictness, SymbolGraph } from '../core/types.js';
import { emptyGraph, resolveType } from '../core/symbolGraph.js';
import { discoverFiles } from '../core/discovery.js';
import { isExcluded, loadIgnoreFile, type IgnorePattern } from '../core/ignore.js';
import { indexTsFile } from '../extractors/ts/index.js';
import { indexPhpFile } from '../extractors/php/index.js';
import { indexPythonFile } from '../extractors/python/index.js';
import { indexRustFile } from '../extractors/rust/index.js';
import { similarity } from '../core/symbolGraph.js';
import { passesStrictness } from '../core/policy.js';

const FIXTURE_EXTS = new Set(['.json', '.yaml', '.yml']);

/**
 * Directory names that mark data written to be read back by tests. Without
 * this, every `.json` and `.yml` in the tree counted as a fixture, so a
 * pre-commit config or a lockfile was matched against a production DTO and
 * reported as missing its fields.
 */
const FIXTURE_DIRS = new Set([
  'fixtures',
  'fixture',
  '__fixtures__',
  'testdata',
  'test-data',
  '__snapshots__',
  'snapshots',
  'cassettes',
  'stubs',
  'mocks',
  '__mocks__',
  'factories',
  'seeds',
  'samples',
]);

/** Directories that hold tests, whose data files are fixtures too. */
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__']);

/**
 * Files that are configuration wherever they sit. A test corpus is full of
 * miniature `package.json` and CI files, and a two-key `package.json` used to
 * shape-match a production DTO and be reported as missing its other fields.
 */
const NEVER_FIXTURE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'jsconfig.json',
  'composer.json',
  'composer.lock',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'biome.json',
  'renovate.json',
  'manifest.json',
  'mcp.json',
  'settings.json',
  'settings.local.json',
  'launch.json',
  'extensions.json',
  'nest-cli.json',
  'angular.json',
  'nx.json',
  'turbo.json',
  'lerna.json',
  'now.json',
  'vercel.json',
  'netlify.json',
  'app.json',
  'firebase.json',
  'serverless.yml',
  'serverless.yaml',
  'pubspec.yaml',
  'pubspec.lock',
  'codecov.yml',
  'codecov.yaml',
]);

const NEVER_FIXTURE_PATTERNS = [
  /^tsconfig(\..+)?\.json$/i,
  /\.config\.(json|ya?ml)$/i,
  /^\.eslintrc(\..+)?$/i,
  /^\.prettierrc(\..+)?$/i,
  /^docker-compose(\..+)?\.ya?ml$/i,
  /^\.?pre-commit-config\.ya?ml$/i,
  /-lock\.(json|ya?ml)$/i,
  /^openapi(\..+)?\.(json|ya?ml)$/i,
  /^swagger(\..+)?\.(json|ya?ml)$/i,
];

/** Directories whose contents are tooling configuration, never fixtures. */
const CONFIG_DIRS = new Set([
  '.github',
  '.gitlab',
  '.circleci',
  '.vscode',
  '.idea',
  '.cursor',
  '.devcontainer',
  '.husky',
]);

/** True when a JSON/YAML file sits somewhere fixtures are kept. */
export function isFixturePath(relPath: string): boolean {
  if (!FIXTURE_EXTS.has(path.extname(relPath))) return false;
  const parts = relPath.split('/');
  const base = (parts[parts.length - 1] ?? '').toLowerCase();
  if (NEVER_FIXTURE_NAMES.has(base)) return false;
  if (NEVER_FIXTURE_PATTERNS.some((re) => re.test(base))) return false;
  const segments = parts.slice(0, -1).map((seg) => seg.toLowerCase());
  if (segments.some((seg) => CONFIG_DIRS.has(seg))) return false;
  return segments.some((seg) => FIXTURE_DIRS.has(seg) || TEST_DIRS.has(seg));
}

/** Per-file read budget, matching the audit path. */
const MAX_FIXTURE_FILE_BYTES = 2_000_000;

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
async function buildGraph(
  rootDir: string,
  files: string[],
  diagnostics: ScanDiagnostic[],
  deadline: number,
): Promise<SymbolGraph> {
  const graph = emptyGraph();
  for (const rel of files) {
    const lang = languageOf(rel);
    if (!lang) continue;
    if (Date.now() > deadline) {
      diagnostics.push({
        file: rel,
        stage: 'budget',
        message: 'Fixture scan duration limit exceeded',
        fatal: true,
      });
      break;
    }
    try {
      // The audit path enforces this budget; indexing without it walked a
      // committed multi-megabyte PHP seeder straight into a WASM abort.
      const info = await stat(path.join(rootDir, rel));
      if (info.size > MAX_FIXTURE_FILE_BYTES) {
        diagnostics.push({
          file: rel,
          stage: 'budget',
          message: `File exceeds ${MAX_FIXTURE_FILE_BYTES} byte limit`,
          fatal: false,
        });
        continue;
      }
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
      diagnostics.push({
        file: rel,
        stage: 'index',
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
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

/**
 * Strip the decoration around a name so `users.fixture.json` and `UserRecord`
 * meet in the middle.
 */
function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._-]?(fixtures?|data|sample|example)$/, '')
    .replace(/(record|dto|model|entity|schema)$/, '')
    .replace(/s$/, '');
}

/**
 * Best-match DTO for a fixture.
 *
 * Field overlap alone used to be enough to win, so a single shared key such as
 * `id` bound an unrelated YAML config to a random class and every other field
 * of that class was then reported missing. A match now needs either a name
 * that lines up or an overlap that covers most of both shapes.
 */
function matchDto(
  fixtureName: string,
  topKeys: string[],
  containerKeys: string[],
  dtos: DtoLike[],
): DtoLike | null {
  if (dtos.length === 0) return null;
  const signals = [fixtureName, ...containerKeys].map((s) => s.toLowerCase());
  let best: { dto: DtoLike; score: number } | null = null;
  let tied = false;

  for (const dto of dtos) {
    const short = (dto.name.split('\\').pop() ?? dto.name).toLowerCase();
    const overlap = topKeys.filter((key) => dto.fields.has(key)).length;
    const keyCoverage = topKeys.length > 0 ? overlap / topKeys.length : 0;
    const fieldCoverage = dto.fields.size > 0 ? overlap / dto.fields.size : 0;

    const namedMatch = signals.some(
      (sig) => sig === short || normalizeName(sig) === normalizeName(short),
    );
    // A shape match has to explain most of the fixture and most of the DTO.
    // Two shared keys is coincidence: `{name, version}` fits a surprising
    // number of record types.
    const shapeMatch = overlap >= 3 && keyCoverage >= 0.6 && fieldCoverage >= 0.5;

    if (!namedMatch && !shapeMatch) continue;

    const score = (namedMatch ? 10 : 0) + overlap + Math.round(keyCoverage * 5);
    if (!best || score > best.score) {
      best = { dto, score };
      tied = false;
    } else if (score === best.score && best.dto !== dto) {
      tied = true;
    }
  }
  return best && !tied ? best.dto : null;
}

export interface FixtureCheckResult {
  violations: Finding[];
  scanned: number;
  /** Fixtures parsed but matched to no DTO. Normal, so not a diagnostic. */
  unmatched: number;
  /** Fixture-shaped files that are not valid JSON/YAML. Reported, not fatal. */
  unparsable: string[];
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
  const deadline = Date.now() + 120_000;
  const { productionFiles } = await discoverFiles(rootDir, { diagnostics });
  const graph = await buildGraph(rootDir, productionFiles, diagnostics, deadline);
  const dtos = collectDtoLikes(graph);

  const violations: Finding[] = [];
  let scanned = 0;
  let unmatched = 0;
  const unparsable: string[] = [];

  const fixtureFiles: string[] = [];
  for (const requested of paths ?? []) {
    try {
      const info = await stat(path.join(rootDir, requested));
      if (!info.isDirectory() && !FIXTURE_EXTS.has(path.extname(requested))) {
        diagnostics.push({
          file: requested,
          stage: 'discovery',
          message: 'Requested fixture path is not a JSON/YAML file or directory',
          fatal: true,
        });
      }
    } catch (error) {
      throw new Error(
        `Requested fixture path '${requested}' does not exist: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const ignorePatterns = loadIgnoreFile(rootDir);
  await collectFixtureFiles(rootDir, '', fixtureFiles, paths ?? [], diagnostics, ignorePatterns);

  for (const rel of fixtureFiles) {
    const abs = path.join(rootDir, rel);
    let raw: string;
    try {
      raw = await readFile(abs, 'utf8');
    } catch (error) {
      diagnostics.push({
        file: rel,
        stage: 'read',
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
      continue;
    }
    let data: unknown;
    try {
      data = /\.ya?ml$/.test(rel)
        ? // Custom application tags (`!php/const`, `!input`) are not errors
          // here, and their warnings used to leak onto stderr.
          (parseYaml(raw, { logLevel: 'silent' }) as unknown)
        : JSON.parse(raw);
    } catch {
      // Not an operational failure, and not a partial scan. Test corpora are
      // full of deliberately broken JSON, truncated files and JSONC configs;
      // making each one exit 2 meant the command failed almost everywhere.
      unparsable.push(rel);
      continue;
    }
    scanned++;
    const topKeys = topKeyNames(data);
    const dto = matchDto(
      path.basename(rel, path.extname(rel)),
      topKeys,
      containerKeyNames(data),
      dtos,
    );
    if (!dto) {
      // Plenty of fixtures legitimately describe no DTO. Counting that as a
      // diagnostic made the scan partial, which made 52 of 54 repositories
      // exit 2 for no reason.
      unmatched++;
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

  return { violations, scanned, unmatched, unparsable, diagnostics };
}

async function collectFixtureFiles(
  rootDir: string,
  rel: string,
  out: string[],
  paths: string[],
  diagnostics: ScanDiagnostic[],
  ignorePatterns: IgnorePattern[],
  visited: Set<string> = new Set(),
): Promise<void> {
  const dir = path.join(rootDir, rel);
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
    diagnostics.push({
      file: rel || '.',
      stage: 'discovery',
      message: error instanceof Error ? error.message : String(error),
      fatal: true,
    });
    return;
  }
  for (const entry of entries) {
    const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(path.join(rootDir, relEntry));
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue; // broken symlink
      }
    }
    if (isDir) {
      // This walk used to carry its own four-name exclusion list, so it
      // descended into .mypy_cache, .pnpm-store, coverage and linked
      // worktrees and called every file in them a fixture.
      if (isExcluded(relEntry, [], ignorePatterns, true)) continue;
      await collectFixtureFiles(
        rootDir,
        relEntry,
        out,
        paths,
        diagnostics,
        ignorePatterns,
        visited,
      );
    } else if (
      isFile &&
      FIXTURE_EXTS.has(path.extname(entry.name)) &&
      !isExcluded(relEntry, [], ignorePatterns, false) &&
      // An explicitly requested path is taken at its word; otherwise only
      // files that actually live among fixtures are considered.
      (paths.length > 0
        ? paths.some((p) => relEntry === p || relEntry.startsWith(p + '/'))
        : isFixturePath(relEntry))
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

/**
 * Top-level keys that could name a collection of records, meaning their value
 * actually holds objects. `{ "users": [ {...} ] }` names `UserRecord`;
 * `{ "edition": "2026-q1" }` is a scalar field that happens to share a name
 * with a class, and using it as a signal bound an unrelated report fixture to
 * an `Edition` DTO.
 */
function containerKeyNames(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      if (value.some((v) => v && typeof v === 'object' && !Array.isArray(v))) {
        out.push(key);
      }
    } else if (value && typeof value === 'object') {
      out.push(key);
    }
  }
  return out;
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
