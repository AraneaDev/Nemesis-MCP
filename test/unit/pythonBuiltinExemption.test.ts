import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import type { MethodSymbol, SymbolGraph, TestDouble, TypeSymbol } from '../../src/core/types.js';

function fn(name: string, returnType: string | null): MethodSymbol {
  return { name, returnType, params: [], visibility: 'public', line: 1 };
}

function mod(file: string, methods: MethodSymbol[] = []): TypeSymbol {
  return {
    name: file,
    file,
    kind: 'module',
    methods: new Map(methods.map((m) => [m.name, m])),
    imports: new Map(),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

function patch(target: string, member: string): TestDouble {
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
    returnExpr: null,
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

describe('a Python module ghost for a module with no methods and no imports', () => {
  it('is a warning, not a definite finding', () => {
    // Before the fix, every Python module's `unknownMembers` was seeded with
    // the builtin set, so `unknownMembers.size > 0` was unconditionally true
    // and this case could never reach `warning`.
    const g = emptyGraph();
    addModule(g, mod('app/repo.py'));
    const found = run(g, patch('app.repo', 'save'));
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.confidence).toBe('warning');
  });
});

describe('the Python builtin exemption', () => {
  it('reports a genuinely missing member named filter, which the exemption no longer covers', () => {
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool')]));
    const found = run(g, patch('app.repo', 'filter'));
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.confidence).toBe('definite');
  });

  it('stays silent about patching open on a module that never had it', () => {
    // `open` is the exemption's canonical use: a module rarely defines its
    // own `open`, and `unittest.mock` special-cases builtins so the patch is
    // legitimate code even though this module never binds `open` itself.
    const g = emptyGraph();
    addModule(g, mod('app/repo.py', [fn('save', 'bool')]));
    expect(run(g, patch('app.repo', 'open'))).toEqual([]);
  });
});
