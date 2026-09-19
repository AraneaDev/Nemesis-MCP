// ---------------------------------------------------------------------------
// Drift Analyzer: classifies doubles against the symbol graph into the four
// contract violations. Also handles suppression comments.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type {
  AnalyzeOptions,
  Finding,
  MethodSymbol,
  SymbolGraph,
  TestDouble,
  TypeSymbol,
} from './types.js';
import {
  hasUnresolvedAncestor,
  resolveTarget,
  resolveType,
  resolveMember,
  similarity,
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

export function isUntypedSide(type: string | null | undefined): boolean {
  if (!type) return true;
  const t = type.trim();
  return t === '' || /^(mixed|any|unknown)$/i.test(t);
}

function classify(
  d: TestDouble,
  graph: SymbolGraph,
  lines: string[],
  /** Targets already reported as undoubleable, so one class is named once. */
  reportedFinalTargets: Set<string>,
): Finding[] {
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

  // A double of a final class cannot be built at all: PHPUnit refuses to
  // generate a subclass for it, so every test using this mock dies at runtime
  // the moment the class is sealed. Reported once, against the target.
  const finalTargetKey = `${d.file}:${type.name}`;
  if (
    lang === 'php' &&
    type.modifiers?.includes('final') &&
    methodNames.length > 0 &&
    !reportedFinalTargets.has(finalTargetKey) &&
    !suppressed(lines, d.line)
  ) {
    reportedFinalTargets.add(finalTargetKey);
    findings.push({
      file: d.file,
      line: d.line,
      type: 'VISIBILITY_BREACH',
      confidence: 'definite',
      evidence: 'typed',
      double_type: d.framework,
      target: type.name,
      message: `'${type.name}' is final, so it cannot be doubled; this mock fails when the test runs.`,
    });
  }

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
    // A member declared as a property is not a missing method. Test suites
    // legitimately stub a function held in a field, and a class that assigns
    // `this.x = ...` in its constructor declares `x` as a field, not a method.
    if (!real && owner.fields?.has(m.name)) continue;

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

    // --- UNDOUBLEABLE MEMBERS -----------------------------------------------
    // Final and static members cannot be replaced by an instance double, so a
    // stub of one is configuration that never takes effect. Both are a
    // contract the test believes in and the runtime does not.
    if (lang === 'php' && !suppressed(lines, m.line)) {
      // PHPUnit builds its double by subclassing and disabling the original
      // constructor, so a stub of one of these is configuration that the
      // framework never consults.
      if (UNSTUBBABLE_PHP_MEMBERS.has(m.name)) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'VISIBILITY_BREACH',
          confidence: 'definite',
          evidence: 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `'${m.name}' cannot be stubbed on a double of '${owner.name}'; the framework never routes through it.`,
        });
      }
      const modifiers = real.modifiers ?? [];
      if (modifiers.includes('final')) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'VISIBILITY_BREACH',
          confidence: 'definite',
          evidence: 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Method '${m.name}' is final on '${owner.name}', so a double cannot override it.`,
        });
      } else if (modifiers.includes('static')) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'VISIBILITY_BREACH',
          confidence: 'warning',
          evidence: 'heuristic',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Method '${m.name}' is static on '${owner.name}', so an instance double does not intercept it.`,
        });
      }
    }

    // --- ARGUMENT TYPE DRIFT ------------------------------------------------
    // A `with(1, 'gbp')` against `charge(string $ref, int $cents)` has the
    // right number of arguments and the wrong ones. Only literals are
    // compared, so a variable or a matcher such as `$this->anything()` or
    // `expect.any(String)` is passed over rather than guessed at.
    for (const finding of argumentTypeFindings(d, m, owner, real, graph, lines, lang)) {
      findings.push(finding);
    }

    // --- ACCESSORS ----------------------------------------------------------
    // Spying on a getter or setter needs the access type; without it the
    // framework looks for a function, finds a property, and throws.
    const accessor = real.modifiers?.find((x) => x === 'get' || x === 'set');
    if (accessor && !d.accessType && !suppressed(lines, m.line)) {
      const remedy =
        lang === 'python'
          ? 'needs `new_callable=PropertyMock`'
          : `needs an access type such as '${accessor}'`;
      findings.push({
        file: d.file,
        line: m.line,
        type: 'VISIBILITY_BREACH',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `'${m.name}' is a ${accessor === 'get' ? 'getter' : 'setter'} on '${owner.name}', so doubling it ${remedy}.`,
      });
    }

    // --- ASYNC AND FLUENT CONTRACTS -----------------------------------------
    for (const finding of shapeOfReturnFindings(d, m, owner, real, graph, lines)) {
      findings.push(finding);
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
      } else if (stubType && typesCompatible(stubType, declared, lang) && d.returnExpr !== null) {
        // The value is compatible in shape. If it is an object literal and the
        // declared type is one whose fields are known, the fields themselves
        // can still be wrong: a mock returning `{ id }` where the code reads
        // `.email` is a stale double that nothing else would catch.
        findings.push(...structuralFieldFindings(d, m, owner, declared, graph, lines, lang));
      } else {
        const enumHit =
          d.returnExpr !== null ? enumLiteralCheck(graph, declared, d.returnExpr, d) : null;
        if (enumHit === 'ok') {
          // A valid case value; the kind comparison below would reject it.
        } else if (enumHit) {
          if (!suppressed(lines, m.line)) {
            findings.push({
              file: d.file,
              line: m.line,
              type: 'RETURN_DRIFT',
              confidence: 'definite',
              evidence: 'typed',
              double_type: d.framework,
              target: `${owner.name}::${m.name}`,
              message: `Stub returns ${d.returnExpr?.trim()} but that is not a case of ${enumHit.enumName}.${enumHit.suggestion ? ` Did you mean '${enumHit.suggestion}'?` : ''}`,
              ...(enumHit.suggestion ? { suggestion: enumHit.suggestion } : {}),
            });
          }
        } else if (stubType && !typesCompatible(stubType, declared, lang)) {
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
  const reportedFinalTargets = new Set<string>();
  for (const d of input.doubles) {
    const lines = input.fileLines.get(d.file) ?? [];
    findings.push(...classify(d, input.graph, lines, reportedFinalTargets));
  }
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    // The message is part of the identity: several distinct findings can
    // share a file, line, type and target, as when an object literal is
    // missing more than one required field of the same type.
    const k = `${f.file}:${f.line}:${f.type}:${f.target}:${f.message}`;
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

/**
 * Top-level keys of an object literal, or null when they cannot be known.
 *
 * A spread makes the key set open, and nothing useful can be said about a
 * literal whose shape is assembled elsewhere.
 */
export function objectLiteralKeys(expr: string): string[] | null {
  const t = expr.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const body = t.slice(1, -1);
  if (body.trim() === '') return [];
  const keys: string[] = [];
  for (const part of splitTopLevel(body, ',')) {
    if (part.startsWith('...')) return null; // open shape
    const colon = splitTopLevel(part, ':')[0] ?? part;
    const raw = colon.trim();
    // `{ id: 1 }`, `{ 'id': 1 }`, `{ id }`, `{ [k]: 1 }`
    if (raw.startsWith('[')) return null; // computed key
    const name = raw.replace(/^(['"`])(.*)\1$/, '$2').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    keys.push(name);
  }
  return keys;
}

/** Compare an object-literal return against the declared type's fields. */
function structuralFieldFindings(
  d: TestDouble,
  m: { name: string; line: number },
  owner: TypeSymbol,
  declared: string,
  graph: SymbolGraph,
  lines: string[],
  lang: string,
): Finding[] {
  if (suppressed(lines, m.line)) return [];
  const keys = objectLiteralKeys(d.returnExpr ?? '');
  if (keys === null) return [];

  // Unwrap Promise<T> and friends, then require a single named type.
  const alts = alternatives(declared);
  if (alts.length !== 1) return [];
  const canonical = canon(alts[0] ?? '');
  if (canonical.kind !== 'nominal') return [];

  const type = resolveType(graph, canonical.name ?? '', {
    language: d.language,
    fromFile: d.file,
  });
  if (!type?.fields || type.fields.size === 0) return [];
  // A type that inherits from outside the scanned tree may declare more
  // fields than we can see, so a missing one proves nothing.
  if (hasUnresolvedAncestor(graph, type, { language: d.language, fromFile: d.file })) {
    return [];
  }

  const present = new Set(keys);
  const findings: Finding[] = [];
  for (const [name, meta] of type.fields) {
    if (meta.required && !present.has(name)) {
      findings.push({
        file: d.file,
        line: m.line,
        type: 'RETURN_DRIFT',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `Stub returns an object missing required field '${name}' of ${type.name}.`,
      });
    }
  }
  for (const key of keys) {
    if (!type.fields.has(key)) {
      const suggestion = nearestField(type, key);
      findings.push({
        file: d.file,
        line: m.line,
        type: 'RETURN_DRIFT',
        confidence: 'warning',
        evidence: 'heuristic',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `Stub returns an object with field '${key}', which does not exist on ${type.name}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }
  void lang;
  return findings;
}

/** Closest declared field name, for a did-you-mean on a renamed field. */
function nearestField(type: TypeSymbol, key: string): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of type.fields?.keys() ?? []) {
    const distance = similarity(key, name);
    const threshold = Math.max(2, Math.floor(key.length * 0.4));
    if (distance <= threshold && (!best || distance < best.d)) {
      best = { name, d: distance };
    }
  }
  return best ? best.name : null;
}

/** Compare literal call arguments against the declared parameter types. */
function argumentTypeFindings(
  d: TestDouble,
  m: { name: string; line: number },
  owner: TypeSymbol,
  real: MethodSymbol,
  graph: SymbolGraph,
  lines: string[],
  lang: string,
): Finding[] {
  const args = d.withArgs;
  if (!args || args.length === 0) return [];
  if (suppressed(lines, m.line)) return [];
  const findings: Finding[] = [];
  const declaredNames = new Set(
    real.params.map((p) => p.name.replace(/^[$*]+/, '').trim()).filter(Boolean),
  );

  // A named argument carries the parameter's name, so a rename leaves it
  // pointing at nothing. It also makes position meaningless, so once one
  // appears only the names are checked.
  const named = args
    .map((a) => NAMED_ARGUMENT.exec(a.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  if (named.length > 0) {
    if (real.params.some((p) => p.variadic) || declaredNames.size === 0) return [];
    for (const match of named) {
      const key = match[1] ?? '';
      if (declaredNames.has(key)) continue;
      const suggestion = nearestName(key, declaredNames);
      findings.push({
        file: d.file,
        line: m.line,
        type: 'ARITY_MISMATCH',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `Argument named '${key}' does not match any parameter of ${owner.name}::${m.name}.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
    return findings;
  }

  for (const [index, argument] of args.entries()) {
    const param = real.params[index];
    if (!param || param.variadic) break;
    if (!param.type || isUntypedSide(param.type)) continue;
    const literal = inferType(argument, lang);
    if (!literal) continue; // variable, matcher, call: nothing to compare

    const enumHit = enumLiteralCheck(graph, param.type, argument, d);
    if (enumHit === 'ok') continue;
    if (enumHit) {
      findings.push({
        file: d.file,
        line: m.line,
        type: 'ARITY_MISMATCH',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `Argument ${index + 1} is ${argument.trim()} but that is not a case of ${enumHit.enumName}.${enumHit.suggestion ? ` Did you mean '${enumHit.suggestion}'?` : ''}`,
        ...(enumHit.suggestion ? { suggestion: enumHit.suggestion } : {}),
      });
      continue;
    }

    if (typesCompatible(literal, param.type, lang)) continue;
    findings.push({
      file: d.file,
      line: m.line,
      type: 'ARITY_MISMATCH',
      confidence: 'definite',
      evidence: 'typed',
      double_type: d.framework,
      target: `${owner.name}::${m.name}`,
      message: `Argument ${index + 1} is '${literal}' but ${owner.name}::${m.name} declares '${param.name}' as '${param.type}'.`,
    });
  }
  return findings;
}

/** Declared types that are awaited rather than used directly. */
const AWAITABLE = /^(Promise|PromiseLike|Awaitable|Task|Future|Coroutine|Deferred)\s*[<[]/;

/**
 * Contracts the stub asserts about the shape of the call rather than about the
 * value: that the method is awaitable, that it is fluent, and that any enum
 * member it names still exists.
 */
function shapeOfReturnFindings(
  d: TestDouble,
  m: { name: string; line: number },
  owner: TypeSymbol,
  real: MethodSymbol,
  graph: SymbolGraph,
  lines: string[],
): Finding[] {
  if (suppressed(lines, m.line)) return [];
  const findings: Finding[] = [];
  const declared = real.returnType?.trim() ?? '';
  const target = `${owner.name}::${m.name}`;

  // `mockResolvedValue` hands back a promise. On a method that stopped being
  // async the caller now receives a promise where it expects a value, and the
  // types still line up because the lattice unwraps the promise.
  if (d.resolvedReturn && declared && !isUntypedSide(declared)) {
    if (!AWAITABLE.test(declared) && !/^(any|unknown|mixed)$/i.test(declared)) {
      findings.push({
        file: d.file,
        line: m.line,
        type: 'RETURN_DRIFT',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target,
        message: `Stub resolves a value but ${target} returns '${declared}', which is not awaitable.`,
      });
    }
  }

  // `willReturnSelf()` asserts the method is fluent.
  if (d.returnsSelf && declared && !isUntypedSide(declared)) {
    const short = declared.replace(/^\\+/, '').split('\\').pop() ?? declared;
    const ownerShort = owner.name.replace(/^\\+/, '').split('\\').pop() ?? owner.name;
    const fluent =
      /^(self|static|\$this|this)$/i.test(short) ||
      short.toLowerCase() === ownerShort.toLowerCase();
    if (!fluent) {
      findings.push({
        file: d.file,
        line: m.line,
        type: 'RETURN_DRIFT',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target,
        message: `Stub returns the double itself but ${target} returns '${declared}', so the method is not fluent.`,
      });
    }
  }

  // An enum member named in the return value that the enum no longer has.
  const missing = missingEnumMember(d.returnExpr, graph, d);
  if (missing) {
    findings.push({
      file: d.file,
      line: m.line,
      type: 'RETURN_DRIFT',
      confidence: 'definite',
      evidence: 'typed',
      double_type: d.framework,
      target,
      message: `Stub returns '${missing.written}' but '${missing.enumName}' has no member '${missing.member}'.${missing.suggestion ? ` Did you mean '${missing.suggestion}'?` : ''}`,
      ...(missing.suggestion ? { suggestion: missing.suggestion } : {}),
    });
  }

  return findings;
}

const ENUM_MEMBER = /^([A-Za-z_$][\w$]*)\s*(?:::|\.)\s*([A-Za-z_$][\w$]*)$/;

/**
 * An `Enum::Case` or `Enum.Case` in a return value whose case is gone. A
 * renamed case still parses and still type-checks against the enum, so this is
 * drift that survives every other check here.
 */
function missingEnumMember(
  expr: string | null,
  graph: SymbolGraph,
  d: TestDouble,
): { written: string; enumName: string; member: string; suggestion: string | null } | null {
  if (!expr) return null;
  const match = ENUM_MEMBER.exec(expr.trim());
  if (!match?.[1] || !match[2]) return null;
  const [written, holder, member] = [expr.trim(), match[1], match[2]];

  const type = resolveType(graph, holder, {
    language: d.language,
    fromFile: d.file,
  });
  if (!type || type.kind !== 'enum') return null;
  // Cases are recorded as members; an enum we failed to read has none.
  const known = new Set<string>([...type.methods.keys(), ...(type.fields?.keys() ?? [])]);
  if (known.size === 0 || known.has(member)) return null;

  let suggestion: string | null = null;
  let best = Infinity;
  for (const candidate of known) {
    const distance = similarity(member, candidate);
    if (distance <= Math.max(2, Math.floor(member.length * 0.4)) && distance < best) {
      best = distance;
      suggestion = candidate;
    }
  }
  return { written, enumName: type.name, member, suggestion };
}

/** `name: value` in PHP, `name=value` in Python. */
const NAMED_ARGUMENT = /^([A-Za-z_][\w]*)\s*(?::(?!:)|=(?!=))\s*\S/;

/** Closest declared name, for a did-you-mean on a renamed parameter. */
function nearestName(key: string, candidates: Set<string>): string | null {
  let best: { name: string; d: number } | null = null;
  for (const candidate of candidates) {
    const distance = similarity(key, candidate);
    const threshold = Math.max(2, Math.floor(key.length * 0.4));
    if (distance <= threshold && (!best || distance < best.d)) {
      best = { name: candidate, d: distance };
    }
  }
  return best ? best.name : null;
}

/** PHP members a mocking framework cannot route through. */
const UNSTUBBABLE_PHP_MEMBERS = new Set(['__construct', '__destruct', '__clone']);

/**
 * A literal against a declared type that is a backed enum. A string is the
 * right shape for one whatever it says, so comparing kinds reports every
 * correct value as drift; what decides is whether the value is a case the
 * enum still has.
 *
 * Returns null when the declared type is not a backed enum the graph knows,
 * `'ok'` when the literal is a case, and the enum plus a suggestion otherwise.
 */
function enumLiteralCheck(
  graph: SymbolGraph,
  declared: string,
  literal: string,
  d: TestDouble,
): 'ok' | { enumName: string; suggestion: string | null } | null {
  // Only a scalar literal carries a backing value. `Status.Closed` is a
  // member reference, checked against the case names elsewhere, and treating
  // it as a backing value reported every correct one as missing.
  const kind = inferType(literal, d.language);
  if (kind !== 'string' && kind !== 'int' && kind !== 'float' && kind !== 'number') {
    return null;
  }

  const alternatives_ = alternatives(declared);
  if (alternatives_.length !== 1) return null;
  const canonical = canon(alternatives_[0] ?? '');
  if (canonical.kind !== 'nominal') return null;

  const type = resolveType(graph, canonical.name ?? '', {
    language: d.language,
    fromFile: d.file,
  });
  if (type?.kind !== 'enum' || !type.fields) return null;

  const backing = [...type.fields.values()]
    .map((f) => f.value)
    .filter((v): v is string => v !== undefined);
  if (backing.length === 0) return null; // a pure case list carries no scalar

  const written = literal.trim().replace(/^(['"`])([\s\S]*)\1$/, '$2');
  if (backing.includes(written)) return 'ok';

  let suggestion: string | null = null;
  let best = Infinity;
  for (const candidate of backing) {
    const distance = similarity(written, candidate);
    if (distance <= Math.max(2, Math.floor(written.length * 0.4)) && distance < best) {
      best = distance;
      suggestion = candidate;
    }
  }
  return { enumName: type.name, suggestion };
}
