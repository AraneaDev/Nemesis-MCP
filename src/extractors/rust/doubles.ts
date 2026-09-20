// ---------------------------------------------------------------------------
// mockall / mockiato double extractor (experimental tier).
// ---------------------------------------------------------------------------

import type { TestDouble, ScanDiagnostic } from '../../core/types.js';
import { parseSource, report } from '../../parser/loader.js';
import { walk, field } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

export async function extractRustDoubles(
  relFile: string,
  source: string,
  diagnostics?: ScanDiagnostic[],
): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  const parsed = await parseSource('rust', source, undefined, report(relFile, 'rust', diagnostics));
  const { root } = parsed;

  // `MockFoo::new()` bound to a variable, so `m.expect_bar()` can be traced
  // back to the trait `Foo`.
  const mockVars = new Map<string, string>();
  for (const { node } of walk(root)) {
    if (node.type !== 'let_declaration') continue;
    const name = letBindingName(node);
    const trait = mockConstructorTrait(field(node, 'value'));
    if (name && trait) mockVars.set(name, trait);
  }

  for (const { node } of walk(root)) {
    // `m.expect_bar()` / `MockFoo::new().expect_bar()`. This is how mockall is
    // used when the trait lives in production code, which is the only case
    // where the mock and the trait can actually drift apart. Matching only
    // `#[automock]` declared inside the test file checked a trait against
    // itself and could never report anything.
    const expectation = expectCall(node, mockVars);
    if (expectation) {
      doubles.push({
        framework: 'mockall',
        language: 'rust',
        file: relFile,
        line: node.startPosition.row + 1,
        targetSymbol: expectation.trait,
        method: expectation.method,
        methods: [{ name: expectation.method, line: node.startPosition.row + 1 }],
        withArity: expectation.withArity,
        assertedArity: null,
        returnTypeHint: null,
        returnExpr: expectation.returnExpr,
        confidence: 'definite',
      });
      continue;
    }

    // #[automock] on a trait: the trait itself is the contract; Mockall
    // generates the double, so we record the trait as a double target with no
    // drift surface of its own — useful for `verify_symbol` listings.
    if (node.type === 'attribute_item') {
      const attr = node.namedChildren[0];
      if (attr?.text.replace(/^#\[|\]$/g, '').trim() === 'automock') {
        const next = nextSiblingTrait(node);
        if (next) {
          const name = field(next, 'name')?.text;
          if (name) {
            const methods = next.namedChildren
              .filter(
                (child) =>
                  child.type === 'function_signature_item' || child.type === 'function_item',
              )
              .map((child) => field(child, 'name')?.text)
              .filter((method): method is string => Boolean(method))
              .map((method) => ({ name: method, line: next.startPosition.row + 1 }));
            doubles.push({
              framework: 'mockall #[automock]',
              language: 'rust',
              file: relFile,
              line: node.startPosition.row + 1,
              targetSymbol: name,
              method: methods[0]?.name ?? null,
              methods,
              withArity: null,
              assertedArity: null,
              returnTypeHint: null,
              returnExpr: null,
              confidence: 'definite',
            });
          }
        }
      }
      continue;
    }

    // mock! { ... } blocks: the macro content redeclares a trait shape.
    if (node.type === 'macro_invocation') {
      const macro = field(node, 'macro');
      if (macro?.text === 'mock') {
        const target = mockTarget(node);
        // The escape was doubled, so this matched a literal `\b` and every
        // `mock!` block came back with no methods at all.
        const methods = [...node.text.matchAll(/\bfn\s+(\w+)/g)]
          .map((match) => ({
            name: match[1] ?? '',
            line: node.startPosition.row + 1,
          }))
          .filter((method) => method.name.length > 0);
        doubles.push({
          framework: 'mockall mock!',
          language: 'rust',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: target,
          method: methods[0]?.name ?? null,
          methods,
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: target ? 'definite' : 'warning',
        });
      }
    }
  }

  return doubles;
}

/** Variable name bound by a `let`, ignoring `mut` and type annotations. */
function letBindingName(node: SyntaxNode): string | null {
  const pattern = field(node, 'pattern');
  if (!pattern) return null;
  const text = pattern.text.replace(/^mut\s+/, '').trim();
  return /^[A-Za-z_]\w*$/.test(text) ? text : null;
}

