import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addType, emptyGraph } from '../../src/core/symbolGraph.js';
import type { AnalyzeStats, SymbolGraph, TestDouble } from '../../src/core/types.js';

function graphWithSvc(): SymbolGraph {
  const g = emptyGraph();
  addType(g, {
    name: 'Svc',
    file: 'src/Svc.ts',
    kind: 'class',
    methods: new Map([
      ['run', { name: 'run', returnType: 'boolean', params: [], visibility: 'public', line: 1 }],
    ]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  return g;
}

function double(target: string | null, method: string | null): TestDouble {
  return {
    framework: 'vi.spyOn',
    language: 'typescript',
    file: 'tests/a.test.ts',
    line: 1,
    targetSymbol: target,
    method,
    methods: method ? [{ name: method, line: 1 }] : [],
    withArity: null,
    assertedArity: null,
    returnTypeHint: null,
    returnExpr: null,
    confidence: 'definite',
  };
}

function statsFor(doubles: TestDouble[]): AnalyzeStats {
  const stats: AnalyzeStats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
  analyzeDoubles({
    doubles,
    graph: graphWithSvc(),
    fileLines: new Map([['tests/a.test.ts', ['', '']]]),
    options: { strictness: 'all', languages: [] },
    stats,
  });
  return stats;
}

describe('what the analyzer reports having reached', () => {
  it('counts a double whose member was compared', () => {
    expect(statsFor([double('Svc', 'run')])).toEqual({
      checked: 1,
      unresolved: 0,
      unknowable: 0,
      noTarget: 0,
    });
  });

  it('counts a resolved target with a member that is not there as checked', () => {
    // It produced a ghost finding, so it was compared. "Checked" means the
    // analyzer had something to say, not that it said nothing.
    expect(statsFor([double('Svc', 'gone')]).checked).toBe(1);
  });

  it('counts a target that resolved to nothing', () => {
    expect(statsFor([double('Nowhere', 'run')])).toEqual({
      checked: 0,
      unresolved: 1,
      unknowable: 0,
      noTarget: 0,
    });
  });

  it('counts a built-in as unknowable rather than unresolved', () => {
    // `console`, `process` and `Date` never had a contract to check. Counting
    // them as unresolved would make the gap look like work that remains.
    const stats = statsFor([double('console', 'log'), double('Date', 'now')]);
    expect(stats.unknowable).toBe(2);
    expect(stats.unresolved).toBe(0);
  });

  it('counts a package specifier as unknowable', () => {
    expect(statsFor([double('some-package', 'connect')]).unknowable).toBe(1);
  });

  it('counts a double with no target at all', () => {
    expect(statsFor([double(null, 'run')])).toEqual({
      checked: 0,
      unresolved: 0,
      unknowable: 0,
      noTarget: 1,
    });
  });

  it('leaves the findings array untouched', () => {
    const stats: AnalyzeStats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const found = analyzeDoubles({
      doubles: [double('Svc', 'gone')],
      graph: graphWithSvc(),
      fileLines: new Map([['tests/a.test.ts', ['', '']]]),
      options: { strictness: 'all', languages: [] },
      stats,
    });
    expect(found[0]?.type).toBe('GHOST_METHOD');
  });
});
