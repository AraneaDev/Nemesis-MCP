// ---------------------------------------------------------------------------
// unittest.mock / pytest-mock double extractor (tree-sitter-python).
// ---------------------------------------------------------------------------

import type { TestDouble, ScanDiagnostic } from '../../core/types.js';
import { parseSource, report } from '../../parser/loader.js';
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
  diagnostics?: ScanDiagnostic[],
): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  const parsed = await parseSource(
    'python',
    source,
    undefined,
    report(relFile, 'python', diagnostics),
  );
  const { root } = parsed;

  /** variable name → resolved target (from `x = mocker.patch(...)` assignments) */
  const varMap = new Map<string, { target: string; method: string | null }>();
  const specMap = new Map<string, { target: string }>();

  for (const { node } of walk(root)) {
    if (node.type === 'assignment') {
      const left = field(node, 'left');
      const right = field(node, 'right');
      const isReturn = left?.type === 'attribute' && left.text.endsWith('.return_value');
      const isSideEffect = left?.type === 'attribute' && left.text.endsWith('.side_effect');
      if (isReturn || isSideEffect) {
        const parts = left!.text.split('.');
        const variable = parts[0];
        const method = parts[parts.length - 2];
        const fakeArity = isSideEffect ? lambdaArity(right) : null;
        const hit = variable
          ? (varMap.get(variable) ??
            (specMap.has(variable)
              ? { target: specMap.get(variable)!.target, method: null }
              : undefined))
          : undefined;
        // A `side_effect` that is not a literal lambda says nothing about the
        // signature, and its value is not a return value either.
        if (hit && method && (isReturn || fakeArity !== null)) {
          doubles.push({
            framework: 'unittest.mock',
            language: 'python',
            file: relFile,
            line: node.startPosition.row + 1,
            targetSymbol: hit.target,
            method,
            methods: [{ name: method, line: node.startPosition.row + 1 }],
            withArity: null,
            assertedArity: null,
            ...(fakeArity !== null ? { fakeArity } : {}),
            returnTypeHint: null,
            returnExpr: isReturn ? (right?.text ?? null) : null,
            confidence: 'definite',
          });
        }
      }
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
        } else if (/^(Async)?Magic?Mock$|^(Async)?Mock$/.test(fnText)) {
          const spec = keywordValue(right, 'spec') ?? keywordValue(right, 'spec_set');
          if (spec && (spec.type === 'identifier' || spec.type === 'attribute')) {
            specMap.set(left.text, { target: spec.text });
            doubles.push({
              framework: 'unittest.mock',
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
      const fakeArity = lambdaArity(keywordValue(node, 'side_effect'));
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
        ...(fakeArity !== null ? { fakeArity } : {}),
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
      const fakeArity = lambdaArity(keywordValue(node, 'side_effect'));
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
          ...(fakeArity !== null ? { fakeArity } : {}),
          returnTypeHint: null,
          returnExpr: returnKw?.text ?? null,
          confidence: 'definite',
        });
      }
      continue;
    }

    // patch.multiple(Type, save=DEFAULT, find=DEFAULT): every keyword names a
    // member that has to exist, and `patch` raises AttributeError for one that
    // does not. Nothing was read out of these at all.
    if (/^(\w+\.)?patch\.multiple$/.test(fnText) && first) {
      if (first.type === 'identifier' || first.type === 'attribute') {
        const line = node.startPosition.row + 1;
        const members: Array<{ name: string; line: number }> = [];
        for (const c of argsNode) {
          if (c.type !== 'keyword_argument') continue;
          const name = field(c, 'name')?.text;
          if (name && !PATCH_KEYWORDS.has(name)) members.push({ name, line });
        }
        if (members.length > 0) {
          doubles.push({
            framework,
            language: 'python',
            file: relFile,
            line,
            targetSymbol: first.text,
            method: members[0]?.name ?? null,
            methods: members,
            withArity: null,
            assertedArity: null,
            returnTypeHint: null,
            returnExpr: null,
            confidence: 'definite',
          });
        }
      }
      continue;
    }

    // An assignment such as `m = Mock(spec=Client)` is recorded by the
    // assignment branch above; matching the call again here produced a second,
    // identical double for the same mock.
    const inAssignment =
      node.parent?.type === 'assignment' && field(node.parent, 'right')?.id === node.id;

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
      if (!inAssignment && spec && (spec.type === 'identifier' || spec.type === 'attribute')) {
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
    if (
      /^assert_called(_once)?_with$|^assert_any_call$/.test(
        fn.type === 'attribute' ? (field(fn, 'attribute')?.text ?? '') : '',
      )
    ) {
      const attr = fn.type === 'attribute' ? field(fn, 'attribute')?.text : null;
      if (!attr) continue;
      const obj = fn.type === 'attribute' ? field(fn, 'object') : null;
      let hit: { target: string; method: string | null } | null = null;
      const lookup = (
        name: string,
        method: string | null,
      ): { target: string; method: string | null } | null => {
        const tracked = varMap.get(name);
        if (tracked) return { target: tracked.target, method: method ?? tracked.method };
        const spec = specMap.get(name);
        return spec ? { target: spec.target, method } : null;
      };
      if (obj?.type === 'attribute') {
        // `m.login.assert_called_with(...)`: the mock is `m` and the method is
        // `login`. Looking `login` up as if it were the mock variable found
        // nothing, so the asserted argument count was silently dropped and no
        // arity was ever checked through an assertion.
        const base = field(obj, 'object');
        const method = field(obj, 'attribute')?.text ?? null;
        if (base?.type === 'identifier') hit = lookup(base.text, method);
      } else if (obj?.type === 'identifier') {
        hit = lookup(obj.text, null);
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
          ...(argsNode.length > 0 ? { withArgs: argsNode.map((a) => a.text) } : {}),
          assertedArity: argsNode.length,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        });
      }
    }
  }

  // `patch.object(overrides, "stored_value")` names something this test file
  // imported. Production declares nothing under that bare word, so without the
  // test's own imports the target matches nothing at all.
  const imported = testFileImports(root);
  for (const d of doubles) {
    const t = d.targetSymbol;
    if (!t || t.includes('.')) continue;
    const from = imported.get(t);
    if (from) d.targetImportedFrom = from;
  }

  return doubles;
}