/** `MockFoo::new()` / `MockFoo::default()` → the trait name `Foo`. */
function mockConstructorTrait(value: SyntaxNode | null): string | null {
  if (!value) return null;
  const match = /^Mock([A-Za-z_]\w*)\s*::\s*(new|default)\s*\(/.exec(value.text.trim());
  return match?.[1] ?? null;
}

interface Expectation {
  trait: string;
  method: string;
  withArity: number | null;
  returnExpr: string | null;
}

/**
 * An `expect_<method>()` call on a known mock. mockall names the generated
 * setter after the trait method, so the suffix is the contract being stubbed.
 */
function expectCall(node: SyntaxNode, mockVars: Map<string, string>): Expectation | null {
  if (node.type !== 'call_expression') return null;
  const fn = field(node, 'function');
  if (fn?.type !== 'field_expression') return null;
  const fieldName = field(fn, 'field')?.text ?? '';
  if (!fieldName.startsWith('expect_')) return null;
  const method = fieldName.slice('expect_'.length);
  if (!method) return null;

  const receiver = field(fn, 'value');
  if (!receiver) return null;
  const trait =
    (receiver.type === 'identifier' ? mockVars.get(receiver.text) : undefined) ??
    mockConstructorTrait(receiver);
  if (!trait) return null;

  return {
    trait,
    method,
    withArity: withArityOf(node),
    returnExpr: returnValueOf(node),
  };
}

/**
 * The value a mockall expectation is configured to return.
 *
 * `return_const(v)` takes the value directly; `returning(|..| body)` takes a
 * closure whose body is the value. Without this the Rust tier could report a
 * ghost method or a bad arity but never a return type mismatch, because no
 * return expression ever reached the analyzer.
 */
function returnValueOf(expectNode: SyntaxNode): string | null {
  let current: SyntaxNode | null = expectNode;
  for (let hops = 0; hops < 8 && current; hops++) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === 'field_expression') {
      const fieldName = field(parent, 'field')?.text ?? '';
      const call: SyntaxNode | null = parent.parent;
      if (call?.type === 'call_expression') {
        const args = field(call, 'arguments');
        const first = args?.namedChildren[0];
        if (fieldName === 'return_const' && first) {
          return stripNumericSuffix(first.text);
        }
        if ((fieldName === 'returning' || fieldName === 'return_once') && first) {
          const body = first.type === 'closure_expression' ? field(first, 'body') : null;
          if (body) return stripNumericSuffix(body.text);
        }
      }
      current = call ?? parent;
      continue;
    }
    current = parent;
  }
  return null;
}

/** `42u64` and `1.5f32` are the same literals as `42` and `1.5`. */
function stripNumericSuffix(text: string): string {
  const t = text.trim();
  return /^-?\d+(\.\d+)?(_?[iuf](8|16|32|64|128|size))$/.test(t)
    ? t.replace(/_?[iuf](8|16|32|64|128|size)$/, '')
    : t;
}

/**
 * mockall's `.with(...)` takes one predicate per parameter, so its argument
 * count is the arity the test asserts the method has.
 */
function withArityOf(expectNode: SyntaxNode): number | null {
  let current: SyntaxNode | null = expectNode;
  for (let hops = 0; hops < 8 && current; hops++) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) return null;
    if (parent.type === 'field_expression') {
      const fieldName = field(parent, 'field')?.text ?? '';
      const call: SyntaxNode | null = parent.parent;
      if (fieldName === 'with' && call?.type === 'call_expression') {
        const args = field(call, 'arguments');
        return args ? args.namedChildren.length : null;
      }
      current = call ?? parent;
      continue;
    }
    current = parent;
  }
  return null;
}

function nextSiblingTrait(attr: SyntaxNode): SyntaxNode | null {
  const sibs = attr.parent?.namedChildren ?? [];
  const idx = sibs.findIndex((s) => s.id === attr.id);
  for (let i = idx + 1; i < sibs.length; i++) {
    const s = sibs[i];
    if (!s) continue;
    if (s.type === 'attribute_item' || s.type === 'line_comment' || s.type === 'comment') continue;
    return s.type === 'trait_item' ? s : null;
  }
  return null;
}

/** `mock! { Foo { ... } }` or `mock! { Trait for Struct { ... } }` → name. */
function mockTarget(macroNode: SyntaxNode): string | null {
  const body = field(macroNode, 'body');
  const tokenTree = body ?? macroNode.namedChildren.find((c) => c.type === 'token_tree');
  const first = tokenTree?.namedChildren[0];
  if (!first) return null;
  if (first.type === 'struct_item' || first.type === 'trait_item') {
    return field(first, 'name')?.text ?? null;
  }
  if (first.type === 'identifier' || first.type === 'type_identifier') {
    return first.text;
  }
  return null;
}
