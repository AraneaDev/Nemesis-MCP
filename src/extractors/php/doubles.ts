// ---------------------------------------------------------------------------
// PHPUnit / Pest / Mockery double extractor (verified against tree-sitter-php).
// ---------------------------------------------------------------------------

import type { TestDouble } from '../../core/types.js';
import { parseSource } from '../../parser/loader.js';
import { walk, field, unquote } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

const FACTORY_FNS = /^(createMock|createStub|createPartialMock|mock|spy)$/;

interface ChainInfo {
  methods: Array<{ name: string; line: number }>;
  withArity: number | null;
  /** Source text of the `with(...)` arguments, for type comparison. */
  withArgs: string[];
  /** `willReturnSelf()` was used, which asserts the method returns `$this`. */
  returnsSelf: boolean;
  /**
   * Every configured return value. `willReturnOnConsecutiveCalls(a, b, c)` and
   * Mockery's `andReturn(a, b)` queue one value per call, and each has to
   * satisfy the declared return type; only the first was ever looked at.
   */
  returnExprs: string[];
}

/** Collect method/with/return info walking the fluent chain via `object` fields. */
function chainInfo(root: SyntaxNode): ChainInfo {
  const info: ChainInfo = {
    methods: [],
    withArity: null,
    withArgs: [],
    returnsSelf: false,
    returnExprs: [],
  };
  let cur: SyntaxNode | null = root;
  while (cur) {
    if (cur.type === 'member_call_expression' || cur.type === 'method_call_expression') {
      const name = field(cur, 'name')?.text ?? '';
      const args = field(cur, 'arguments');
      const firstArg = args?.namedChildren[0];
      if (name === 'method' || name === 'shouldReceive') {
        if (firstArg) {
          info.methods.push({
            name: unquote(firstArg.text),
            line: cur.startPosition.row + 1,
          });
        }
      } else if (name === 'with') {
        // `with(...)` on Mockery can also be a constraint; count arguments.
        info.withArity = args?.namedChildCount ?? 0;
        info.withArgs = (args?.namedChildren ?? []).map((a) => a.text);
      } else if (
        name === 'willReturn' ||
        name === 'willReturnOnConsecutiveCalls' ||
        name === 'willReturnMap' ||
        name === 'willReturnCallback' ||
        name === 'willReturnSelf' ||
        name === 'andReturnSelf' ||
        name === 'andReturn' ||
        name === 'andSet' ||
        name === 'andReturnUsing'
      ) {
        if (name === 'willReturnSelf' || name === 'andReturnSelf') info.returnsSelf = true;
        const values =
          name === 'willReturnOnConsecutiveCalls' || name === 'andReturn'
            ? (args?.namedChildren ?? []).map((a) => a.text)
            : firstArg
              ? [firstArg.text]
              : [];
        if (values.length > 0) info.returnExprs = values;
      }
      cur = field(cur, 'object');
    } else if (cur.type === 'scoped_call_expression') {
      cur = field(cur, 'scope');
    } else if (cur.type === 'function_call_expression') {
      cur = null; // factory call reached; stop
    } else if (cur.type === 'variable_name') {
      cur = null;
    } else {
      cur = null;
    }
  }
  return info;
}

