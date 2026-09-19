// ---------------------------------------------------------------------------
// Vitest / Jest double extractor (TS + JS), with variable type tracking.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type { TestDouble } from '../../core/types.js';
import { parseSource } from '../../parser/loader.js';
import { walk, field, unquote } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

interface SpyRecord {
  framework: string;
  target: string | null;
  method: string | null;
  line: number;
  returnTypeHint: string | null;
  returnExpr: string | null;
  assertedArity: number | null;
  assertedArgs?: string[];
  resolvedReturn?: boolean;
}

function memberCall(
  node: SyntaxNode,
): { fn: SyntaxNode; property: string; argsNode: SyntaxNode | null } | null {
  if (node.type !== 'call_expression') return null;
  const fn = field(node, 'function');
  if (!fn || fn.type !== 'member_expression') return null;
  const prop = field(fn, 'property');
  if (!prop) return null;
  return { fn, property: prop.text, argsNode: field(node, 'arguments') };
}

/** API namespace for a member call: `vi`, `jest`, or null. */
function apiRoot(call: { fn: SyntaxNode }): string | null {
  const obj = field(call.fn, 'object');
  if (!obj) return null;
  const text = obj.text;
  return /^(vi|jest)$/.test(text) ? text : null;
}

/** Declared type from an initializer expression: `new Foo()`, `as Foo`, … */
function initTypeName(init: SyntaxNode): string | null {
  let cur: SyntaxNode = init;
  for (let i = 0; i < 4; i++) {
    if (cur.type === 'as_expression' || cur.type === 'assertion_expression') {
      const inner = cur.namedChildren[0];
      const t = field(cur, 'type')?.text ?? null;
      if (t && (!inner || inner.type !== 'new_expression')) return t;
      cur = inner ?? cur;
      continue;
    }
    if (cur.type === 'non_null_expression' || cur.type === 'satisfies_expression') {
      const inner = cur.namedChildren[0];
      if (!inner) return null;
      cur = inner;
      continue;
    }
    break;
  }
  if (cur.type === 'new_expression') {
    const ctor = field(cur, 'constructor');
    if (ctor) return ctor.text;
  }
  return null;
}

/** Extract the production symbol a spy points to via the spy target arguments. */
function spyTargetOf(
  spyCall: SyntaxNode,
  varTypes: Map<string, string>,
): { target: string | null; method: string | null } {
  const args = field(spyCall, 'arguments');
  if (!args) return { target: null, method: null };
  const children = args.namedChildren;
  const first = children[0];
  if (!first) return { target: null, method: null };
  let target: string | null = null;
  if (first.type === 'identifier') {
    // A tracked variable names its type; anything else is taken at face value,
    // which is how `vi.spyOn(Svc, 'build')` reaches the class's static member.
    // An identifier that names nothing in the graph simply fails to resolve.
    target = varTypes.get(first.text) ?? first.text;
  } else if (first.type === 'member_expression' || first.type === 'this') {
    target = first.text;
  } else if (first.type === 'new_expression') {
    target = initTypeName(first);
  }
  const second = children[1];
  const method = second ? unquote(second.text) : null;
  return { target, method };
}

/** Declared type from `as Foo` / `: Foo` around `node` (walks outward). */
function declaredTypeOf(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    const parent: SyntaxNode | null = cur.parent;
    if (!parent) break;
    if (parent.type === 'as_expression' || parent.type === 'assertion_expression') {
      const inner = parent.namedChildren[0];
      if (inner?.id === cur.id) {
        const t = field(parent, 'type');
        if (t) return t.text;
      }
    }
    if (parent.type === 'type_annotation') {
      return parent.text.replace(/^:\s*/, '').trim();
    }
    cur = parent;
  }
  return null;
}

