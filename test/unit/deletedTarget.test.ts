import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addType, emptyGraph } from '../../src/core/symbolGraph.js';
import type { SymbolGraph, TestDouble, TypeSymbol } from '../../src/core/types.js';

function typeIn(file: string, name: string): TypeSymbol {
  return {
    name,
    file,
    kind: 'class',
    methods: new Map([
      ['run', { name: 'run', returnType: null, params: [], visibility: 'public', line: 1 }],
    ]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

function run(lines: string[], target: string, graph: SymbolGraph) {
  const double: TestDouble = {
    framework: 'vi.spyOn',
    language: 'typescript',
    file: 'tests/a.test.ts',
    line: 2,
    targetSymbol: target,
    method: 'run',
    methods: [{ name: 'run', line: 2 }],
    withArity: null,
    assertedArity: null,
    returnTypeHint: null,
    returnExpr: null,
    confidence: 'definite',
  };
  return analyzeDoubles({
    doubles: [double],
    graph,
    fileLines: new Map([['tests/a.test.ts', lines]]),
    options: { strictness: 'all' },
  });
}

function graphWith(...types: TypeSymbol[]): SymbolGraph {
  const graph = emptyGraph();
  for (const t of types) addType(graph, t);
  return graph;
}

describe('a double whose target is no longer declared', () => {
  const KEPT = typeIn('src/svc.ts', 'Kept');

  it('reports a name the scanned file no longer declares', () => {
    const found = run(
      ['', "import { Kept, Removed } from '../src/svc';"],
      'Removed',
      graphWith(KEPT),
    );
    expect(found[0]?.message).toContain("'Removed' is imported from '../src/svc'");
  });

  it('says nothing when the name is still there', () => {
    expect(run(['', "import { Kept } from '../src/svc';"], 'Kept', graphWith(KEPT))).toEqual([]);
  });

  it('says nothing about a file this scan never read', () => {
    // Absent from the graph because it was never scanned, not because the
    // symbol went away. Inferring deletion from a failed lookup alone was
    // wrong every time it was tried.
    expect(run(['', "import { Gone } from '../src/elsewhere';"], 'Gone', graphWith(KEPT))).toEqual(
      [],
    );
  });

  it('says nothing about a package import', () => {
    expect(run(['', "import { Client } from 'some-package';"], 'Client', graphWith(KEPT))).toEqual(
      [],
    );
  });

  it('says nothing about a namespace import', () => {
    // `ns` is the module, not a symbol the module exports.
    expect(run(['', "import * as ns from '../src/svc';"], 'ns', graphWith(KEPT))).toEqual([]);
  });

  it('looks up the exported name, not the alias', () => {
    const aliased = ['', "import { Kept as Local } from '../src/svc';"];
    expect(run(aliased, 'Local', graphWith(KEPT))).toEqual([]);
    const renamed = ['', "import { Removed as Local } from '../src/svc';"];
    expect(run(renamed, 'Local', graphWith(KEPT))[0]?.message).toContain("'Removed'");
  });

  it('ignores a binding that is not shaped like a type', () => {
    // `export const sounds = new SoundManager()` is a value, absent from a
    // graph of types while very much present in the file.
    expect(run(['', "import { sounds } from '../src/svc';"], 'sounds', graphWith(KEPT))).toEqual(
      [],
    );
  });

  it('resolves a .js specifier to the TypeScript file it means', () => {
    const found = run(['', "import { Removed } from '../src/svc.js';"], 'Removed', graphWith(KEPT));
    expect(found[0]?.message).toContain("'Removed'");
  });

  it('resolves an index file', () => {
    const found = run(
      ['', "import { Removed } from '../src/thing';"],
      'Removed',
      graphWith(typeIn('src/thing/index.ts', 'Kept')),
    );
    expect(found[0]?.message).toContain("'Removed'");
  });
});