/** Extract `Foo::class` target from call arguments. */
function staticTarget(node: SyntaxNode): string | null {
  const args = field(node, 'arguments');
  const first = args?.namedChildren[0];
  if (!first) return null;
  const text = first.text.replace(/::class\s*$/i, '');
  const cleaned = text.replace(/^['"]|['"]$/g, '');
  return cleaned || null;
}

interface FactoryHit {
  target: string;
  framework: string;
}

/** Identify a factory call node (function/scoped/member call) → target. */
function factoryOf(node: SyntaxNode | null): FactoryHit | null {
  if (!node) return null;
  if (node.type === 'function_call_expression') {
    const name = field(node, 'function')?.text ?? '';
    if (FACTORY_FNS.test(name)) {
      const target = staticTarget(node);
      if (target) {
        return {
          target,
          framework: name === 'mock' || name === 'spy' ? 'Pest/Mockery' : `PHPUnit ${name}`,
        };
      }
    }
    return null;
  }
  if (node.type === 'scoped_call_expression') {
    const scope = field(node, 'scope')?.text ?? '';
    const name = field(node, 'name')?.text ?? '';
    if (scope === 'Mockery' && /^(mock|spy|instanceMock)$/.test(name)) {
      const target = staticTarget(node);
      if (target) return { target, framework: 'Mockery' };
    }
    return null;
  }
  if (node.type === 'member_call_expression') {
    const name = field(node, 'name')?.text ?? '';
    if (/^(createMock|createStub|createPartialMock|getMockBuilder)$/.test(name)) {
      const target = staticTarget(node);
      if (target) {
        return {
          target,
          framework: name === 'getMockBuilder' ? 'PHPUnit getMockBuilder' : 'PHPUnit_MockObject',
        };
      }
    }
    return null;
  }
  return null;
}

export async function extractPhpDoubles(relFile: string, source: string): Promise<TestDouble[]> {
  const doubles: TestDouble[] = [];
  const parsed = await parseSource('php', source);
  const { root } = parsed;

  /** variable name → factory hit (from `$x = createMock(Foo::class)`). */
  const varMap = new Map<string, FactoryHit>();

  for (const { node } of walk(root)) {
    // Track assignments of factory calls to variables.
    if (node.type === 'assignment_expression') {
      const left = field(node, 'left');
      const right = field(node, 'right');
      if (left?.type === 'variable_name' && right) {
        // Descend the receiver chain to the factory at its root. Unwrapping a
        // single `->getMock()` only covered the shortest possible builder;
        // `getMockBuilder(X)->disableOriginalConstructor()->getMock()` and
        // `Mockery::mock(X)->makePartial()` both put configurator calls in
        // between, and neither was recognised as producing a double.
        let hit: FactoryHit | null = null;
        let cur: SyntaxNode | null = right;
        for (let i = 0; i < 32 && cur; i++) {
          hit = factoryOf(cur);
          if (hit) break;
          cur =
            cur.type === 'member_call_expression' || cur.type === 'method_call_expression'
              ? field(cur, 'object')
              : null;
        }
        if (hit) varMap.set(left.text, hit);
      }
      continue;
    }

    if (node.type !== 'member_call_expression' && node.type !== 'method_call_expression') continue;

    // Only outermost chain roots.
    const parent = node.parent;
    if (
      parent &&
      (parent.type === 'member_call_expression' || parent.type === 'method_call_expression') &&
      field(parent, 'object')?.id === node.id
    ) {
      continue;
    }

    const obj = field(node, 'object');
    let hit: FactoryHit | null = null;
    if (obj?.type === 'variable_name') {
      hit = varMap.get(obj.text) ?? null;
    } else if (obj) {
      // Receiver may be a factory call, a variable holding one, or a nested
      // chain ending in either.
      let cur: SyntaxNode | null = obj;
      for (let i = 0; i < 32 && cur; i++) {
        const f = factoryOf(cur);
        if (f) {
          hit = f;
          break;
        }
        if (cur.type === 'variable_name') {
          hit = varMap.get(cur.text) ?? null;
          break;
        }
        if (cur.type === 'member_call_expression' || cur.type === 'method_call_expression') {
          cur = field(cur, 'object');
          continue;
        }
        break;
      }
    }
    if (!hit) continue;

    const info = chainInfo(node);
    if (info.methods.length === 0 && info.withArity === null && info.returnExprs.length === 0) {
      continue; // nothing configured on the double
    }
    // One double per queued return value, so each is checked against the
    // declared type. The extras carry no arity, which would otherwise be
    // reported once per value.
    const returns = info.returnExprs.length > 0 ? info.returnExprs : [null];
    for (const [index, returnExpr] of returns.entries()) {
      doubles.push({
        framework: hit.framework,
        language: 'php',
        file: relFile,
        line: node.startPosition.row + 1,
        targetSymbol: hit.target,
        method: info.methods[0]?.name ?? null,
        methods: info.methods,
        withArity: index === 0 ? info.withArity : null,
        ...(index === 0 && info.withArgs.length > 0 ? { withArgs: info.withArgs } : {}),
        assertedArity: null,
        returnTypeHint: null,
        returnExpr,
        ...(index === 0 && info.returnsSelf ? { returnsSelf: true } : {}),
        confidence: 'definite',
      });
    }
  }

  return doubles;
}