function literalType(expr: string | null): string | null {
  if (expr === null) return null;
  const t = expr.trim();
  if (/^["'`]/.test(t)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'bool';
  if (/^null$/.test(t)) return 'null';
  if (/^undefined$/.test(t)) return 'undefined';
  return null;
}

const RETURN_SETTERS = /^mock(ResolvedValue|ReturnValue|ResolvedValueOnce|ReturnValueOnce)$/;
const ARITY_ASSERTIONS = /^(toHaveBeenCalledWith|toBeCalledWith)$/;

export interface TsDoublesResult {
  doubles: TestDouble[];
}

export async function extractTsDoubles(
  relFile: string,
  source: string,
  language: 'typescript' | 'javascript',
): Promise<TsDoublesResult> {
  const doubles: TestDouble[] = [];
  const ext = path.extname(relFile);
  const grammar = ext === '.tsx' ? 'tsx' : language === 'javascript' ? 'javascript' : 'typescript';
  const parsed = await parseSource(language, source, grammar);
  const { root } = parsed;

  // Pass 1: variable declared types (`const service = new UserService()`).
  const varTypes = new Map<string, string>();
  for (const { node } of walk(root)) {
    if (node.type !== 'variable_declarator') continue;
    const name = field(node, 'name');
    const value = field(node, 'value');
    if (!name || !value) continue;
    const t = initTypeName(value);
    if (t) varTypes.set(name.text, t);
  }

  // Pass 2: spy creations (`vi.spyOn(...)`, possibly assigned to a variable).
  const spies: SpyRecord[] = [];
  const byCall = new Map<number, SpyRecord>();
  const spyVars = new Map<string, SpyRecord>();

  for (const { node } of walk(root)) {
    if (node.type !== 'call_expression') continue;
    const call = memberCall(node);
    if (!call || call.property !== 'spyOn') continue;
    const rootName = apiRoot(call);
    if (!rootName) continue;
    const { target, method } = spyTargetOf(node, varTypes);
    const rec: SpyRecord = {
      framework: `${rootName}.spyOn`,
      target,
      method,
      line: node.startPosition.row + 1,
      returnTypeHint: null,
      returnExpr: null,
      assertedArity: null,
    };
    spies.push(rec);
    byCall.set(node.id, rec);
    // Track `const s = vi.spyOn(...)` so later `s.mockX()` calls attach.
    const p = node.parent;
    if (p?.type === 'variable_declarator') {
      const nameNode = field(p, 'name');
      if (nameNode) spyVars.set(nameNode.text, rec);
    } else if (p?.type === 'assignment_expression') {
      const nameNode = field(p, 'left');
      if (nameNode) spyVars.set(nameNode.text, rec);
    }
  }

  // Pass 3: setters and assertions, attached by chain or by spy variable.
  for (const { node } of walk(root)) {
    if (node.type !== 'call_expression') continue;
    const call = memberCall(node);
    if (!call) continue;

    const isSetter = RETURN_SETTERS.test(call.property);
    const isArity = ARITY_ASSERTIONS.test(call.property);
    if (!isSetter && !isArity) continue;

    const obj = field(call.fn, 'object');
    const byVar = obj?.type === 'identifier' ? spyVars.get(obj.text) : undefined;
    const rec =
      byVar ?? findOwningSpy(node, byCall, spyVars) ?? adoptTypedMember(node, varTypes, spies);
    if (!rec) continue;

    if (isSetter) {
      const expr = call.argsNode?.namedChildren[0]?.text ?? null;
      const dt = declaredTypeOf(node);
      rec.returnExpr = expr;
      if (call.property.startsWith('mockResolvedValue')) {
        rec.returnTypeHint = dt; // Promise<T> handled by the analyzer
        rec.resolvedReturn = true;
      } else {
        rec.returnTypeHint = dt ?? literalType(expr);
      }
    } else {
      if (call.property === 'toHaveBeenCalledWith' || call.property === 'toBeCalledWith') {
        rec.assertedArity = call.argsNode?.namedChildCount ?? 0;
        rec.assertedArgs = (call.argsNode?.namedChildren ?? []).map((a) => a.text);
      } else {
        const n = call.argsNode?.namedChildren[0];
        if (n && /^\d+$/.test(n.text)) rec.assertedArity = parseInt(n.text, 10);
      }
    }
  }

  for (const rec of spies) {
    doubles.push({
      framework: rec.framework,
      language,
      file: relFile,
      line: rec.line,
      targetSymbol: rec.target,
      method: rec.method,
      methods: rec.method ? [{ name: rec.method, line: rec.line }] : [],
      withArity: null,
      ...(rec.assertedArgs ? { withArgs: rec.assertedArgs } : {}),
      assertedArity: rec.assertedArity,
      returnTypeHint: rec.returnTypeHint,
      returnExpr: rec.returnExpr,
      ...(rec.resolvedReturn ? { resolvedReturn: true } : {}),
      confidence: rec.target ? 'definite' : 'warning',
    });
  }

  return { doubles };
}

/**
 * Configure or assert on `receiver.method` where `receiver` has a known type
 * but no `spyOn` was recorded, as in `expect(svc.load).toHaveBeenCalledWith(1)`
 * or `vi.mocked(svc.load).mockReturnValue(1)`. Both are documented patterns
 * that produced no double at all, because the chain walk only ever looked for
 * a spy it had already seen.
 */
function adoptTypedMember(
  node: SyntaxNode,
  varTypes: Map<string, string>,
  spies: SpyRecord[],
): SpyRecord | null {
  const fn = field(node, 'function');
  if (fn?.type !== 'member_expression') return null;

  // Only the direct receiver of the setter counts. Descending further finds
  // the wrong member: in `controller.currentAction.getLoop.mockReturnValue(x)`
  // the configured member is `getLoop` on whatever `currentAction` holds, not
  // `currentAction` on the controller.
  let receiver: SyntaxNode | null = field(fn, 'object');
  for (let i = 0; i < 8 && receiver; i++) {
    if (
      receiver.type === 'parenthesized_expression' ||
      receiver.type === 'as_expression' ||
      receiver.type === 'assertion_expression' ||
      receiver.type === 'await_expression' ||
      receiver.type === 'non_null_expression'
    ) {
      receiver = receiver.namedChildren[0] ?? null;
      continue;
    }
    if (receiver.type === 'call_expression') {
      const text = field(receiver, 'function')?.text ?? '';
      if (text === 'expect' || /^(vi|jest)\.mocked$/.test(text)) {
        receiver = field(receiver, 'arguments')?.namedChildren[0] ?? null;
        continue;
      }
      return null;
    }
    break;
  }

  if (receiver?.type !== 'member_expression') return null;
  const base = field(receiver, 'object');
  const property = field(receiver, 'property')?.text;
  if (base?.type !== 'identifier' || !property) return null;

  const target = varTypes.get(base.text);
  if (!target) return null;

  const rec: SpyRecord = {
    framework: 'typed member',
    target,
    method: property,
    line: receiver.startPosition.row + 1,
    returnTypeHint: null,
    returnExpr: null,
    assertedArity: null,
  };
  spies.push(rec);
  return rec;
}

/** Walk the member chain under `node` to find a spy we recorded. */
function findOwningSpy(
  node: SyntaxNode,
  byCall: Map<number, SpyRecord>,
  spyVars: Map<string, SpyRecord>,
): SpyRecord | null {
  let cur: SyntaxNode | null = node;
  for (let i = 0; i < 32 && cur; i++) {
    if (
      cur.type === 'parenthesized_expression' ||
      cur.type === 'as_expression' ||
      cur.type === 'assertion_expression' ||
      cur.type === 'await_expression' ||
      cur.type === 'non_null_expression'
    ) {
      // Unwrap `(spy as any)`, `(spy)`, `await spy`, `spy!`
      cur = cur.namedChildren[0] ?? null;
      continue;
    }
    if (cur.type === 'call_expression') {
      const fnText = field(cur, 'function')?.text ?? '';
      // `expect(spy)` and `vi.mocked(fn)` both wrap the thing being configured.
      if (fnText === 'expect' || /^(vi|jest)\.mocked$/.test(fnText)) {
        cur = field(cur, 'arguments')?.namedChildren[0] ?? null;
        continue;
      }
      const hit = byCall.get(cur.id);
      if (hit) return hit;
      cur = field(cur, 'function');
      continue;
    }
    if (cur.type === 'member_expression') {
      cur = field(cur, 'object');
      continue;
    }
    if (cur.type === 'identifier') {
      return spyVars.get(cur.text) ?? null;
    }
    break;
  }
  return null;
}
