// ---------------------------------------------------------------------------
// Drift Analyzer: classifies doubles against the symbol graph into the four
// contract violations. Also handles suppression comments.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type {
  AnalyzeOptions,
  Finding,
  SymbolGraph,
  TestDouble,
  TypeSymbol,
} from './types.js';
import { resolveTarget, resolveMember, suggestMember } from './symbolGraph.js';
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

function isUntypedSide(type: string | null | undefined): boolean {
  if (!type) return true;
  const t = type.trim();
  return t === '' || /^(mixed|any|unknown)$/i.test(t);
}

function classify(
  d: TestDouble,
  graph: SymbolGraph,
  lines: string[],
): Finding[] {
  const findings: Finding[] = [];
  if (!d.targetSymbol) return findings;

  const resolved = resolveTarget(graph, d.targetSymbol);
  if (!resolved) return findings; // UNRESOLVED → skipped, never guessed

  const { type } = resolved;
  const lang = d.language;

  const methodNames = d.methods.length
    ? d.methods
    : d.method
      ? [{ name: d.method, line: d.line }]
      : [];

  for (const m of methodNames) {
    // Resolve each configured method against the target type (following
    // extends/implements/uses), regardless of how the target was written.
    const resolvedMember = resolveMember(graph, type, m.name);

    const owner = resolvedMember?.owner ?? type;
    const real = resolvedMember?.method ?? null;

    // --- GHOST_METHOD -------------------------------------------------------
    if (!real && !owner.unknownMembers.has(m.name)) {
      const suggestion = suggestMember(owner, m.name);
      const confidence = owner.methods.size > 0 || owner.unknownMembers.size > 0
        ? 'definite'
        : 'warning';
      if (!suppressed(lines, m.line)) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'GHOST_METHOD',
          confidence,
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
      if (!suppressed(lines, m.line)) {
        findings.push({
          file: d.file,
          line: m.line,
          type: 'VISIBILITY_BREACH',
          confidence: 'definite',
          double_type: d.framework,
          target: `${owner.name}::${m.name}`,
          message: `Stubbed ${real.visibility} method '${m.name}' bypasses the public interface of '${owner.name}'.`,
        });
      }
    }

    // --- ARITY_MISMATCH -----------------------------------------------------
    const arity =
      d.withArity ?? d.assertedArity;
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
      if (declared && !isUntypedSide(declared)) {
        const stubType = d.returnTypeHint ?? inferType(d.returnExpr ?? '', lang);
        if (stubType && !typesCompatible(stubType, declared, lang)) {
          const untyped = isUntypedSide(stubType);
          if (!suppressed(lines, m.line)) {
            findings.push({
              file: d.file,
              line: m.line,
              type: 'RETURN_DRIFT',
              confidence: untyped ? 'warning' : 'definite',
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
  if (/^(['"]).*\1$/.test(e)) return lang === 'php' ? 'string' : 'string';
  if (/^\[.*]$/.test(e) || /^\{.*}$/.test(e) || /^dict\(/.test(e) || /^array\s*\(/.test(e))
    return lang === 'php' ? 'array' : lang === 'python' ? 'dict' : 'object';
  if (/^new\s+/.test(e)) {
    const m = /^new\s+\\?([\w\\]+)/.exec(e);
    return m?.[1] ?? null;
  }
  // bare identifier / call — unknown, do not guess
  return null;
}

const NUMERIC = /^(int|integer|float|double|number|real)\b/i;

/** Structural compatibility check between stub type and declared type. */
export function typesCompatible(
  stub: string,
  declared: string,
  lang: string,
): boolean {
  const s = stub.trim();
  const d = declared.trim();

  // unknown / dynamic stub values → assume compatible
  if (isUntypedSide(s)) return true;

  // Promise/await handling: mockResolvedValue implies Promise<T> on the stub side
  const dInner = /^Promise<(.+)>$/.exec(d);
  if (dInner?.[1] && !/^Promise<</.test(s)) {
    return typesCompatible(s, dInner[1], lang);
  }
  const sPromise = /^Promise<(.+)>$/.exec(s);
  if (sPromise?.[1] && !/^Promise<</.test(d)) {
    return typesCompatible(sPromise[1], d, lang);
  }

  // null into nullable declared type
  if (s === 'null' || s === 'None' || s === 'nil') {
    return /\?|null\b|Optional|Option<|\|none/i.test(d);
  }

  // undefined into void/optional declared types
  if (s === 'undefined' && /^(void|undefined|unknown|any|mixed)$/i.test(d)) {
    return true;
  }

  // exact / case-insensitive match
  if (s.toLowerCase() === d.toLowerCase()) return true;

  // numeric widening: int into float-ish declared types
  if (NUMERIC.test(s) && NUMERIC.test(d)) return true;

  // mixed / any / object-ish declared types accept anything
  if (/^(mixed|any|object|stdclass|array|dict|mapping|unknown)\b/i.test(d)) return true;
  if (/^(int|integer|float|double|number)\b/i.test(d) && /^-?\d/.test(s)) return true;
  if (/^(string|str)\b/i.test(d) && /^(['"])/.test(s)) return true;
  if (/^(bool|boolean)\b/i.test(d) && /^(true|false|True|False)$/.test(s)) return true;

  // class instance stub `new Foo()` into declared Foo-ish type
  if (/^new\s+\\?([\w\\]+)/.test(s)) {
    const cls = (/^new\s+\\?([\w\\]+)/.exec(s))?.[1] ?? '';
    return cls.toLowerCase() === d.toLowerCase() ||
      d.toLowerCase().endsWith('\\' + cls.toLowerCase()) ||
      cls.toLowerCase().endsWith('\\' + d.toLowerCase());
  }

  // array-like declared types accept literal arrays
  if (/^(array|dict|list|object|record)\b/i.test(d) && /^(\[|\{|array\s*\(|dict\()/.test(s)) return true;

  // nominal match ignoring namespaces
  const sShort = s.split(/\\|\./).pop() ?? s;
  const dShort = d.split(/\\|\./).pop() ?? d;
  if (sShort.toLowerCase() === dShort.toLowerCase()) return true;

  return false;
}

/** Apply strictness filter to a finding. */
export function passesStrictness(
  f: Finding,
  strictness: 'all' | 'untyped_only' | 'breaking_only',
): boolean {
  if (strictness === 'all') return true;
  if (strictness === 'breaking_only') return f.confidence === 'definite';
  // untyped_only: findings where either side lacks type info
  return f.message.includes("returns ''") || f.confidence === 'warning';
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
  deduped.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.type.localeCompare(b.type),
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
