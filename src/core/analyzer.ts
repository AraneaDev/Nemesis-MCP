// ---------------------------------------------------------------------------
// Drift Analyzer: classifies doubles against the symbol graph into the four
// contract violations. Also handles suppression comments.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type { AnalyzeOptions, Finding, SymbolGraph, TestDouble, TypeSymbol } from './types.js';
import {
  hasUnresolvedAncestor,
  resolveTarget,
  resolveType,
  resolveMember,
  suggestMember,
} from './symbolGraph.js';
import { languageForFile } from './discovery.js';

const SUPPRESSION = /nemesis-ignore/i;

function suppressed(lines: string[], line1: number): boolean {
  const idx = line1 - 1;
  const same = lines[idx] ?? '';
  const above = lines[idx - 1] ?? '';
  return SUPPRESSION.test(same) || SUPPRESSION.test(above);
}

function qualify(type: TypeSymbol, method: string | null): string {
  return method ? `${type.name}::${method}` : type.name;
}

/**
 * True when a "method name" is really an interpolation or a variable, so no
 * literal member was ever named. PHP `$method`, `{name}`, `${name}`, `<name>`.
 */
function isDynamicName(name: string): boolean {
  const n = name.trim();
  if (n === '') return true;
  if (/^[$@%]/.test(n)) return true;
  if (/[${}<>[\]()`'"+\s]/.test(n)) return true;
  if (/^\d/.test(n)) return true;
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
}

function isUntypedSide(type: string | null | undefined): boolean {
  if (!type) return true;
  const t = type.trim();
  return t === '' || /^(mixed|any|unknown)$/i.test(t);
}

function classify(d: TestDouble, graph: SymbolGraph, lines: string[]): Finding[] {
  const findings: Finding[] = [];
  if (!d.targetSymbol) return findings;

  const lang = d.language;
  const hint = { language: d.language, fromFile: d.file };

  const methodNames = d.methods.length
    ? d.methods
    : d.method
      ? [{ name: d.method, line: d.line }]
      : [];

  // `targetSymbol` already names a type: extractors split `a.b.c.member` into
  // target and method themselves. Splitting it a second time drops a segment,
  // which used to turn the module path `core.webhook.manager` into the
  // unrelated class `Webhook` and report every function in it as a ghost.
  const type =
    resolveType(graph, d.targetSymbol, hint) ??
    (methodNames.length === 0 ? (resolveTarget(graph, d.targetSymbol, hint)?.type ?? null) : null);
  if (!type) return findings; // UNRESOLVED → skipped, never guessed

  for (const m of methodNames) {
    // A method name that is not a literal (`shouldReceive($method)` inside a
    // loop, an f-string, a template literal) names nothing we can check.
    if (isDynamicName(m.name)) continue;

    // Resolve each configured method against the target type (following
    // extends/implements/uses), regardless of how the target was written.
    const resolvedMember = resolveMember(graph, type, m.name, 0, {
      language: lang,
      fromFile: d.file,
    });

    const owner = resolvedMember?.owner ?? type;
    const real = resolvedMember?.method ?? null;

    // --- GHOST_METHOD -------------------------------------------------------
    if (!real && !owner.unknownMembers.has(m.name)) {
      const suggestion = suggestMember(owner, m.name);
      // A member missing from a type whose ancestry runs outside the scanned
      // tree may simply be inherited from there, so it cannot be called a
      // ghost with any confidence.
      const partialAncestry = hasUnresolvedAncestor(graph, owner, {
        language: lang,
        fromFile: d.file,
      });
      const known = owner.methods.size > 0 || owner.unknownMembers.size > 0;
      const confidence = known && !partialAncestry ? 'definite' : 'warning';
      if (!suppressed(lines, m.line)) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'GHOST_METHOD',
          confidence,
          evidence: confidence === 'warning' ? 'heuristic' : 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Method '${m.name}' does not exist on '${owner.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
          suggestion: suggestion ?? undefined,
        });
      }
      continue; // no further checks possible for a ghost method
    }

    if (!real) continue;

    // --- VISIBILITY_BREACH --------------------------------------------------
    if (real.visibility === 'private' || real.visibility === 'protected') {
      // Python has no access control: a single leading underscore is a naming
      // convention, and patching such a method in a test is idiomatic. Only
      // name-mangled `__dunder` members are treated as a definite breach.
      const conventionOnly = lang === 'python' && !m.name.startsWith('__');
      if (!suppressed(lines, m.line)) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'VISIBILITY_BREACH',
          confidence: conventionOnly ? 'warning' : 'definite',
          evidence: conventionOnly ? 'heuristic' : 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Stubbed ${real.visibility} method '${m.name}' bypasses the public interface of '${owner.name}'.`,
        });
      }
    }

    // --- ARITY_MISMATCH -----------------------------------------------------
    const arity = d.withArity ?? d.assertedArity;
    if (arity !== null) {
      const params = real.params;
      const takesVariadic = params.some((p) => p.variadic);
      const required = params.filter((p) => !p.hasDefault && !p.variadic).length;
      const max = takesVariadic ? Infinity : params.length;
      if (!takesVariadic && arity > max) {
        if (!suppressed(lines, m.line)) {
          findings.push({
            file: d.file,
            line: m.line,
            type: 'ARITY_MISMATCH',
            confidence: 'definite',
            evidence: 'typed',
            double_type: d.framework,
            target: `${owner.name}::${m.name}`,
            message: `Stub passes ${arity} argument(s) but '${owner.name}::${m.name}' accepts at most ${params.length}.`,
          });
        }
      } else if (arity < required) {
        if (!suppressed(lines, m.line)) {
          findings.push({
            file: d.file,
            line: m.line,
            type: 'ARITY_MISMATCH',
            confidence: 'definite',
            evidence: 'typed',
            double_type: d.framework,
            target: `${owner.name}::${m.name}`,
            message: `Stub passes ${arity} argument(s) but '${owner.name}::${m.name}' requires ${required}.`,
          });
        }
      }
    }

    // --- RETURN_DRIFT -------------------------------------------------------
    if (d.returnTypeHint || d.returnExpr !== null) {
      const declared = real.returnType;
      const stubType = d.returnTypeHint ?? inferType(d.returnExpr ?? '', lang);

      if (!declared || isUntypedSide(declared)) {
        // The test pins a concrete return value against a method that declares
        // no return type, so there is no contract to check it against. This is
        // what `untyped_only` was meant to surface; the mode could not return
        // anything before, because an untyped stub is treated as compatible
        // and never reached a finding at all.
        if (stubType && !isUntypedSide(stubType) && !suppressed(lines, m.line)) {
          findings.push({
            file: d.file,
            line: m.line,
            type: 'RETURN_DRIFT',
            confidence: 'warning',
            evidence: 'untyped',
            double_type: d.framework,
            target: `${owner.name}::${m.name}`,
            message: `Stub returns '${stubType}' but ${owner.name}::${m.name} declares no return type, so the contract cannot be verified.`,
          });
        }
      } else {
        if (stubType && !typesCompatible(stubType, declared, lang)) {
          // Two named types that simply differ may still be related by
          // inheritance, and the base class usually lives in a dependency
          // directory this tool never walks. Report it, but not as blocking.
          const unprovable = bothNominal(stubType, declared);
          if (!suppressed(lines, m.line)) {
            findings.push({
              file: d.file,
              line: m.line,
              type: 'RETURN_DRIFT',
              confidence: unprovable ? 'warning' : 'definite',
              evidence: unprovable ? 'heuristic' : 'typed',
              double_type: d.framework,
              target: `${owner.name}::${m.name}`,
              message: `Stub returns '${stubType}' but ${owner.name}::${m.name} returns '${declared}'.`,
            });
          }
        }
      }
    }
  }

  return findings;
}

