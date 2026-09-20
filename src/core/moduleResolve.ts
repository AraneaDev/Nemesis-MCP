// ---------------------------------------------------------------------------
// Finding the module a double names, by import specifier, TypeScript path
// alias, or dotted Python path.
// ---------------------------------------------------------------------------

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SymbolGraph, TsPathAlias, TypeSymbol } from './types.js';
import { isExcluded, loadIgnoreFile } from './ignore.js';

/**
 * Every extension `discovery.ts` indexes.
 *
 * `.mts` and `.cts` were missing from this list while a near-identical copy in
 * the analyzer was missing `.py`, so each resolver could reach files the other
 * could not: a relative target pointing at an indexed `.mts` never resolved
 * through `resolveModule`. One list, one helper, both callers.
 */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'];
const TSCONFIG_NAME = 'tsconfig.json';
const MAX_EXTENDS_DEPTH = 8;

/** Repository-relative candidates a resolved (extension-less) path could mean. */
function extensionCandidates(base: string): string[] {
  const stripped = base.replace(/\.(m|c)?js$/, ''); // ESM TypeScript writes .js
  const out: string[] = [];
  for (const stem of new Set([base, stripped])) {
    out.push(stem);
    for (const extension of EXTENSIONS) out.push(stem + extension);
    for (const extension of EXTENSIONS) out.push(`${stem}/index${extension}`);
  }
  return out;
}

/** Repository-relative paths a relative specifier could mean. */
export function specifierCandidates(fromFile: string, specifier: string): string[] {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile.split(path.sep).join('/')), specifier),
  );
  return extensionCandidates(base);
}

/** Alias rules that apply to a file, deepest declaring directory wins. */
function applicableAliasRules(rules: TsPathAlias[], fromDir: string): TsPathAlias[] {
  let bestDepth = -1;
  let applicable: TsPathAlias[] = [];
  for (const rule of rules) {
    const cd = rule.configDir;
    const encloses = cd === '.' || fromDir === cd || fromDir.startsWith(`${cd}/`);
    if (!encloses) continue;
    const depth = cd === '.' ? 0 : cd.split('/').length;
    if (depth > bestDepth) {
      bestDepth = depth;
      applicable = [rule];
    } else if (depth === bestDepth) {
      applicable.push(rule);
    }
  }
  return applicable;
}

/** The wildcard portion of `target` under a wildcard `rule`, or null when it does not match. */
function matchAliasPattern(rule: TsPathAlias, target: string): string | null {
  if (!target.startsWith(rule.prefix) || !target.endsWith(rule.suffix)) return null;
  if (target.length < rule.prefix.length + rule.suffix.length) return null;
  return target.slice(rule.prefix.length, target.length - rule.suffix.length);
}

/**
 * The one rule `target` selects among `rules`, following TypeScript's own
 * `paths` precedence: an exact key (no `*`) matches only when `target`
 * equals it outright, and wins over every wildcard key when it does.
 * Otherwise the matching wildcard key with the longest prefix before `*`
 * wins. Only one rule is ever selected — TypeScript never falls through to
 * a less specific pattern when the winning one fails to resolve, and
 * neither does this scan.
 */
function selectAliasRule(
  rules: TsPathAlias[],
  target: string,
): { rule: TsPathAlias; middle: string } | null {
  const exactRule = rules.find((rule) => rule.exact && rule.prefix === target);
  if (exactRule) return { rule: exactRule, middle: '' };

  let best: { rule: TsPathAlias; middle: string } | null = null;
  for (const rule of rules) {
    if (rule.exact) continue;
    const middle = matchAliasPattern(rule, target);
    if (middle === null) continue;
    if (!best || rule.prefix.length > best.rule.prefix.length) {
      best = { rule, middle };
    }
  }
  return best;
}

/**
 * Resolve `target` through the repository's `tsconfig.json` `paths` aliases,
 * or null. Only the alias rules whose declaring directory encloses `fromFile`
 * apply, and among those the one declared in the deepest (most specific)
 * directory wins — a nested tsconfig's aliases apply to files under it, not
 * to the whole repository. Within that directory, `selectAliasRule` then
 * picks the single most specific pattern; if that one rule's target is not a
 * scanned file, resolution fails rather than trying a less specific rule.
 */