/**
 * Where each name a test file imports came from, as a dotted path.
 *
 * `from core.system.app_config import overrides` binds `overrides` to
 * `core.system.app_config.overrides`; `import smtplib` binds `smtplib` to
 * itself. Aliases bind under the alias, which is the name the test then uses.
 */
function testFileImports(root: SyntaxNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const { node } of walk(root)) {
    if (node.type === 'import_from_statement') {
      const source = node.namedChildren[0];
      if (!source || source.type === 'relative_import') continue;
      for (const spec of node.namedChildren.slice(1)) {
        if (spec.type === 'aliased_import') {
          const alias = field(spec, 'alias')?.text;
          const name = field(spec, 'name')?.text;
          if (alias && name) out.set(alias, `${source.text}.${name}`);
        } else if (spec.type === 'dotted_name') {
          out.set(spec.text, `${source.text}.${spec.text}`);
        }
      }
      continue;
    }
    if (node.type === 'import_statement') {
      for (const spec of node.namedChildren) {
        if (spec.type === 'aliased_import') {
          const alias = field(spec, 'alias')?.text;
          const name = field(spec, 'name')?.text;
          if (alias && name) out.set(alias, name);
        } else if (spec.type === 'dotted_name') {
          // `import os.path` binds `os`, and the name stands for itself.
          const head = spec.text.split('.')[0];
          if (head) out.set(head, head);
        }
      }
    }
  }
  return out;
}

/** Value of a keyword argument in a call node, if present. */
/**
 * Parameters a `lambda` replacement declares. A `*args` lambda, or anything
 * that is not a literal lambda, leaves the arity undecidable. A leading
 * `self` is dropped because `autospec=True` passes the receiver and the
 * indexer already dropped it on the production side.
 */
function lambdaArity(node: SyntaxNode | null): number | null {
  if (!node || node.type !== 'lambda') return null;
  const params = field(node, 'parameters');
  if (!params) return 0;
  const declared = params.namedChildren.filter((c) => c.type !== 'comment');
  if (
    declared.some((c) => c.type === 'list_splat_pattern' || c.type === 'dictionary_splat_pattern')
  )
    return null;
  const first = declared[0];
  const skip = first && /^(self|cls)$/.test(first.text.split(/[:=]/)[0]?.trim() ?? '') ? 1 : 0;
  return declared.length - skip;
}

/** `patch`'s own keywords, which configure the patch rather than name a member. */
const PATCH_KEYWORDS = new Set([
  'spec',
  'spec_set',
  'create',
  'autospec',
  'new_callable',
  'new',
  'return_value',
  'side_effect',
]);

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
