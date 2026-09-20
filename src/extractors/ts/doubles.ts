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
  accessType?: string | null;
  fakeArity?: number | null;
  fakeParamTypes?: (string | null)[];
  returnsSelf?: boolean;
  staticReceiver?: boolean | undefined;
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
  moduleVars: Map<string, string>,
): {
  target: string | null;
  method: string | null;
  accessType: string | null;
  staticReceiver?: boolean | undefined;
} {
  const args = field(spyCall, 'arguments');
  if (!args) return { target: null, method: null, accessType: null };
  const children = args.namedChildren;
  const first = children[0];
  if (!first) return { target: null, method: null, accessType: null };
  let target: string | null = null;
  // Whether the spy was pointed at the class itself or at an instance of it.
  // Left undefined where neither is clear, such as `this.svc` or `a.b.c`.
  let staticReceiver: boolean | undefined;
  if (first.type === 'identifier') {
    // A tracked variable names its type; anything else is taken at face value,
    // which is how `vi.spyOn(Svc, 'build')` reaches the class's static member.
    // An identifier that names nothing in the graph simply fails to resolve.
    // Both maps come from one flat, scope-blind walk of the file, so a local
    // binding that shadows a module import appears in both. `varTypes` wins:
    // that is the behaviour this tool has always had, and it confines the new
    // module capability to identifiers with no competing local binding.
    const known = varTypes.get(first.text);
    const asModule = moduleVars.get(first.text);
    if (known !== undefined) {
      target = known;
      staticReceiver = false;
    } else if (asModule) {
      target = asModule;
      staticReceiver = undefined; // a module has no instance side
    } else {
      target = first.text;
      staticReceiver = true;
    }
  } else if (first.type === 'member_expression' || first.type === 'this') {
    target = first.text;
    // `Klass.prototype` is the instance side of the class, and the usual way
    // to spy on an instance method without having an instance. Left as-is it
    // resolved to nothing, so none of these doubles were checked at all.
    const proto = /^(.*)\.prototype$/.exec(first.text);
    if (proto?.[1]) {
      target = proto[1];
      staticReceiver = false;
    }
  } else if (first.type === 'new_expression') {
    target = initTypeName(first);
    staticReceiver = false;
  }
  const second = children[1];
  const method = second ? unquote(second.text) : null;
  // `vi.spyOn(obj, 'x', 'get')` replaces the accessor rather than a method.
  const third = children[2];
  const accessType = third ? unquote(third.text) : null;
  return { target, method, accessType, staticReceiver };
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

const RETURN_SETTERS =
  /^mock(ResolvedValue|ReturnValue|RejectedValue|ResolvedValueOnce|ReturnValueOnce|RejectedValueOnce)$/;
const ARITY_ASSERTIONS = /^(toHaveBeenCalledWith|toBeCalledWith)$/;
const IMPLEMENTATIONS = /^mockImplementation(Once)?$/;

/**
 * The parameter list a replacement function declares, when it declares one
 * literally. A reference to a function defined elsewhere, or a rest
 * parameter, means the arity is not decidable here and the answer is null.
 */
function fakeSignature(
  fn: SyntaxNode | undefined,
): { arity: number; types: (string | null)[]; body: SyntaxNode | null } | null {
  if (!fn) return null;
  if (fn.type !== 'arrow_function' && fn.type !== 'function_expression') return null;
  const body = field(fn, 'body');
  // `x => x`, an arrow with one unparenthesised parameter.
  const single = field(fn, 'parameter');
  if (single) return { arity: 1, types: [null], body };
  const params = field(fn, 'parameters');
  if (!params) return null;
  const declared = params.namedChildren.filter((c) => c.type !== 'comment');
  if (declared.some((c) => c.type === 'rest_pattern' || c.text.startsWith('...'))) return null;
  // What each parameter says it takes, where it says anything at all.
  const types = declared.map((p) => {
    const annotation = field(p, 'type');
    return annotation ? annotation.text.replace(/^:\s*/, '').trim() : null;
  });
  return { arity: declared.length, types, body };
}

/**
 * The keys a `vi.mock` factory supplies, when it supplies an object literal
 * and nothing else. A factory that spreads `importOriginal()`, computes a key,
 * or returns anything but a literal is not a list of names.
 */
function factoryKeys(
  factory: SyntaxNode | undefined,
): Array<{ name: string; line: number; value: SyntaxNode | undefined }> | null {
  if (!factory) return null;
  if (factory.type !== 'arrow_function' && factory.type !== 'function_expression') return null;
  let body = field(factory, 'body');
  if (body?.type === 'statement_block') {
    const ret = body.namedChildren.find((c) => c.type === 'return_statement');
    body = ret?.namedChildren[0] ?? null;
  }
  while (body?.type === 'parenthesized_expression') body = body.namedChildren[0] ?? null;
  if (body?.type === 'await_expression') return null;
  if (!body || body.type !== 'object') return null;
  const keys: Array<{ name: string; line: number; value: SyntaxNode | undefined }> = [];
  for (const property of body.namedChildren) {
    if (property.type === 'spread_element') return null; // the rest came from elsewhere
    if (property.type === 'comment') continue;
    const key = field(property, 'key');
    if (!key) return null;
    if (key.type === 'computed_property_name') return null;
    keys.push({
      name: key.type === 'string' ? unquote(key.text) : key.text,
      line: property.startPosition.row + 1,
      value: field(property, 'value') ?? undefined,
    });
  }
  return keys;
}

/**
 * What a factory value says about the member it stands in for.
 *
 * `vi.fn(impl)` states a signature; `.mockReturnValue(x)` and friends pin a
 * return. A plain object, a bare `vi.fn()`, or anything that never bottoms
 * out at `vi.fn`/`jest.fn` states nothing, and null keeps it out of the
 * double list rather than producing an empty double.
 */
function stubShapeOf(value: SyntaxNode | undefined): {
  fakeArity: number | null;
  fakeParamTypes?: (string | null)[];
  returnExpr: string | null;
  returnTypeHint: string | null;
  resolvedReturn?: boolean;
} | null {
  if (!value) return null;
  let node: SyntaxNode | null = value;
  let returnExpr: string | null = null;
  let returnTypeHint: string | null = null;
  let resolvedReturn = false;
  let impl: SyntaxNode | undefined;
  let foundFn = false;

  // Unwrap the chain: vi.fn(impl).mockReturnValue(1). The walk stops at the
  // innermost link, `vi.fn`/`jest.fn` itself: that call's own argument is the
  // implementation, not another link to walk through, so it is taken here
  // rather than being descended past on the way to the `vi`/`jest` identifier.
  for (let i = 0; i < 8 && node?.type === 'call_expression' && !foundFn; i++) {
    const call = memberCall(node);
    if (!call) break;
    const args = call.argsNode?.namedChildren ?? [];
    if (call.property === 'fn' && apiRoot(call)) {
      impl = args[0];
      foundFn = true;
      break;
    }
    if (RETURN_SETTERS.test(call.property)) {
      if (call.property.startsWith('mockRejectedValue')) resolvedReturn = true;
      else if (call.property.startsWith('mockResolvedValue')) {
        resolvedReturn = true;
        returnExpr = args[0]?.text ?? null;
        returnTypeHint = literalType(returnExpr ?? '');
      } else {
        returnExpr = args[0]?.text ?? null;
        returnTypeHint = literalType(returnExpr ?? '');
      }
    }
    node = field(call.fn, 'object');
  }

  // The chain never bottomed out at `vi.fn`/`jest.fn`: nothing here states a
  // signature or a return, so it is not a stub this check can read.
  if (!foundFn) return null;

  const sig = fakeSignature(impl);
  if (sig) {
    const body = sig.body;
    if (body && body.type !== 'statement_block' && returnExpr === null) {
      returnExpr = body.text;
      returnTypeHint = literalType(body.text);
    }
  }
  if (!sig && returnExpr === null && !resolvedReturn) return null;

  return {
    fakeArity: sig ? sig.arity : null,
    ...(sig ? { fakeParamTypes: sig.types } : {}),
    returnExpr,
    returnTypeHint,
    ...(resolvedReturn ? { resolvedReturn: true } : {}),
  };
}

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

  // Pass 1b: identifiers bound to a whole module. `varTypes` only tracks
  // `new X()`, so `import * as db` and `const db = require(...)` named nothing
  // and every double through them resolved to a class called `db`.
  const moduleVars = new Map<string, string>();
  for (const { node } of walk(root)) {
    if (node.type === 'import_statement') {
      const from = node.namedChildren.find((c) => c.type === 'string');
      const clause = node.namedChildren.find((c) => c.type === 'import_clause');
      if (!from || !clause) continue;
      const specifier = unquote(from.text);
      for (const part of clause.namedChildren) {
        if (part.type === 'namespace_import') {
          const alias = part.namedChildren.find((c) => c.type === 'identifier');
          if (alias) moduleVars.set(alias.text, specifier);
        } else if (part.type === 'identifier') {
          moduleVars.set(part.text, specifier);
        }
      }
      continue;
    }
    if (node.type !== 'variable_declarator') continue;
    const name = field(node, 'name');
    const value = field(node, 'value');
    if (name?.type !== 'identifier' || value?.type !== 'call_expression') continue;
    if (field(value, 'function')?.text !== 'require') continue;
    const arg = field(value, 'arguments')?.namedChildren[0];
    if (arg?.type === 'string') moduleVars.set(name.text, unquote(arg.text));
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
    const { target, method, accessType, staticReceiver } = spyTargetOf(node, varTypes, moduleVars);
    const rec: SpyRecord = {
      framework: `${rootName}.spyOn`,
      target,
      method,
      accessType,
      staticReceiver,
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
    const isSelf = call.property === 'mockReturnThis';
    const isArity = ARITY_ASSERTIONS.test(call.property);
    const isFake = IMPLEMENTATIONS.test(call.property);
    if (!isSetter && !isArity && !isFake && !isSelf) continue;

    const obj = field(call.fn, 'object');
    const byVar = obj?.type === 'identifier' ? spyVars.get(obj.text) : undefined;
    const rec =
      byVar ??
      findOwningSpy(node, byCall, spyVars) ??
      adoptTypedMember(node, varTypes, moduleVars, spies);
    if (!rec) continue;

    if (isSelf) {
      // `mockReturnThis()` asserts the method is fluent, the same claim
      // `willReturnSelf()` makes on the PHP side.
      rec.returnsSelf = true;
    } else if (isFake) {
      // A replacement function states, in code, what the test believes the
      // signature to be. Parameters it declares beyond the real ones are
      // always undefined, and the body's value stands in for the return.
      const sig = fakeSignature(call.argsNode?.namedChildren[0]);
      if (!sig) continue;
      rec.fakeArity = sig.arity;
      rec.fakeParamTypes = sig.types;
      const body = sig.body;
      // Only a concise body is a return value; a block needs following.
      if (body && body.type !== 'statement_block' && rec.returnExpr === null) {
        rec.returnExpr = body.text;
        rec.returnTypeHint = literalType(body.text);
      }
    } else if (isSetter) {
      const expr = call.argsNode?.namedChildren[0]?.text ?? null;
      const dt = declaredTypeOf(node);
      if (call.property.startsWith('mockRejectedValue')) {
        // The argument is the rejection reason, not a return value, but
        // rejecting still asserts the method hands back a promise.
        rec.resolvedReturn = true;
      } else if (call.property.startsWith('mockResolvedValue')) {
        rec.returnExpr = expr;
        rec.returnTypeHint = dt; // Promise<T> handled by the analyzer
        rec.resolvedReturn = true;
      } else {
        rec.returnExpr = expr;
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

  // `vi.mock('../src/api', () => ({ getUser: vi.fn() }))` replaces a module
  // wholesale. The keys are what the test believes the module exports, and a
  // key that is no longer exported is configuration nobody will ever reach.
  for (const { node } of walk(root)) {
    if (node.type !== 'call_expression') continue;
    const call = memberCall(node);
    if (!call || !/^(mock|doMock)$/.test(call.property)) continue;
    if (!apiRoot(call)) continue;
    const args = call.argsNode?.namedChildren ?? [];
    const specifierNode = args[0];
    if (!specifierNode || specifierNode.type !== 'string') continue;
    const specifier = unquote(specifierNode.text);
    if (!specifier.startsWith('.')) continue;
    const keys = factoryKeys(args[1]);
    if (!keys) continue;
    doubles.push({
      framework: `${apiRoot(call)}.mock`,
      language,
      file: relFile,
      line: node.startPosition.row + 1,
      targetSymbol: specifier,
      moduleSpecifier: specifier,
      method: null,
      methods: keys.map(({ name, line }) => ({ name, line })),
      withArity: null,
      assertedArity: null,
      returnTypeHint: null,
      returnExpr: null,
      confidence: 'definite',
    });

    // A factory value is a stub in its own right, not just a name. Where it
    // states a signature or pins a return, it earns its own double so the
    // existing member checks (arity, parameter types, return type) can reach
    // it the same way they reach a `spyOn`.
    for (const key of keys) {
      const stub = stubShapeOf(key.value);
      if (!stub) continue;
      doubles.push({
        framework: `${apiRoot(call)}.mock`,
        language,
        file: relFile,
        line: key.line,
        targetSymbol: specifier,
        method: key.name,
        methods: [{ name: key.name, line: key.line }],
        withArity: null,
        assertedArity: null,
        ...(stub.fakeArity !== null ? { fakeArity: stub.fakeArity } : {}),
        ...(stub.fakeParamTypes ? { fakeParamTypes: stub.fakeParamTypes } : {}),
        ...(stub.resolvedReturn ? { resolvedReturn: true } : {}),
        returnTypeHint: stub.returnTypeHint,
        returnExpr: stub.returnExpr,
        confidence: 'definite',
      });
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
      ...(rec.fakeArity !== null && rec.fakeArity !== undefined
        ? { fakeArity: rec.fakeArity }
        : {}),
      ...(rec.fakeParamTypes ? { fakeParamTypes: rec.fakeParamTypes } : {}),
      returnTypeHint: rec.returnTypeHint,
      returnExpr: rec.returnExpr,
      ...(rec.resolvedReturn ? { resolvedReturn: true } : {}),
      ...(rec.accessType ? { accessType: rec.accessType } : {}),
      ...(rec.returnsSelf ? { returnsSelf: true } : {}),
      ...(rec.staticReceiver !== undefined ? { staticReceiver: rec.staticReceiver } : {}),
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
  moduleVars: Map<string, string>,
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

  // A module binding names a module; a tracked constructor names a class.
  // Only the first of these existed, so `vi.mocked(db.query)` found nothing.
  // Both maps come from one flat, scope-blind walk, so a local binding that
  // shadows a module import appears in both; `varTypes` wins, matching the
  // precedence in spyTargetOf and the behaviour this tool had before modules
  // were tracked at all.
  const known = varTypes.get(base.text);
  const asModule = known === undefined ? moduleVars.get(base.text) : undefined;
  const target = known ?? asModule;
  if (!target) return null;

  const rec: SpyRecord = {
    framework: asModule ? 'module member' : 'typed member',
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