function resolveAlias(graph: SymbolGraph, target: string, fromFile: string): TypeSymbol | null {
  const rules = graph.tsPathAliases;
  if (!rules || rules.length === 0) return null;
  const fromDir = path.posix.dirname(fromFile.split(path.sep).join('/'));
  const applicable = applicableAliasRules(rules, fromDir);

  const selected = selectAliasRule(applicable, target);
  if (!selected) return null;
  const { rule, middle } = selected;
  if (rule.targets.length !== 1) return null; // several targets: silence beats a guess

  const resolvedPath = path.posix.normalize(rule.targets[0]!.replace('*', middle));
  for (const candidate of extensionCandidates(resolvedPath)) {
    const hit = graph.modules.get(candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * True when `target` matches the pattern of a configured path alias applying
 * to `fromFile`, whether or not that alias resolves to a scanned file. Used
 * to tell a genuine package specifier (never a local path) apart from a local
 * alias whose target could not be found, which stays a real, reportable gap
 * rather than something this scan never owned.
 */
export function isTsAliasSpecifier(graph: SymbolGraph, target: string, fromFile: string): boolean {
  const rules = graph.tsPathAliases;
  if (!rules || rules.length === 0) return false;
  const fromDir = path.posix.dirname(fromFile.split(path.sep).join('/'));
  const applicable = applicableAliasRules(rules, fromDir);
  return selectAliasRule(applicable, target) !== null;
}

/**
 * The module a target names, or null.
 *
 * A relative specifier is resolved against the importing file. A specifier
 * matching a `tsconfig.json` `paths` alias is resolved against that config's
 * own directory. A dotted path becomes a path fragment and is matched against
 * the tail of every scanned file's path: exactly one match is the answer, and
 * zero or more than one is silence. There is no ranking, because a rule that
 * picks a winner among several is a rule that guesses.
 */
export function resolveModule(
  graph: SymbolGraph,
  target: string,
  fromFile: string,
): TypeSymbol | null {
  if (!target) return null;

  if (target.startsWith('.')) {
    for (const candidate of specifierCandidates(fromFile, target)) {
      const hit = graph.modules.get(candidate);
      if (hit) return hit;
    }
    return null;
  }

  const aliasHit = resolveAlias(graph, target, fromFile);
  if (aliasHit) return aliasHit;

  if (!target.includes('.') || /[/\\]/.test(target)) return null;

  // `core.system.subprocess_runner` -> `core/system/subprocess_runner`
  const fragment = target.split('.').filter(Boolean).join('/');
  if (!fragment) return null;

  let found: TypeSymbol | null = null;
  for (const [file, module] of graph.modules) {
    const withoutExtension = file.replace(/\.[^./]+$/, '');
    if (withoutExtension !== fragment && !withoutExtension.endsWith(`/${fragment}`)) continue;
    if (found) return null; // ambiguous
    found = module;
  }
  return found;
}

// ---------------------------------------------------------------------------
// tsconfig.json discovery and parsing.
// ---------------------------------------------------------------------------

/** Find every `tsconfig.json` under `rootDir`, respecting the usual excludes. */
async function findTsconfigFiles(rootDir: string, extraExcludes: string[]): Promise<string[]> {
  const patterns = loadIgnoreFile(rootDir);
  const found: string[] = [];
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
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // broken symlink
        }
      }

      if (isDir) {
        if (isExcluded(rel, extraExcludes, patterns, true)) continue;
        await walk(abs);
      } else if (isFile && entry.name === TSCONFIG_NAME) {
        found.push(rel);
      }
    }
  }

  await walk(rootDir);
  found.sort();
  return found;
}

/**
 * Strip line and block comments from JSONC text, leaving string contents
 * alone. Cheap and line/column-preserving enough for `JSON.parse` afterward.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let stringChar = '"';
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Drop a trailing comma before `}` or `]`, which JSON.parse otherwise rejects. */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse JSONC defensively: an unparsable file is "no config", not a thrown error. */
function parseJsonc(text: string): unknown | null {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return null;
  }
}

