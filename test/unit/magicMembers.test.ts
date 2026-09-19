import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addType, emptyGraph } from '../../src/core/symbolGraph.js';
import type { MethodSymbol, SymbolGraph, TestDouble } from '../../src/core/types.js';

function m(name: string): MethodSymbol {
  return { name, returnType: null, params: [], visibility: 'public', line: 1 };
}

function graph(magic: boolean): SymbolGraph {
  const g = emptyGraph();
  addType(g, {
    name: 'App\\Bag',
    file: 'src/Bag.php',
    kind: 'class',
    methods: new Map(
      magic
        ? [
            ['__call', m('__call')],
            ['real', m('real')],
          ]
        : [['real', m('real')]],
    ),
    unknownMembers: new Set(['__call']),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  return g;
}

function run(framework: string, magic: boolean) {
  const double: TestDouble = {
    framework,
    language: 'php',
    file: 'tests/BagTest.php',
    line: 1,
    targetSymbol: 'App\\Bag',
    method: 'whateverYouLike',
    methods: [{ name: 'whateverYouLike', line: 1 }],
    withArity: null,
    assertedArity: null,
    returnTypeHint: null,
    returnExpr: null,
    confidence: 'definite',
  };
  return analyzeDoubles({
    doubles: [double],
    graph: graph(magic),
    fileLines: new Map([['tests/BagTest.php', ['', '']]]),
    options: { strictness: 'all' },
  });
}

describe('a PHP class that answers to any method name', () => {
  it('says nothing about a Mockery double on a class with __call', () => {
    // Mockery builds a proxy, so the call reaches `__call` at runtime.
    expect(run('Mockery', true)).toEqual([]);
  });

  it('still reports it for PHPUnit, which generates a subclass', () => {
    // PHPUnit's generated double carries only the declared methods and
    // refuses to configure anything else, so the stub really is broken.
    expect(run('PHPUnit_MockObject', true)[0]?.type).toBe('GHOST_METHOD');
  });

  it('reports it for Mockery when the class has no __call', () => {
    expect(run('Mockery', false)[0]?.type).toBe('GHOST_METHOD');
  });
});
