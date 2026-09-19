// ---------------------------------------------------------------------------
// Symbol graph construction + resolution (extends / implements / uses chains).
// ---------------------------------------------------------------------------

import type { LanguageId, MethodSymbol, SymbolGraph, TypeSymbol } from './types.js';
import { languageForFile } from './discovery.js';
import { resolveModule } from './moduleResolve.js';

export function emptyGraph(): SymbolGraph {
  return {
    types: new Map(),
    typeVariants: new Map(),
    functions: new Map(),
    exportsByFile: new Map(),
    modules: new Map(),
    skippedLanguages: [],
  };
}

/**
 * Languages that may legitimately share a symbol. A `.test.js` file exercising
 * a class declared in a `.ts` file is ordinary; a TypeScript test resolving
 * against a same-named Python class is not.
 */
function languageFamily(lang: LanguageId | null): string | null {
  if (lang === null) return null;
  if (lang === 'typescript' || lang === 'javascript') return 'js';
  return lang;
}

/** Family of the file a symbol was declared in. */
function familyOfSymbol(symbol: TypeSymbol): string | null {
  return languageFamily(languageForFile(symbol.file));
}

/** Lookup key: fully qualified names are matched case-insensitively. */
export function normalizeSymbolName(name: string): string {
  return name
    .replace(/^\\+|\\+$/g, '')
    .replace(/::|->/g, '.')
    .replace(/\\/g, '.')
    .toLowerCase();
}

function key(name: string): string {
  return normalizeSymbolName(name).replace(/\./g, '\\');
}

export function addType(graph: SymbolGraph, symbol: TypeSymbol): void {
  const k = key(symbol.name);
  graph.types.set(k, symbol);
  // Same-named types in different files (commonly a multi-language SDK repo
  // shipping one class per language) used to overwrite each other silently,
  // so a TypeScript test could be checked against a Python class.
  const variants = graph.typeVariants.get(k);
  if (variants) {
    if (!variants.some((v) => v.file === symbol.file && v.name === symbol.name)) {
      variants.push(symbol);
    }
  } else {
    graph.typeVariants.set(k, [symbol]);
  }
}

export function addFunction(graph: SymbolGraph, fn: MethodSymbol): void {
  graph.functions.set(key(fn.name), fn);
}

export function addModule(graph: SymbolGraph, module: TypeSymbol): void {
  graph.modules.set(module.file, module);
}

/** Max ancestor hops when following extends/implements/uses. */
const MAX_DEPTH = 12;

export interface ResolvedMember {
  owner: TypeSymbol;
  method: MethodSymbol;
  /** Human-readable qualified target, e.g. `App\PaymentGateway::chargeWithToken`. */
  qualifiedName: string;
}

export interface Resolution {
  type: TypeSymbol | null;
  /** Member found on the type or (transitively) an ancestor. */
  member: ResolvedMember | null;
}