interface CompilerPaths {
  /** Already resolved to rootDir-relative posix paths, each against the
   *  directory (and `baseUrl`, if any) of the config that declared it. */
  paths?: Record<string, string[]>;
}

/**
 * Read one `tsconfig.json`, following a relative `extends` chain and merging
 * `paths` along the way (a key the file declares itself wins over the same
 * key inherited from what it extends). An `extends` that is not a relative
 * path (a package like `@tsconfig/node18`) is left unfollowed: resolving it
 * would mean reading into `node_modules`, which is not cheap, so it is
 * treated as contributing no aliases rather than guessed at.
 *
 * TypeScript resolves `baseUrl` and `paths` relative to the directory of the
 * config file that DECLARES them, not the directory of a child config that
 * merely inherits them via `extends`. A child that adds its own `paths`
 * without its own `baseUrl` resolves those relative to its own directory
 * (`baseUrl` defaults to `.`) — never to a parent's `baseUrl`, and a parent's
 * `paths` never resolves against the child's directory either. So each
 * level's `paths` is resolved to an absolute (rootDir-relative) target here,
 * at the point it is read, before it is merged into what a child inherits.
 */
async function readTsconfigMerged(
  rootDir: string,
  relPath: string,
  depth: number,
  visited: Set<string>,
): Promise<CompilerPaths | null> {
  if (depth > MAX_EXTENDS_DEPTH) return null;
  const abs = path.join(rootDir, relPath);
  const key = path.resolve(abs);
  if (visited.has(key)) return null;
  visited.add(key);

  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseJsonc(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  let merged: CompilerPaths = {};
  if (typeof obj.extends === 'string' && obj.extends.startsWith('.')) {
    const parentDir = path.posix.dirname(relPath.split(path.sep).join('/'));
    const extendsSpecifier = obj.extends.endsWith('.json') ? obj.extends : `${obj.extends}.json`;
    const parentRel = path.posix.normalize(path.posix.join(parentDir, extendsSpecifier));
    const parentResult = await readTsconfigMerged(rootDir, parentRel, depth + 1, visited);
    if (parentResult) merged = { ...parentResult };
  }

  const co = obj.compilerOptions;
  if (co && typeof co === 'object') {
    const co2 = co as Record<string, unknown>;
    if (co2.paths && typeof co2.paths === 'object') {
      const selfDir = path.posix.dirname(relPath.split(path.sep).join('/'));
      const baseUrl = typeof co2.baseUrl === 'string' ? co2.baseUrl : '.';
      const baseDir = path.posix.normalize(path.posix.join(selfDir, baseUrl));
      const resolved: Record<string, string[]> = {};
      for (const [k, rawTargets] of Object.entries(co2.paths as Record<string, unknown>)) {
        if (!Array.isArray(rawTargets)) continue;
        resolved[k] = rawTargets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => path.posix.normalize(path.posix.join(baseDir, t)));
      }
      merged.paths = { ...(merged.paths ?? {}), ...resolved };
    }
  }
  return merged;
}

/**
 * Read every `tsconfig.json` under `rootDir` once and turn its `paths` into
 * resolved alias rules, scoped to that config's own directory. Called once
 * per scan; `resolveModule` consults the result per double rather than
 * re-reading anything.
 */
export async function loadTsPathAliases(
  rootDir: string,
  extraExcludes: string[] = [],
): Promise<TsPathAlias[]> {
  const files = await findTsconfigFiles(rootDir, extraExcludes);
  const rules: TsPathAlias[] = [];

  for (const relPath of files) {
    const merged = await readTsconfigMerged(rootDir, relPath, 0, new Set());
    if (!merged?.paths) continue;

    const configDir = path.posix.dirname(relPath.split(path.sep).join('/'));

    for (const [key, targets] of Object.entries(merged.paths)) {
      if ((key.match(/\*/g) ?? []).length > 1) continue; // not a valid TS pattern
      const starIdx = key.indexOf('*');
      const exact = starIdx === -1;
      const prefix = exact ? key : key.slice(0, starIdx);
      const suffix = exact ? '' : key.slice(starIdx + 1);
      rules.push({ configDir, prefix, suffix, exact, targets });
    }
  }

  return rules;
}
