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

  it('ignores a binding that is not shaped like a type, without an export list', () => {
    // `export const sounds = new SoundManager()` is a value, absent from a
    // graph of types while very much present in the file. With no export list
    // for that file there is no way to tell the two apart.
    expect(run(['', "import { sounds } from '../src/svc';"], 'sounds', graphWith(KEPT))).toEqual(
      [],
    );
  });

  it('asks the export list about a value when the file has one', () => {
    const g = graphWith(KEPT);
    g.exportsByFile.set('src/svc.ts', new Set(['Kept', 'sounds']));
    expect(run(['', "import { sounds } from '../src/svc';"], 'sounds', g)).toEqual([]);
    const missing = run(['', "import { gone } from '../src/svc';"], 'gone', g);
    expect(missing[0]?.message).toContain("'gone' is imported from '../src/svc'");
  });

  it('says nothing about a file that re-exports with a star', () => {
    // Its names come from somewhere else, so its own list decides nothing.
    const g = graphWith(KEPT);
    g.exportsByFile.set('src/svc.ts', null);
    expect(run(['', "import { anything } from '../src/svc';"], 'anything', g)).toEqual([]);
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

describe('the export list a module publishes', () => {
  async function exportsOf(source: string): Promise<Set<string> | null | undefined> {
    const { emptyGraph } = await import('../../src/core/symbolGraph.js');
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const g = emptyGraph();
    await indexTsFile('src/mod.ts', source, g);
    return g.exportsByFile.get('src/mod.ts');
  }

  it('collects declarations, values and renamed bindings', async () => {
    const names = await exportsOf(
      [
        'export class A {}',
        'export interface B {}',
        'export enum C { x }',
        'export type D = string;',
        'export function f() {}',
        'export const sounds = 1, other = 2;',
        'const local = 1;',
        'export { local as renamed };',
        "export { thing } from './other';",
        'export default class Z {}',
      ].join('\n'),
    );
    expect([...(names ?? [])].sort()).toEqual(
      ['A', 'B', 'C', 'D', 'Z', 'default', 'f', 'other', 'renamed', 'sounds', 'thing'].sort(),
    );
  });

  it('gives up on a file that re-exports everything', async () => {
    expect(await exportsOf("export * from './everything';\nexport const a = 1;")).toBeNull();
  });

  it('gives up on a destructured export, whose names it cannot list', async () => {
    expect(await exportsOf('export const { a, b } = obj;')).toBeNull();
  });

  it('reads CommonJS, which is an export list too', async () => {
    const names = await exportsOf(
      ['function getPool() {}', 'const sql = 1;', 'module.exports = { getPool, sql };'].join('\n'),
    );
    expect([...(names ?? [])].sort()).toEqual(['getPool', 'sql']);
  });

  it('reads properties assigned onto exports', async () => {
    const names = await exportsOf('exports.one = 1;\nmodule.exports.two = 2;');
    expect([...(names ?? [])].sort()).toEqual(['one', 'two']);
  });

  it('gives up when module.exports is not a literal', async () => {
    expect(await exportsOf('module.exports = buildApi();')).toBeNull();
    expect(await exportsOf('module.exports = { ...base, extra: 1 };')).toBeNull();
  });

  it('gives up on a file that turned out to export nothing', async () => {
    // Either it is not a module, or it exports in a way this does not read.
    // Neither is evidence that a name is missing.
    expect(await exportsOf('const x = 1;')).toBeNull();
  });
});