/** Number of leading path segments two files share. */
function sharedPrefixDepth(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/**
 * Choose between same-named types. Candidates are first narrowed to the
 * language family of the test that named them, then to the one declared
 * closest to that test in the directory tree — which is what picks the right
 * `CatalogService` in a monorepo holding several. A tie is left unresolved:
 * callers report nothing rather than guess.
 */
export interface ResolveHint {
  language?: LanguageId;
  /** Test file that named the target, used as a proximity tie-break. */
  fromFile?: string;
}

function pickCandidate(candidates: TypeSymbol[], hint?: ResolveHint): TypeSymbol | null {
  if (candidates.length === 0) return null;

  // The language filter runs even for a lone candidate. Skipping it there left
  // a Python test patching `webhooks.is_private_url` resolving against
  // `export type webhooks` in a generated TypeScript API file, and every
  // function in that Python module was then reported as missing.
  let pool = candidates;
  const family = languageFamily(hint?.language ?? null);
  if (family !== null) {
    const sameFamily = pool.filter((c) => familyOfSymbol(c) === family);
    // Never fall back across languages.
    if (sameFamily.length === 0) return null;
    pool = sameFamily;
  }
  if (pool.length === 1) return pool[0] ?? null;

  const from = hint?.fromFile;
  if (from) {
    let best: TypeSymbol | null = null;
    let bestDepth = -1;
    let tied = false;
    for (const c of pool) {
      const depth = sharedPrefixDepth(from, c.file);
      if (depth > bestDepth) {
        bestDepth = depth;
        best = c;
        tied = false;
      } else if (depth === bestDepth) {
        tied = true;
      }
    }
    if (best && !tied) return best;
  }
  return null; // still ambiguous — must be qualified
}

/** Find a type by (qualified or short) name, narrowed by `hint`. */
export function resolveType(
  graph: SymbolGraph,
  name: string,
  hint?: ResolveHint,
): TypeSymbol | null {
  if (!name) return null;
  const k = key(name);
  const direct = graph.typeVariants.get(k);
  if (direct && direct.length > 0) {
    const hit = pickCandidate(direct, hint);
    // An exact key match wins, but only if it survives the language filter.
    // Returning its failure hid every namespaced PHP class whose short name
    // was also taken by an unqualified class in another language: the bare
    // key matched, the filter emptied it, and the qualified declaration
    // sitting in the graph was never looked for.
    if (hit) return hit;
  }

  // short-name fallback: unique match among qualified names
  const wanted = normalizeSymbolName(name).split('.').pop() ?? normalizeSymbolName(name);
  const candidates: TypeSymbol[] = [];
  for (const [candidateKey, variants] of graph.typeVariants) {
    const short = normalizeSymbolName(candidateKey).split('.').pop() ?? candidateKey;
    if (short === wanted) candidates.push(...variants);
  }

  // `patch('usage_tracker.transport.urlopen')` names a module attribute, not a
  // method: the target `usage_tracker.transport` must not match the class
  // `Transport`. Python modules are snake_case and classes CapWords, so for a
  // dotted Python target the final segment has to match case-sensitively.
  if (hint?.language === 'python' && name.includes('.')) {
    const tail = name.split('.').pop() ?? name;
    const exact = candidates.filter((c) => (c.name.split(/[.\\]/).pop() ?? c.name) === tail);
    return pickCandidate(exact, hint);
  }

  return pickCandidate(candidates, hint);
}

/** Look up a method on a type, walking extends/implements/uses ancestors. */
export function resolveMember(
  graph: SymbolGraph,
  type: TypeSymbol,
  method: string,
  depth = 0,
  hint?: ResolveHint,
): ResolvedMember | null {
  if (depth > MAX_DEPTH) return null;
  const lookupName = type.file.toLowerCase().endsWith('.php') ? method.toLowerCase() : method;
  const local =
    type.methods.get(lookupName) ??
    (type.file.toLowerCase().endsWith('.php')
      ? [...type.methods.entries()].find(
          ([name]) => name.toLowerCase() === method.toLowerCase(),
        )?.[1]
      : undefined);
  if (local) {
    return {
      owner: type,
      method: local,
      qualifiedName: `${type.name}::${method}`,
    };
  }
  // A module's members are what it defines and what it binds. An imported
  // name is an attribute of the importing module, which is the thing
  // `patch("pkg.mod.imported_name")` replaces.
  if (type.kind === 'module' && type.imports) {
    const binding = type.imports.get(method);
    if (binding) {
      const source =
        resolveModule(graph, binding.from, type.file) ?? resolveType(graph, binding.from, hint);
      if (source && source !== type) {
        const hit = resolveMember(graph, source, binding.name, depth + 1, hint);
        if (hit) return hit;
      }
      // Bound here, source outside the scan: it exists and nothing about it is
      // checkable. `unknownMembers` already holds the name, so the caller
      // reports nothing.
      return null;
    }
  }
  const ancestors = [...type.extends, ...type.implements, ...type.uses];
  const ownLanguage = hint?.language ?? languageForFile(type.file);
  const ownHint: ResolveHint = {
    ...(ownLanguage ? { language: ownLanguage } : {}),
    fromFile: hint?.fromFile ?? type.file,
  };
  for (const ancName of ancestors) {
    const anc = resolveType(graph, ancName, ownHint);
    if (!anc || anc === type) continue;
    const hit = resolveMember(graph, anc, method, depth + 1, ownHint);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a double target of the form `Type::method`, `Type.method`, or a bare
 * type name. Returns the type and (when a method was named) the member.
 */
export function resolveTarget(
  graph: SymbolGraph,
  target: string,
  hint?: ResolveHint,
): { type: TypeSymbol; method: string | null; member: ResolvedMember | null } | null {
  const normalized = target.replace(/^\\+/, '');
  const parts = normalized.split(/::|\.|->/);
  if (parts.length >= 2) {
    const typeName = parts.slice(0, -1).join('\\');
    const method = parts[parts.length - 1] ?? null;
    const type = resolveType(graph, typeName, hint);
    if (!type) return null;
    return {
      type,
      method: method && method.length > 0 ? method : null,
      member: method ? resolveMember(graph, type, method, 0, hint) : null,
    };
  }
  const type = resolveType(graph, normalized, hint);
  if (!type) return null;
  return { type, method: null, member: null };
}

/** Simple Damerau-ish Levenshtein distance for did-you-mean suggestions. */
export function similarity(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[n] ?? 0;
}

/** Rank candidate member names by similarity to `name`; best first. */
export function suggestMember(type: TypeSymbol, name: string): string | null {
  let best: { name: string; d: number } | null = null;
  for (const candidate of type.methods.keys()) {
    const d = similarity(name, candidate);
    const threshold = Math.max(2, Math.floor(name.length * 0.4));
    if (d <= threshold && (!best || d < best.d)) best = { name: candidate, d };
  }
  return best ? best.name : null;
}

/**
 * True when a type names an ancestor the graph does not contain, so its full
 * member set is unknowable. A Laravel model extends `Illuminate\...\Model`,
 * a Symfony controller extends `AbstractController`, and those live in
 * `vendor/`, which is never walked. Without this, every inherited framework
 * method looked missing from the subclass.
 */
export function hasUnresolvedAncestor(
  graph: SymbolGraph,
  type: TypeSymbol,
  hint?: ResolveHint,
  depth = 0,
  seen: Set<string> = new Set(),
): boolean {
  if (depth > MAX_DEPTH) return true;
  if (seen.has(type.name)) return false;
  seen.add(type.name);
  const ownHint: ResolveHint = {
    ...(hint?.language ? { language: hint.language } : {}),
    fromFile: hint?.fromFile ?? type.file,
  };
  for (const name of [...type.extends, ...type.implements, ...type.uses]) {
    const ancestor = resolveType(graph, name, ownHint);
    if (!ancestor) return true;
    if (ancestor === type) continue;
    if (hasUnresolvedAncestor(graph, ancestor, ownHint, depth + 1, seen)) return true;
  }
  return false;
}
