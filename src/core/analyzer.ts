// ---------------------------------------------------------------------------
// Drift Analyzer: classifies doubles against the symbol graph into the four
// contract violations. Also handles suppression comments.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type {
  AnalyzeOptions,
  AnalyzeStats,
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
import { resolveModule } from './moduleResolve.js';

const SUPPRESSION = /nemesis-ignore/i;

/**
 * Targets that never had a contract to check. A double on `console.log` or
 * `Date.now` is not a gap in this tool's reach, and counting it as one would
 * make the roadmap look longer than it is.
 */
export const UNKNOWABLE_ROOTS: ReadonlySet<string> = new Set([
  // JavaScript and the browser
  'console',
  'process',
  'Date',
  'Math',
  'JSON',
  'globalThis',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'Storage',
  'fetch',
  'crypto',
  'performance',
  'Intl',
  'Reflect',
  'Object',
  'Array',
  'Promise',
  // Node
  'fs',
  'path',
  'os',
  'http',
  'https',
  'child_process',
  'util',
  'url',
  'stream',
  'zlib',
  'buffer',
  // Python
  'sys',
  'io',
  'time',
  'random',
  'subprocess',
  'shutil',
  'logging',
  'asyncio',
  'datetime',
  'socket',
  'tempfile',
  'builtins',
  // PHP
  'PDO',
  'PDOStatement',
  'DateTime',
  'DateTimeImmutable',
  'DateTimeZone',
  'ArrayObject',
  'SplObjectStorage',
]);

/**
 * True when a target names something outside the scanned tree by construction:
 * a built-in, a standard-library module, or a package specifier. A bare
 * specifier is one that does not start with `.` and is not a dotted path
 * rooted in the tree, which is exactly how a package is written.
 */
