// ---------------------------------------------------------------------------
// unittest.mock / pytest-mock double extractor (tree-sitter-python).
// ---------------------------------------------------------------------------

import type { TestDouble, ScanDiagnostic, UnreadMock } from '../../core/types.js';
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

/**
 * An f-string is a `string` node like any other, so `patch(f"{MOD}.get_user")`
 * used to reach the target splitter and yield the literal text `f"{MOD}` as a
 * module name. That double then sat in `unresolved` looking like a target the
 * scan could not find, which is not what happened: the target was never read.
 */
function isInterpolated(node: SyntaxNode): boolean {
  return node.namedChildren.some((c) => c.type === 'interpolation');
}

export async function extractPythonDoubles(
  relFile: string,
  source: string,
  diagnostics?: ScanDiagnostic[],
  /**
   * Collects the `patch` calls this extractor recognised and then declined to
   * read. Passed in rather than returned because every caller already has a
   * `TestDouble[]` in hand, and a site recorded here is a fact about this tool
   * rather than about the file, so it belongs beside the diagnostics.
   */
  unread?: UnreadMock[],
): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  const parsed = await parseSource(
    'python',
    source,
    undefined,
    report(relFile, 'python', diagnostics),
  );
  const { root } = parsed;

  /**
   * variable name → resolved target (from `x = mocker.patch(...)` assignments,
   * with-aliases and decorator parameters).
   *
   * `scope` is the line range a decorator-injected parameter is valid in. The
   * walk is one flat, scope-blind pass, so without it `mock_verify` in one test
   * method carried the patcher bound by another method's decorator and named a
   * real member of a real module with total confidence.
   */
  const varMap = new Map<
    string,
    { target: string; method: string | null; callLine?: number; scope?: [number, number] }
  >();
  const specMap = new Map<string, { target: string }>();

  /**
   * What a `patch(...)` / `patch.object(...)` call names, or null when it is
   * not a patcher or its target cannot be read statically.
   */
  const patcherTarget = (
    call: SyntaxNode,
  ): { target: string; method: string | null; callLine: number } | null => {
    if (call.type !== 'call') return null;
    const fnText = field(call, 'function')?.text ?? '';
    if (!/^(\w+\.)?patch([._](object|multiple))?$/.test(fnText) && fnText !== 'create_autospec') {
      return null;
    }
    const args = field(call, 'arguments');
    const named = (args?.namedChildren ?? []).filter((a) => a.type !== 'comment');
    const first = named[0];
    if (!first) return null;
    if (first.type === 'string') {
      // An interpolated target names nothing checkable, and binding it put the
      // literal prefix into the map as though it were a module.
      if (isInterpolated(first)) return null;
      const split = splitDottedTarget(unquote(first.text));
      return { target: split.type, method: split.method, callLine: call.startPosition.row + 1 };
    }
    if (first.type !== 'identifier' && first.type !== 'attribute') return null;
    // `patch.object(Type, 'method')` names the member in its second argument.
    const second = named[1];
    const method =
      /^(\w+\.)?patch\.object$/.test(fnText) && second?.type === 'string' && !isInterpolated(second)
        ? unquote(second.text)
        : null;
    return { target: first.text, method, callLine: call.startPosition.row + 1 };
  };

  for (const { node } of walk(root)) {
    // `with patch.object(C, 'm') as handle:` binds the patcher to the alias.
    if (node.type === 'as_pattern') {
      const alias = field(node, 'alias')?.text ?? node.namedChildren[1]?.text;
      const value = node.namedChildren[0];
      if (alias && value) {
        const hit = patcherTarget(value);
        if (hit) {
          varMap.set(alias, hit);
          specMap.delete(alias);
        }
      }
    }

    // `@patch.object(...)` injects one parameter per patching decorator, and
    // unittest.mock fills them bottom-up: the decorator nearest the function
    // supplies the first parameter.
    if (node.type === 'decorated_definition') {
      const fn = node.namedChildren.find((c) => c.type === 'function_definition');
      const params = fn ? field(fn, 'parameters') : null;
      const names = (params?.namedChildren ?? [])
        .filter(
          (c) =>
            c.type === 'identifier' ||
            c.type === 'default_parameter' ||
            c.type === 'typed_parameter' ||
            c.type === 'typed_default_parameter',
        )
        .map((c) =>
          c.type === 'identifier'
            ? c.text
            : (field(c, 'name')?.text ??
              c.namedChildren.find((x) => x.type === 'identifier')?.text ??
              ''),
        )
        // unittest.mock injects after the receiver, so a method's first
        // parameter is not a mock. Counting from slot 0 bound the patcher to
        // `self` and shifted every real mock one place along.
        .filter((n, i) => !(i === 0 && /^(self|cls|mcs)$/.test(n)));
      const range: [number, number] | undefined = fn
        ? [fn.startPosition.row + 1, fn.endPosition.row + 1]
        : undefined;
      const scoped = range ? { scope: range } : {};
      const calls = node.namedChildren
        .filter((c) => c.type === 'decorator')
        .map((c) => c.namedChildren[0])
        .reverse();
      let slot = 0;
      for (const call of calls) {
        if (call?.type !== 'call') continue;
        const fnText = field(call, 'function')?.text ?? '';
        const positional = (field(call, 'arguments')?.namedChildren ?? []).filter(
          (a) => a.type !== 'comment' && a.type !== 'keyword_argument',
        );
        // `patch.multiple` injects no positional mock. Each member given as
        // DEFAULT arrives as a keyword argument named after the member, so it
        // binds by name and consumes no slot.
        if (/^(\w+\.)?patch[._]multiple$/.test(fnText)) {
          const owner = positional[0];
          const target =
            owner?.type === 'string' && !isInterpolated(owner)
              ? unquote(owner.text)
              : owner && (owner.type === 'identifier' || owner.type === 'attribute')
                ? owner.text
                : null;
          if (!target) continue;
          for (const kw of field(call, 'arguments')?.namedChildren ?? []) {
            if (kw.type !== 'keyword_argument') continue;
            const member = field(kw, 'name')?.text;
            const value = field(kw, 'value')?.text ?? '';
            if (!member || !/(^|\.)DEFAULT$/.test(value)) continue;
            varMap.set(member, {
              target,
              method: member,
              callLine: call.startPosition.row + 1,
              ...scoped,
            });
            specMap.delete(member);
          }
          continue;
        }
        const hit = patcherTarget(call);
        // A decorator that is not a patcher injects nothing, so it consumes no
        // parameter and must not shift the ones that follow.
        if (!hit) continue;
        // A patcher handed its replacement, positionally or as `new=`, injects
        // nothing either: the test already holds the object it supplied.
        const replacementAt = /^(\w+\.)?patch[._]object$/.test(fnText) ? 2 : 1;
        if (positional.length > replacementAt || keywordValue(call, 'new')) continue;
        const name = names[slot++];
        if (name) {
          varMap.set(name, { ...hit, ...scoped });
          specMap.delete(name);
        }
      }
    }

    if (node.type === 'assignment') {
      const left = field(node, 'left');
      const right = field(node, 'right');
      const isReturn = left?.type === 'attribute' && left.text.endsWith('.return_value');
      const isSideEffect = left?.type === 'attribute' && left.text.endsWith('.side_effect');
      if (isReturn || isSideEffect) {
        const parts = left!.text.split('.');
        const variable = parts[0];
        const fakeArity = isSideEffect ? lambdaArity(right) : null;
        const tracked = variable ? varMap.get(variable) : undefined;
        const line = node.startPosition.row + 1;
        const inScope = !tracked?.scope || (line >= tracked.scope[0] && line <= tracked.scope[1]);
        const hit = variable
          ? ((inScope ? tracked : undefined) ??
            (specMap.has(variable)
              ? { target: specMap.get(variable)!.target, method: null }
              : undefined))
          : undefined;
        // `handle.return_value` names no member of its own, so the method is
        // the one the patcher already named. A longer path, as in
        // `mock.count.return_value`, names the member itself.
        //
        // Unless the patcher already consumed a name: `patch('svc.auth.user_repo')`
        // replaces an object living in that module, so `handle.get_by_username`
        // configures a member of THAT object, whose type nothing here knows.
        // `user_repo` and `Client` are the same syntax, so a class cannot be
        // told from an instance either. Reading the attribute as a member of
        // the module claimed the module had the method, which was 397 false
        // GHOST_METHODs in one repository. Where the evidence runs out, silence.
        const reachesPastTheTarget = parts.length > 2 && Boolean(hit?.method);
        const method = parts.length === 2 ? (hit?.method ?? undefined) : parts[parts.length - 2];
        // A `side_effect` that is not a literal lambda says nothing about the
        // signature, and its value is not a return value either.
        if (hit && method && !reachesPastTheTarget && (isReturn || fakeArity !== null)) {
          // The patch call already produced a double for this member; the
          // handle only pins its return. Pushing a second one reported every
          // finding about the stub twice, once per line.
          const existing =
            'callLine' in hit && hit.callLine !== undefined
              ? doubles.find(
                  (d) =>
                    d.line === hit.callLine && d.targetSymbol === hit.target && d.method === method,
                )
              : undefined;
          if (existing) {
            if (isReturn) existing.returnExpr = right?.text ?? null;
            if (fakeArity !== null) existing.fakeArity = fakeArity;
            continue;
          }
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
        if (
          /^(\w+\.)?patch([._](object|multiple))?$/.test(fnText) ||
          fnText === 'create_autospec'
        ) {
          // Read the same way as a with-alias or a decorator, so `m = patch...`
          // binds the member named by `patch.object(Type, 'method')` too. The
          // interpolation guard lives in there: without it,
          // `m = patch(f"{MODULE}.get_user")` put `f"{MODULE}` into the map and
          // every assertion made through `m` was compared against a module by
          // that name.
          const hit = patcherTarget(right);
          if (hit) {
            varMap.set(left.text, hit);
            specMap.delete(left.text);
          }
        } else if (/^(Async)?Magic?Mock$|^(Async)?Mock$/.test(fnText)) {
          const spec = keywordValue(right, 'spec') ?? keywordValue(right, 'spec_set');
          if (spec && (spec.type === 'identifier' || spec.type === 'attribute')) {
            // The maps are flat and scope-blind, so `m` in one test function
            // is the same key as `m` in the next. A later binding has to
            // replace the earlier one, or a stale with-alias keeps winning and
            // the member configured here stops being checked.
            specMap.set(left.text, { target: spec.text });
            varMap.delete(left.text);
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
    // A comment is a named child of the argument list, so
    // `patch.object(mod._x,  # type: ignore\n "method")` put the comment in the
    // second position and the method name became `# type: ignore`. Positional
    // arguments are counted over the real ones only.
    const argsNode = (args?.namedChildren ?? []).filter((a) => a.type !== 'comment');
    const first = argsNode[0];
    const framework = fnText.startsWith('mocker.') ? 'pytest-mock' : 'unittest.mock';

    // `patch(TARGET)` and `patch(f"{MOD}.get_user")` name a target this cannot
    // read. They are the commonest way a real patch escapes the audit, and
    // nothing downstream can tell them from a file that has no patches at all.
    if (
      /^(\w+\.)?patch$/.test(fnText) &&
      first &&
      (first.type !== 'string' || isInterpolated(first))
    ) {
      unread?.push({
        line: node.startPosition.row + 1,
        reason:
          first.type === 'string'
            ? 'patch target is an interpolated string'
            : `patch target is a ${first.type}`,
      });
      continue;
    }

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
      if (second && (second.type !== 'string' || isInterpolated(second))) {
        unread?.push({
          line: node.startPosition.row + 1,
          reason: `patch.object member name is a ${second.type}`,
        });
        continue;
      }
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
      } else if (first) {
        unread?.push({
          line: node.startPosition.row + 1,
          reason: `patch.object target is a ${first.type}`,
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
        const line = node.startPosition.row + 1;
        const candidate = varMap.get(name);
        const tracked =
          candidate &&
          (!candidate.scope || (line >= candidate.scope[0] && line <= candidate.scope[1]))
            ? candidate
            : undefined;
        if (tracked) {
          // The patcher already consumed a name, and the assertion reaches
          // past it: `patch("mod.singleton")` replaces an object living in the
          // module, so `handle.method` is a member of THAT object and nothing
          // here knows its type. Reading it as a member of the module claimed
          // the module had the method.
          if (method !== null && tracked.method) return null;
          return { target: tracked.target, method: method ?? tracked.method };
        }
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