/** Lightweight literal type inference for return expressions. */
export function inferType(expr: string, lang: string): string | null {
  const e = expr.trim();
  if (!e) return null;
  if (/^(null|None|nil|NULL)$/.test(e)) return 'null';
  if (/^undefined$/.test(e)) return 'undefined';
  if (/^(true|false|True|False)$/.test(e)) return 'bool';
  if (/^-?\d+(\.\d+)?$/.test(e)) return lang === 'php' ? 'int' : 'number';
  // string literals, including template literals and Python f/r/b prefixes
  if (/^[a-z]{0,2}(['"`])[\s\S]*\1$/i.test(e)) return 'string';
  if (/^\[[\s\S]*]$/.test(e) || /^(array|list|tuple|set|vec!)\s*[([]/.test(e)) {
    return lang === 'php' ? 'array' : 'list';
  }
  if (/^\{[\s\S]*}$/.test(e) || /^dict\s*\(/.test(e)) {
    return lang === 'php' ? 'array' : lang === 'python' ? 'dict' : 'object';
  }
  if (/^new\s+/.test(e)) {
    const m = /^new\s+\\?([\w\\]+)/.exec(e);
    return m?.[1] ?? null;
  }
  // bare identifier / call — unknown, do not guess
  return null;
}

// --- canonical type lattice -------------------------------------------------
//
// Both sides of a return-drift comparison are reduced to a small set of kinds
// before being compared. Without this, `bool` (inferred from a `true` literal)
// never matched TypeScript's `boolean`, and every correct stub of a boolean,
// array or interface-returning method was reported as definite drift.

type Kind =
  | 'wild'
  | 'null'
  | 'undefined'
  | 'void'
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'list'
  | 'dict'
  | 'callable'
  | 'nominal';

interface Canon {
  kind: Kind;
  /** Short (namespace-stripped) name, only for `nominal`. */
  name?: string;
}

/** Split `raw` on `sep`, ignoring separators nested in brackets or quotes. */
function splitTopLevel(raw: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of raw) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if ('<[({'.includes(ch)) depth++;
    else if ('>])}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Async/optional wrappers that carry the interesting type inside them. */
const ASYNC_WRAPPER =
  /^(Promise|PromiseLike|Awaitable|Task|Future|Coroutine|Deferred)\s*<([\s\S]+)>$/;
const PY_ASYNC = /^(Awaitable|Coroutine)\s*\[([\s\S]+)]$/;

/**
 * Reduce a declared type expression to the alternatives it may produce.
 * `string | null` → ['string', 'null']; `Promise<bool>` → ['bool'].
 */
function alternatives(raw: string, depth = 0): string[] {
  let t = raw.trim();
  if (!t || depth > 8) return [t];

  // `readonly T[]`, leading namespace separator
  t = t.replace(/^readonly\s+/, '').replace(/^\\/, '');

  // PHP / C# nullable shorthand
  if (t.startsWith('?')) return [...alternatives(t.slice(1), depth + 1), 'null'];

  const async1 = ASYNC_WRAPPER.exec(t);
  if (async1?.[2]) {
    return alternatives(splitTopLevel(async1[2], ',')[0] ?? '', depth + 1);
  }
  const async2 = PY_ASYNC.exec(t);
  if (async2?.[2]) {
    return alternatives(splitTopLevel(async2[2], ',')[0] ?? '', depth + 1);
  }

  const optional = /^Optional\s*\[([\s\S]+)]$/.exec(t);
  if (optional?.[1]) return [...alternatives(optional[1], depth + 1), 'null'];

  const union = /^Union\s*\[([\s\S]+)]$/.exec(t);
  if (union?.[1]) {
    return splitTopLevel(union[1], ',').flatMap((p) => alternatives(p, depth + 1));
  }

  const option = /^Option\s*<([\s\S]+)>$/.exec(t);
  if (option?.[1]) return [...alternatives(option[1], depth + 1), 'null'];

  const result = /^Result\s*<([\s\S]+)>$/.exec(t);
  if (result?.[1]) {
    return alternatives(splitTopLevel(result[1], ',')[0] ?? '', depth + 1);
  }

  const parts = splitTopLevel(t, '|');
  if (parts.length > 1) return parts.flatMap((p) => alternatives(p, depth + 1));

  return [t];
}

const WILD = /^(mixed|any|unknown|self|static|this|json|jsonvalue|serializable)$/;
const STRING = /^(string|str|&str|String|text|char)$/;
const BOOL = /^(bool|boolean)$/;
const INT = /^(int|integer|long|short|byte|bigint|usize|isize|[iu](8|16|32|64|128))$/;
const FLOAT = /^(float|double|number|real|decimal|f32|f64)$/;
const VOID = /^(void|none|nonetype|unit|never|nothing)$/;
const LIST =
  /^(array|list|sequence|iterable|iterator|generator|traversable|collection|vec|set|frozenset|tuple|arraylist|slice)$/;
const DICT =
  /^(dict|mapping|record|map|hashmap|btreemap|object|stdclass|assoc|counter|defaultdict|ordereddict)$/;
const CALLABLE = /^(callable|closure|function|fn|callback)$/;

/** Reduce one alternative (no unions left) to a canonical kind. */
function canon(raw: string): Canon {
  let t = raw
    .trim()
    .replace(/^readonly\s+/, '')
    .replace(/^\\/, '');
  if (!t) return { kind: 'wild' };

  // Strip trailing `[]` / `[][]` — an array of anything is a list.
  if (/\[\s*]$/.test(t)) return { kind: 'list' };

  // Literal types: `'on'`, `42`, `true`.
  if (/^(['"`])[\s\S]*\1$/.test(t)) return { kind: 'string' };
  if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float' };
  if (/^-?\d+$/.test(t)) return { kind: 'int' };
  if (/^(true|false)$/i.test(t)) return { kind: 'bool' };

  // TypeScript inline object type / mapped type
  if (/^\{[\s\S]*}$/.test(t)) return { kind: 'dict' };

  // Generic head: `Record<string, number>` → `Record`, `list[str]` → `list`.
  const generic = /^([\w\\.$]+)\s*[<[]/.exec(t);
  const head = generic?.[1] ?? t;
  const short = head.split(/[\\.]/).pop() ?? head;
  const lower = short.toLowerCase();

  if (WILD.test(lower)) return { kind: 'wild' };
  if (STRING.test(lower) || STRING.test(short)) return { kind: 'string' };
  if (BOOL.test(lower)) return { kind: 'bool' };
  if (INT.test(lower)) return { kind: 'int' };
  if (FLOAT.test(lower)) return { kind: 'float' };
  if (VOID.test(lower)) return { kind: 'void' };
  if (lower === 'null') return { kind: 'null' };
  if (lower === 'undefined') return { kind: 'undefined' };
  if (LIST.test(lower)) return { kind: 'list' };
  if (DICT.test(lower)) return { kind: 'dict' };
  if (CALLABLE.test(lower)) return { kind: 'callable' };

  return { kind: 'nominal', name: short };
}

/**
 * Does a stub producing `s` satisfy a declared alternative `d`?
 *
 * Deliberately lenient wherever the syntactic evidence runs out: an object
 * literal is assumed to structurally satisfy a named type, because checking
 * that properly needs the full type system this tool explicitly does not model.
 */
function kindSatisfies(s: Canon, d: Canon, lang: string): boolean {
  if (d.kind === 'wild' || s.kind === 'wild') return true;
  switch (s.kind) {
    case 'null':
    case 'undefined':
    case 'void':
      return d.kind === 'null' || d.kind === 'undefined' || d.kind === 'void';
    case 'bool':
      return d.kind === 'bool';
    case 'int':
    case 'float':
      // inferType collapses `42` and `4.2` into one kind, so int/float
      // widening goes both ways rather than reporting unprovable drift.
      return d.kind === 'int' || d.kind === 'float';
    case 'string':
      return d.kind === 'string';
    case 'list':
      // A PHP `array` literal is both a list and a hash.
      return d.kind === 'list' || (lang === 'php' && d.kind === 'dict');
    case 'dict':
      return d.kind === 'dict' || d.kind === 'nominal' || (lang === 'php' && d.kind === 'list');
    case 'callable':
      return d.kind === 'callable' || d.kind === 'nominal';
    case 'nominal':
      // A named stub type may extend, implement or alias the declared one, and
      // the relationship lives in a dependency directory that is never walked.
      // Only a clash with a primitive is treated as provable drift.
      if (d.kind === 'nominal') {
        return (s.name ?? '').toLowerCase() === (d.name ?? '').toLowerCase();
      }
      return d.kind === 'dict' || d.kind === 'list' || d.kind === 'callable';
    default:
      return false;
  }
}

/**
 * True when both sides name concrete types. Their relationship (subclass,
 * implementation, alias) is not knowable from syntax alone, because the base
 * type usually lives in `vendor/` or `node_modules/`, which are never walked.
 */
export function bothNominal(stub: string, declared: string): boolean {
  const s = alternatives(stub).map(canon);
  const d = alternatives(declared).map(canon);
  if (s.length === 0 || d.length === 0) return false;
  return s.every((c) => c.kind === 'nominal') && d.every((c) => c.kind === 'nominal');
}

/** Structural compatibility check between stub type and declared type. */
export function typesCompatible(stub: string, declared: string, lang: string): boolean {
  const s = stub.trim();
  const d = declared.trim();

  // unknown / dynamic stub values → assume compatible
  if (isUntypedSide(s)) return true;
  if (isUntypedSide(d)) return true;

  // The stub side arrives either as a raw literal expression or as an already
  // inferred/annotated type name; normalise the former before comparing.
  const stubType = inferType(s, lang) ?? s;

  const stubCanons = alternatives(stubType).map(canon);
  const declCanons = alternatives(d).map(canon);
  if (stubCanons.length === 0 || declCanons.length === 0) return true;

  return stubCanons.some((sc) => declCanons.some((dc) => kindSatisfies(sc, dc, lang)));
}

export interface AnalyzeInput {
  doubles: TestDouble[];
  graph: SymbolGraph;
  /** Map of relative file → source lines (for suppression checks). */
  fileLines: Map<string, string[]>;
  options: AnalyzeOptions;
}

export function analyzeDoubles(input: AnalyzeInput): Finding[] {
  const findings: Finding[] = [];
  for (const d of input.doubles) {
    const lines = input.fileLines.get(d.file) ?? [];
    findings.push(...classify(d, input.graph, lines));
  }
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const k = `${f.file}:${f.line}:${f.type}:${f.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.type.localeCompare(b.type),
  );
  return deduped;
}

/** Group findings by top-level directory for reporting. */
export function groupByDir(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const dir = path.dirname(f.file);
    const list = map.get(dir) ?? [];
    list.push(f);
    map.set(dir, list);
  }
  return map;
}

export { languageForFile };