export function isUnknowableTarget(target: string): boolean {
  const root = target.split(/[./\\]/)[0] ?? target;
  if (UNKNOWABLE_ROOTS.has(root)) return true;
  // `some-package`, `@scope/pkg`, `@scope/pkg/sub`: a specifier with no
  // relative prefix names something this scan does not own.
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*$/.test(target) && !target.startsWith('.')
    ? /[-/]/.test(target)
    : false;
}

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
  /** Symbol names the graph holds, keyed by the file they came from. */
  symbolsByFile: Map<string, Set<string>>,
): Finding[] {
  const findings: Finding[] = [];
  if (!d.targetSymbol) return findings;

  if (d.moduleSpecifier) {
    return moduleShapeFindings(d, lines, graph.exportsByFile);
  }

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
    resolveModule(graph, d.targetSymbol, d.file) ??
    (methodNames.length === 0 ? (resolveTarget(graph, d.targetSymbol, hint)?.type ?? null) : null);
  if (!type) {
    const gone = importedButGone(d, lines, symbolsByFile, graph.exportsByFile);
    if (gone && !suppressed(lines, d.line)) {
      findings.push({
        file: d.file,
        line: d.line,
        type: 'GHOST_METHOD',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: d.targetSymbol,
        message: `'${gone.symbol}' is imported from '${gone.specifier}', which this scan read, and is not exported there any more.`,
      });
    }
    return findings; // otherwise UNRESOLVED → skipped, never guessed
  }

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

    // A PHP class with `__call` answers to any method name, and Mockery builds
    // a proxy that routes through it, so the member is there at runtime.
    // PHPUnit is the other way round: it generates a subclass carrying only
    // the declared methods and refuses to configure anything else, so the same
    // stub really is broken there.
    if (
      !real &&
      lang === 'php' &&
      MOCKERY_FRAMEWORKS.has(d.framework) &&
      owner.methods.has('__call')
    )
      continue;

    if (!real && !owner.unknownMembers.has(m.name) && !owner.unknownMembers.has('*')) {
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

    // In JavaScript a static member lives on the class and an instance member
    // on the prototype, so a spy pointed at the wrong one finds `undefined`
    // and the framework throws. The receiver says which one the test meant.
    if (
      (lang === 'typescript' || lang === 'javascript') &&
      d.staticReceiver !== undefined &&
      !suppressed(lines, m.line)
    ) {
      const isStatic = (real.modifiers ?? []).includes('static');
      // A receiver is the class only when it is spelled like the class.
      // `const logger = internals.logger`, `dictionaryService`,
      // `levelManager`: each of these is an instance whose declaration this
      // file does not show, and each resolves to the class of the same name
      // because resolution ignores case. Requiring an exact match is what
      // separates `vi.spyOn(Clock, …)` from `vi.spyOn(clock, …)`.
      const spelledLikeTheClass =
        (d.targetSymbol ?? '') === (type.name.split(/[\\.]/).pop() ?? type.name);
      if (d.staticReceiver && !spelledLikeTheClass) {
        // Nothing to say: the receiver is an instance under another name.
      } else if (d.staticReceiver && !isStatic) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'GHOST_METHOD',
          confidence: 'definite',
          evidence: 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `'${m.name}' is an instance method of '${owner.name}', so it is not a member of the class itself.`,
        });
      } else if (!d.staticReceiver && isStatic) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'GHOST_METHOD',
          confidence: 'definite',
          evidence: 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `'${m.name}' is static on '${owner.name}', so it is not a member of an instance.`,
        });
      }
    }

    // A replacement function declaring more parameters than the method has is
    // a signature the test believes in and the code no longer offers: the
    // extra parameter is handed `undefined` on every call, silently. Fewer
    // parameters is ordinary, so only the excess is reported.
    if (d.fakeArity !== null && d.fakeArity !== undefined) {
      const params = real.params;
      if (!params.some((p) => p.variadic) && d.fakeArity > params.length) {
        if (!suppressed(lines, m.line)) {
          findings.push({
            file: d.file,
            line: m.line,
            type: 'ARITY_MISMATCH',
            confidence: 'definite',
            evidence: 'typed',
            double_type: d.framework,
            target: `${owner.name}::${m.name}`,
            message: `Replacement function declares ${d.fakeArity} parameter(s) but '${owner.name}::${m.name}' passes at most ${params.length}.`,
          });
        }
      }
      // A parameter the fake annotates has to accept what the method hands it.
      // Both sides annotated is the only case with anything to compare.
      (d.fakeParamTypes ?? []).forEach((fakeType, index) => {
        const param = params[index];
        if (!fakeType || !param?.type || param.variadic) return;
        if (isUntypedSide(fakeType) || isUntypedSide(param.type)) return;
        if (typesCompatible(param.type, fakeType, lang)) return;
        if (suppressed(lines, m.line)) return;
        findings.push({
          file: d.file,
          line: m.line,
          type: 'ARITY_MISMATCH',
          confidence: 'definite',
          evidence: 'typed',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Replacement function declares parameter ${index + 1} as '${fakeType}' but '${owner.name}::${m.name}' passes '${param.type}'.`,
        });
      });
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
      } else {
        // A literal value carries more than its kind. A declared type made of
        // literals, or a backed enum, accepts only certain values, and every
        // one of them reduces to the same kind, so the kind comparison below
        // would wave any string through. These run first for that reason.
        const unionHit =
          d.returnExpr !== null ? literalUnionCheck(declared, d.returnExpr, lang) : null;
        const enumHit =
          unionHit === null && d.returnExpr !== null
            ? enumLiteralCheck(graph, declared, d.returnExpr, d)
            : null;
        if (unionHit && unionHit !== 'ok') {
          if (!suppressed(lines, m.line)) {
            findings.push({
              file: d.file,
              line: m.line,
              type: 'RETURN_DRIFT',
              confidence: 'definite',
              evidence: 'typed',
              double_type: d.framework,
              target: `${owner.name}::${m.name}`,
              message: `Stub returns ${d.returnExpr?.trim()} but ${owner.name}::${m.name} only returns ${formatAllowed(unionHit.allowed)}.`,
            });
          }
        } else if (unionHit === 'ok' || enumHit === 'ok') {
          // A declared value; the comparisons below would misjudge it.
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
        } else if (stubType && typesCompatible(stubType, declared, lang)) {
          // Compatible in shape. If it is an object literal and the declared
          // type's fields are known, the fields can still be wrong: a mock
          // returning `{ id }` where the code reads `.email` is a stale double
          // that nothing else would catch.
          if (d.returnExpr !== null) {
            findings.push(...structuralFieldFindings(d, m, owner, declared, graph, lines, lang));
          }
        } else if (stubType) {
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

/**
 * Which bucket a double falls into. Kept separate from `classify` on purpose:
 * `classify` decides what to report, and this decides what to admit to. The
 * two ask the same resolution question, and a double that resolves but whose
 * member is missing counts as checked, because the analyzer had something to
 * say about it.
 */
function countDouble(d: TestDouble, graph: SymbolGraph, stats: AnalyzeStats): void {
  if (!d.targetSymbol) {
    stats.noTarget += 1;
    return;
  }

  // A module mock is compared against the module's export list rather than
  // resolved as a type, so asking `resolveType` about its specifier would
  // count every one of them as a gap. `classify` routes these to
  // `moduleShapeFindings`, and this has to agree with it: a summary that
  // contradicts the violations printed beside it is worse than no summary.
  if (d.moduleSpecifier) {
    if (!d.moduleSpecifier.startsWith('.')) {
      // Not relative, so a package by construction. Nothing this scan owns.
      stats.unknowable += 1;
      return;
    }
    const scanned = resolveSpecifier(d.file, d.moduleSpecifier).some((candidate) =>
      graph.exportsByFile.has(candidate),
    );
    if (scanned) stats.checked += 1;
    else stats.unresolved += 1;
    return;
  }

  if (isUnknowableTarget(d.targetSymbol)) {
    stats.unknowable += 1;
    return;
  }
  const hint = { language: d.language, fromFile: d.file };
  const reached =
    resolveType(graph, d.targetSymbol, hint) ?? resolveModule(graph, d.targetSymbol, d.file);
  if (reached) stats.checked += 1;
  else stats.unresolved += 1;
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
  if (/^[a-z]{0,2}(['"`])[\s\S]*\1$/i.test(e)) {
    // A `b`, `rb`, `br` (any case) prefix is a Python bytes literal, not a
    // string: `b"zipdata"` returned from a stub matching `-> bytes` is
    // correct code, not drift.
    const prefix = /^([a-z]{0,2})['"`]/i.exec(e)?.[1] ?? '';
    if (/b/i.test(prefix)) return 'bytes';
    return 'string';
  }
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
  | 'bytes'
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
// `byte` (singular) is the Java/C# integer type and stays in INT below;
// `bytes`/`bytearray`/`memoryview` are Python's binary-data types and must
// not satisfy `str`.
const BYTES = /^(bytes|bytearray|memoryview)$/;
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
  if (BYTES.test(lower)) return { kind: 'bytes' };
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
    case 'bytes':
      return d.kind === 'bytes';
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
  /** Filled in place when supplied. The analyzer's return value is unchanged. */
  stats?: import('./types.js').AnalyzeStats;
}

export function analyzeDoubles(input: AnalyzeInput): Finding[] {
  const findings: Finding[] = [];
  const reportedFinalTargets = new Set<string>();
  const symbolsByFile = new Map<string, Set<string>>();
  for (const variants of input.graph.typeVariants.values()) {
    for (const variant of variants) {
      const names = symbolsByFile.get(variant.file) ?? new Set<string>();
      names.add(variant.name.split(/[\\.]/).pop() ?? variant.name);
      symbolsByFile.set(variant.file, names);
    }
  }
  findings.push(...manualMockFindings(input.graph));
  const stats = input.stats;
  for (const d of input.doubles) {
    const lines = input.fileLines.get(d.file) ?? [];
    if (stats) countDouble(d, input.graph, stats);
    findings.push(...classify(d, input.graph, lines, reportedFinalTargets, symbolsByFile));
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

    const unionHit = literalUnionCheck(param.type, argument, lang);
    if (unionHit === 'ok') continue;
    if (unionHit) {
      findings.push({
        file: d.file,
        line: m.line,
        type: 'ARITY_MISMATCH',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${owner.name}::${m.name}`,
        message: `Argument ${index + 1} is ${argument.trim()} but '${param.name}' only accepts ${formatAllowed(unionHit.allowed)}.`,
      });
      continue;
    }

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

  // `mockResolvedValue` and `mockRejectedValue` both hand back a promise. On a
  // method that stopped being async the caller now receives a promise where it
  // expects a value, and the types still line up because the lattice unwraps
  // the promise.
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
        message: `Stub hands back a promise but ${target} returns '${declared}', which is not awaitable.`,
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
/** Frameworks that build a proxy rather than a subclass of the real class. */
const MOCKERY_FRAMEWORKS = new Set(['Mockery', 'Pest', 'Pest/Mockery']);

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

/** A type written as a literal, such as `'on'` or `42`. */
function literalTypeValue(text: string): string | null {
  const t = text.trim();
  if (/^(['"`])[\s\S]*\1$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^(true|false)$/.test(t)) return t;
  return null;
}

/**
 * A literal against a declared type made entirely of literals, such as
 * `'on' | 'off'` or `1 | 2 | 3`. Every member reduces to the same kind, so
 * comparing kinds accepts any string at all; what decides is the value.
 */
function formatAllowed(allowed: string[]): string {
  // Quote what was written as a string; leave numbers and booleans bare.
  const shown = allowed.map((a) => (/^(-?\d+(\.\d+)?|true|false)$/.test(a) ? a : `'${a}'`));
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`;
}

function literalUnionCheck(
  declared: string,
  literal: string,
  lang: string,
): 'ok' | { allowed: string[] } | null {
  const kind = inferType(literal, lang);
  if (kind !== 'string' && kind !== 'int' && kind !== 'float' && kind !== 'number') {
    return null;
  }
  const parts = alternatives(declared);
  if (parts.length < 2) return null; // a single literal type is not a choice

  const allowed: string[] = [];
  for (const part of parts) {
    const value = literalTypeValue(part);
    if (value === null) return null; // not every member is a literal
    allowed.push(value);
  }

  const written = literal.trim().replace(/^(['"`])([\s\S]*)\1$/, '$2');
  return allowed.includes(written) ? 'ok' : { allowed };
}

