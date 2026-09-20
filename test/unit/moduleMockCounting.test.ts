import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';
import type { AnalyzeStats, MethodSymbol, TypeSymbol } from '../../src/core/types.js';

function fn(name: string, returnType: string | null, params: string[]): MethodSymbol {
  return {
    name,
    returnType,
    params: params.map((p) => ({ name: p, type: null, hasDefault: false, variadic: false })),
    visibility: 'public',
    line: 1,
  };
}

describe('one vi.mock with several signature-bearing keys', () => {
  it('counts as one inspected double, and still checks every key', async () => {
    const graph = emptyGraph();
    const api: TypeSymbol = {
      name: 'src/api.ts',
      file: 'src/api.ts',
      kind: 'module',
      methods: new Map([
        ['fetchUser', fn('fetchUser', 'string', [])],
        ['saveUser', fn('saveUser', 'boolean', ['id'])],
        ['deleteUser', fn('deleteUser', 'void', ['id'])],
      ]),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: 1,
    };
    addModule(graph, api);
    graph.exportsByFile.set('src/api.ts', new Set(['fetchUser', 'saveUser', 'deleteUser']));

    const source = [
      `vi.mock('../src/api', () => ({`,
      `  fetchUser: vi.fn(() => 1),`,
      `  saveUser: vi.fn((id: string) => true),`,
      `  deleteUser: vi.fn((id: string) => {}),`,
      `}));`,
    ].join('\n');
    const { doubles } = await extractTsDoubles('tests/api.test.ts', source, 'typescript');

    // One module-shape double, plus one factory-value double per key: four
    // doubles found, but only one of them is a user-written double.
    expect(doubles.length).toBe(4);
    expect(doubles.filter((d) => !d.fromFactory).length).toBe(1);

    const stats: AnalyzeStats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const findings = analyzeDoubles({
      doubles,
      graph,
      fileLines: new Map([['tests/api.test.ts', source.split('\n')]]),
      options: { strictness: 'all' },
      stats,
    });

    // Counted once, not once per key.
    expect(stats.checked).toBe(1);
    // The factory value's own findings still fire: `fetchUser` declares a
    // `string` return and the stub hands back a number.
    const drift = findings.find((f) => f.type === 'RETURN_DRIFT');
    expect(drift?.target).toBe('src/api.ts::fetchUser');
  });
});
