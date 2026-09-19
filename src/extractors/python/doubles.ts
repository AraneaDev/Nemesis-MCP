// ---------------------------------------------------------------------------
// unittest.mock / pytest-mock double extractor (tree-sitter-python).
// ---------------------------------------------------------------------------

import type { TestDouble } from '../../core/types.js';
import { parseSource } from '../../parser/loader.js';
import { walk, field, unquote } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

/** Split a dotted patch target into (type, method) — method may be null. */
function splitDottedTarget(dotted: string): { type: string; method: string | null } {
  const parts = dotted.split('.').filter(Boolean);
  if (parts.length <= 1) return { type: parts[0] ?? dotted, method: null };
  const method = parts[parts.length - 1] ?? null;
  const type = parts.slice(0, -1).join('.');
  return { type, method };
}

export async function extractPythonDoubles(
  relFile: string,
  source: string,
): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  let parsed;
  try {
    parsed = await parseSource('python', source);
  } catch {
    return doubles;
  }
  const { root } = parsed;

  /** variable name → resolved target (from `x = mocker.patch(...)` assignments) */
  const varMap = new Map<string, { target: string; method: string | null }>();

  for (const { node } of walk(root)) {
    if (node.type === 'assignment') {
      const left = field(node, 'left');
      const right = field(node, 'right');
      if (left?.type === 'identifier' && right?.type === 'call') {
        const fn = field(right, 'function');
        const fnText = fn?.text ?? '';
        if (/^(\w+\.)?patch(_object|_multiple)?$/.test(fnText) || fnText === 'create_autospec') {
          const args = field(right, 'arguments');
          const first = args?.namedChildren[0];
          let target: string | null = null;
          let method: string | null = null;
          if (first) {
            if (first.type === 'string') {
              const split = splitDottedTarget(unquote(first.text));
              target = split.type;
              method = split.method;
            } else if (first.type === 'identifier' || first.type === 'attribute') {
              target = first.text;
            }
          }
          if (target) {
            varMap.set(left.text, { target, method });
          }
        }
      }
      continue;
    }

    if (node.type !== 'call') continue;
    const fn = field(node, 'function');
    if (!fn) continue;
    const fnText = fn.text;
    const args = field(node, 'arguments');
    const argsNode = args?.namedChildren ?? [];
    const first = argsNode[0];
    const framework = fnText.startsWith('mocker.') ? 'pytest-mock' : 'unittest.mock';

    // patch('x.y.z') / mocker.patch('x.y.z') / patch('x.y.z', return_value=...)
    if (/^(\w+\.)?patch$/.test(fnText) && first?.type === 'string') {
      const { type, method } = splitDottedTarget(unquote(first.text));
      const returnKw = keywordValue(node, 'return_value');
      doubles.push({
        framework,
        language: 'python',
        file: relFile,
        line: node.startPosition.row + 1,
        targetSymbol: type,
        method,
        methods: method ? [{ name: method, line: node.startPosition.row + 1 }] : [],
        withArity: null,
        assertedArity: null,
        returnTypeHint: null,
        returnExpr: returnKw?.text ?? null,
        confidence: 'definite',
      });
      continue;
    }

    // patch.object(Type, 'method') / mock.patch.object(Type, 'method')
    if (/^(\w+\.)?patch\.object$/.test(fnText)) {
      const second = argsNode[1];
      const method = second ? unquote(second.text) : null;
      const returnKw = keywordValue(node, 'return_value');
      if (first && (first.type === 'identifier' || first.type === 'attribute')) {
        doubles.push({
          framework,
          language: 'python',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: first.text,
          method,
          methods: method ? [{ name: method, line: node.startPosition.row + 1 }] : [],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: returnKw?.text ?? null,
          confidence: 'definite',
        });
      }
      continue;
    }

    // create_autospec(Type) / Mock(spec=Type) / MagicMock(spec_set=Type)
    if (/^create_autospec$/.test(fnText) && first) {
      if (first.type === 'identifier' || first.type === 'attribute') {
        doubles.push({
          framework,
          language: 'python',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: first.text,
          method: null,
          methods: [],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        });
      }
      continue;
    }
    if (/^(Async)?Magic?Mock$|^(Async)?Mock$/.test(fnText)) {
      const spec = keywordValue(node, 'spec') ?? keywordValue(node, 'spec_set');
      if (spec && (spec.type === 'identifier' || spec.type === 'attribute')) {
        doubles.push({
          framework,
          language: 'python',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: spec.text,
          method: null,
          methods: [],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        });
      }
      continue;
    }

    // assert_called_with / assert_called_once_with / assert_called_with on tracked mocks
    if (/^assert_called(_once)?_with$|^assert_any_call$/.test(fn.type === 'attribute' ? (field(fn, 'attribute')?.text ?? '') : '')) {
      const attr = fn.type === 'attribute' ? field(fn, 'attribute')?.text : null;
      if (!attr) continue;
      const obj = fn.type === 'attribute' ? field(fn, 'object') : null;
      let hit: { target: string; method: string | null } | null = null;
      if (obj?.type === 'attribute' || obj?.type === 'identifier' || obj?.type === 'subscript') {
        const name = obj.type === 'identifier' ? obj.text : (obj.type === 'attribute' ? field(obj, 'attribute')?.text ?? null : null);
        if (name) hit = varMap.get(name) ?? null;
      }
      if (hit) {
        doubles.push({
          framework,
          language: 'python',
          file: relFile,
          line: node.startPosition.row + 1,
          targetSymbol: hit.target,
          method: hit.method,
          methods: hit.method ? [{ name: hit.method, line: node.startPosition.row + 1 }] : [],
          withArity: null,
          assertedArity: argsNode.length,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        });
      }
    }
  }

  return doubles;
}

/** Value of a keyword argument in a call node, if present. */
function keywordValue(call: SyntaxNode, name: string): SyntaxNode | null {
  const args = field(call, 'arguments');
  if (!args) return null;
  for (const c of args.namedChildren) {
    if (c.type === 'keyword_argument') {
      const n = field(c, 'name');
      if (n?.text === name) return field(c, 'value');
    }
  }
  return null;
}