const IMPORT_NAMED = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/;
const IMPORT_DEFAULT = /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * A manual mock in `__mocks__` stands in for the module beside its directory,
 * and the names it exports are what the test believes that module exports. An
 * export the real module does not have is dead: nothing imports it, and the
 * fake is loaded in place of a module that never had it.
 *
 * Exporting a subset is the point of a manual mock, so only the surplus is
 * reported. A `__mocks__` file with no sibling names a package rather than a
 * file, and packages are not this scan's to account for.
 */
function manualMockFindings(graph: SymbolGraph): Finding[] {
  const findings: Finding[] = [];
  for (const [file, exports] of graph.exportsByFile) {
    if (!exports) continue;
    const match = /^(.*)__mocks__\/([^/]+)$/.exec(file);
    if (!match) continue;
    const real = `${match[1]}${match[2]}`;
    const realExports = graph.exportsByFile.get(real);
    if (!realExports) continue;
    for (const name of exports) {
      if (name === 'default' || name.startsWith('__') || realExports.has(name)) continue;
      const suggestion = nearestName(name, realExports);
      findings.push({
        file,
        line: 1,
        type: 'GHOST_METHOD',
        confidence: 'definite',
        evidence: 'typed',
        double_type: 'manual_mock',
        target: `${real}::${name}`,
        message: `The manual mock exports '${name}', which '${real}' does not.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }
  return findings;
}

/**
 * A module replaced wholesale supplies a key per export it stands in for.
 * A key the module does not export is configuration nothing can reach: the
 * import of that name resolves to the real module's missing export, and the
 * fake sits beside it unused until someone touches it.
 *
 * Only a file this scan read and whose export list it could take whole.
 * `default` always passes: a module with no default export is a compile error
 * long before this could say anything useful about it.
 */
function moduleShapeFindings(
  d: TestDouble,
  lines: string[],
  exportsByFile: Map<string, Set<string> | null>,
): Finding[] {
  const findings: Finding[] = [];
  const specifier = d.moduleSpecifier ?? '';
  for (const candidate of resolveSpecifier(d.file, specifier)) {
    if (!exportsByFile.has(candidate)) continue;
    const exports = exportsByFile.get(candidate);
    if (!exports) return findings;
    for (const m of d.methods) {
      if (m.name === 'default' || exports.has(m.name)) continue;
      // A leading double underscore is the ecosystem's mark for a handle the
      // fake adds for the test's own use: `__reset`, `__set`, `__esModule`.
      // Those are not claims about what the module exports.
      if (m.name.startsWith('__')) continue;
      if (suppressed(lines, m.line)) continue;
      const suggestion = nearestName(m.name, exports);
      findings.push({
        file: d.file,
        line: m.line,
        type: 'GHOST_METHOD',
        confidence: 'definite',
        evidence: 'typed',
        double_type: d.framework,
        target: `${specifier}::${m.name}`,
        message: `The mock of '${specifier}' supplies '${m.name}', which that module does not export.${suggestion ? ` Did you mean '${suggestion}'?` : ''}`,
        ...(suggestion ? { suggestion } : {}),
      });
    }
    return findings;
  }
  return findings;
}

/**
 * A target the test imports from a file this scan actually read, where that
 * file no longer declares it: a class that was renamed or deleted and left a
 * double behind.
 *
 * Every part of that sentence is load-bearing. An earlier attempt inferred it
 * from a failed resolution alone and was wrong every time, because resolution
 * also fails for a namespace import, for a value rather than a type, for an
 * alias, and for an ambiguous name. So: only a named or default import, only a
 * relative specifier, only when the resolved file gave the graph at least one
 * symbol, and the name looked up is the one the module exports rather than the
 * one the test calls it.
 */
function importedButGone(
  d: TestDouble,
  lines: string[],
  symbolsByFile: Map<string, Set<string>>,
  exportsByFile: Map<string, Set<string> | null>,
): { symbol: string; specifier: string } | null {
  if (d.language !== 'typescript' && d.language !== 'javascript') return null;
  const wanted = (d.targetSymbol ?? '').split(/[\\.]/).pop() ?? '';
  if (!wanted) return null;

  for (const line of lines) {
    const named = IMPORT_NAMED.exec(line);
    const fallback = named ? null : IMPORT_DEFAULT.exec(line);
    const specifier = named?.[2] ?? fallback?.[2];
    if (!specifier || !specifier.startsWith('.')) continue;

    // The exported name, which an alias hides: `import { Foo as Bar }` binds
    // Bar in the test and Foo in the module.
    let exported: string | null = null;
    if (named?.[1]) {
      for (const part of named[1].split(',')) {
        const [source, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
        if (!source) continue;
        if ((alias ?? source) === wanted) exported = source;
      }
    } else if (fallback?.[1] === wanted) {
      exported = wanted;
    }
    if (!exported) continue;

    for (const candidate of resolveSpecifier(d.file, specifier)) {
      // The export list is the whole answer where the file has one: it covers
      // functions and values as well as types, so a name of any shape can be
      // asked about. A file that re-exports with `export *` maps to null,
      // and names arriving from elsewhere are not this file's to account for.
      if (exportsByFile.has(candidate)) {
        const exports = exportsByFile.get(candidate);
        if (!exports) return null;
        return exports.has(exported) ? null : { symbol: exported, specifier };
      }
      const names = symbolsByFile.get(candidate);
      if (!names || names.size === 0) continue; // never read, or holds no types
      // Without an export list the graph holds types only, so a lower-case
      // binding may be a value that is present and simply not a type.
      if (!/^[A-Z]/.test(exported)) continue;
      if (names.has(exported)) return null; // still there under another route
      return { symbol: exported, specifier };
    }
  }
  return null;
}

/** Repository-relative paths a relative specifier could mean. */
function resolveSpecifier(fromFile: string, specifier: string): string[] {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile.split(path.sep).join('/')), specifier),
  );
  const stripped = base.replace(/\.(m|c)?js$/, ''); // ESM TypeScript writes .js
  const out: string[] = [];
  for (const stem of new Set([base, stripped])) {
    for (const extension of EXTENSIONS) out.push(stem + extension);
    for (const extension of EXTENSIONS) out.push(`${stem}/index${extension}`);
  }
  return out;
}
