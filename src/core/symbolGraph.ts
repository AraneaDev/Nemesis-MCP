// ---------------------------------------------------------------------------
// Symbol graph construction + resolution (extends / implements / uses chains).
// ---------------------------------------------------------------------------

import type {
  MethodSymbol,
  SymbolGraph,
  TypeSymbol,
} from './types.js';

export function emptyGraph(): SymbolGraph {
  return { types: new Map(), functions: new Map(), skippedLanguages: [] };
}

/** Lookup key: fully qualified names are matched case-insensitively. */
function key(name: string): string {
  return name.replace(/^\\+/, '').replace(/\\+$/, '').toLowerCase();
}

export function addType(graph: SymbolGraph, symbol: TypeSymbol): void {
  graph.types.set(key(symbol.name), symbol);
}

export function addFunction(graph: SymbolGraph, fn: MethodSymbol): void {
  graph.functions.set(key(fn.name), fn);
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

/** Find a type by (qualified or short) name. */
export function resolveType(graph: SymbolGraph, name: string): TypeSymbol | null {
  if (!name) return null;
  const direct = graph.types.get(key(name));
  if (direct) return direct;
  // short-name fallback: unique match among qualified names
  const wanted = key(name).split(/\\|\.|:/).pop() ?? key(name);
  let found: TypeSymbol | null = null;
  for (const [k, t] of graph.types) {
    const short = k.split(/\\|\.|:/).pop() ?? k;
    if (short === wanted) {
      if (found) return found; // ambiguous: return first deterministically
      found = t;
    }
  }
  return found;
}

/** Look up a method on a type, walking extends/implements/uses ancestors. */
export function resolveMember(
  graph: SymbolGraph,
  type: TypeSymbol,
  method: string,
  depth = 0,
): ResolvedMember | null {
  if (depth > MAX_DEPTH) return null;
  const local = type.methods.get(method);
  if (local) {
    return {
      owner: type,
      method: local,
      qualifiedName: `${type.name}::${method}`,
    };
  }
  const ancestors = [...type.extends, ...type.implements, ...type.uses];
  for (const ancName of ancestors) {
    const anc = resolveType(graph, ancName);
    if (!anc || anc === type) continue;
    const hit = resolveMember(graph, anc, method, depth + 1);
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
): { type: TypeSymbol; method: string | null; member: ResolvedMember | null } | null {
  const normalized = target.replace(/^\\+/, '');
  const parts = normalized.split(/::|\.|->/);
  if (parts.length >= 2) {
    const typeName = parts.slice(0, -1).join('\\');
    const method = parts[parts.length - 1] ?? null;
    const type = resolveType(graph, typeName);
    if (!type) return null;
    return { type, method: method && method.length > 0 ? method : null, member: method ? resolveMember(graph, type, method) : null };
  }
  const type = resolveType(graph, normalized);
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
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j] ?? 0;
  }
  return prev[n] ?? 0;
}

/** Rank candidate member names by similarity to `name`; best first. */
export function suggestMember(
  type: TypeSymbol,
  name: string,
): string | null {
  let best: { name: string; d: number } | null = null;
  for (const candidate of type.methods.keys()) {
    const d = similarity(name, candidate);
    const threshold = Math.max(2, Math.floor(name.length * 0.4));
    if (d <= threshold && (!best || d < best.d)) best = { name: candidate, d };
  }
  return best ? best.name : null;
}
