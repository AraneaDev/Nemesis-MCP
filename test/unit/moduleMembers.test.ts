import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import type { MethodSymbol, SymbolGraph, TestDouble, TypeSymbol } from '../../src/core/types.js';

function fn(name: string, returnType: string | null, params: string[]): MethodSymbol {
  return {
    name,
    returnType,
    params: params.map((p) => ({ name: p, type: null, hasDefault: false, variadic: false })),
    visibility: 'public',
    line: 1,
  };
}

function mod(
  file: string,
  methods: MethodSymbol[],
  imports: Array<[string, { from: string; name: string }]> = [],
  unknown: string[] = [],
): TypeSymbol {
  return {
    name: file,
    file,
    kind: 'module',
    methods: new Map(methods.map((m) => [m.name, m])),
    imports: new Map(imports),
    unknownMembers: new Set([...imports.map(([alias]) => alias), ...unknown]),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

function patch(target: string, member: string, returnExpr: string | null = null): TestDouble {
  return {
    framework: 'unittest.mock',
    language: 'python',
    file: 'tests/test_a.py',
    line: 2,
    targetSymbol: target,
    method: member,
    methods: [{ name: member, line: 2 }],
    withArity: null,
    assertedArity: null,
    returnTypeHint: null,
    returnExpr,
    confidence: 'definite',
  };
}

function run(graph: SymbolGraph, d: TestDouble) {
  return analyzeDoubles({
    doubles: [d],
    graph,
    fileLines: new Map([['tests/test_a.py', ['', '', '']]]),
    options: { strictness: 'all' },
  });
}

describe('a double that names a module', () => {
  it('reports a member the module does not have', () => {
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool', ['x'])]));
    const found = run(g, patch('app.repo', 'savee'));
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.suggestion).toBe('save');
  });

  it('accepts a member the module defines', () => {
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool', ['x'])]));
    expect(run(g, patch('app.repo', 'save'))).toEqual([]);
  });

  it('checks the return value against the function signature', () => {
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool', ['x'])]));
    const found = run(g, patch('app.repo', 'save', "'yes'"));
    expect(found[0]?.type).toBe('RETURN_DRIFT');
  });

  it('follows an imported name to the module that defines it', () => {
    // patch("core.webhook.manager.get_db") names a member manager.py imports.
    const g = emptyGraph();
    addModule(g, mod('core/persistence/database.py', [fn('get_db', 'int', [])]));
    addModule(
      g,
      mod(
        'core/webhook/manager.py',
        [],
        [['get_db', { from: 'core.persistence.database', name: 'get_db' }]],
      ),
    );
    expect(run(g, patch('core.webhook.manager', 'get_db'))).toEqual([]);
    const drift = run(g, patch('core.webhook.manager', 'get_db', "'text'"));
    expect(drift[0]?.type).toBe('RETURN_DRIFT');
  });

  it('says nothing about an imported name whose source is outside the scan', () => {
    const g = emptyGraph();
    addModule(
      g,
      mod('core/webhook/manager.py', [], [['to_thread', { from: 'asyncio', name: 'to_thread' }]]),
    );
    expect(run(g, patch('core.webhook.manager', 'to_thread'))).toEqual([]);
  });

  it('says nothing about any member of a module that gave up its list', () => {
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool', ['x'])], [], ['*']));
    expect(run(g, patch('app.repo', 'anything_at_all'))).toEqual([]);
  });

  it('does not loop on two modules importing from each other', () => {
    const g = emptyGraph();
    addModule(g, mod('pkg/a.py', [], [['x', { from: 'pkg.b', name: 'x' }]]));
    addModule(g, mod('pkg/b.py', [], [['x', { from: 'pkg.a', name: 'x' }]]));
    expect(run(g, patch('pkg.a', 'x'))).toEqual([]);
  });
});
