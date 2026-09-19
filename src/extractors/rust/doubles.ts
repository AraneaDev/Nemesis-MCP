// ---------------------------------------------------------------------------
// mockall / mockiato double extractor (experimental tier).
// ---------------------------------------------------------------------------

import type { TestDouble } from '../../core/types.js';
import { parseSource } from '../../parser/loader.js';
import { walk, field } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

export async function extractRustDoubles(
  relFile: string,
  source: string,
): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  let parsed;
  try {
    parsed = await parseSource('rust', source);
  } catch {
    return doubles;
  }
  const { root } = parsed;

  for (const { node } of walk(root)) {
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
            doubles.push({
              framework: 'mockall #[automock]',
              language: 'rust',
              file: relFile,
              line: node.startPosition.row + 1,
              targetSymbol: name,
              method: null,
              methods: [],
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
        doubles.push({
          framework: 'mockall mock!',
          language: 'rust',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: target,
          method: null,
          methods: [],
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
