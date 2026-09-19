import { describe, expect, it } from 'vitest';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import { resolveModule } from '../../src/core/moduleResolve.js';
import type { SymbolGraph, TypeSymbol } from '../../src/core/types.js';

function mod(file: string): TypeSymbol {
  return {
    name: file,
    file,
    kind: 'module',
    methods: new Map(),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

function graphWith(...files: string[]): SymbolGraph {
  const g = emptyGraph();
  for (const f of files) addModule(g, mod(f));
  return g;
}

describe('finding the module a target names', () => {
  it('matches a dotted path against the tail of a file path', () => {
    const g = graphWith('backend/core/system/subprocess_runner.py');
    expect(resolveModule(g, 'core.system.subprocess_runner', 'backend/tests/t.py')?.file).toBe(
      'backend/core/system/subprocess_runner.py',
    );
  });

  it('matches a dotted path that is the whole path', () => {
    const g = graphWith('services/files_service.py');
    expect(resolveModule(g, 'services.files_service', 'tests/t.py')?.file).toBe(
      'services/files_service.py',
    );
  });

  it('says nothing when two files match the same suffix', () => {
    // A rule that picks a winner among several is a rule that guesses.
    const g = graphWith('pkg_a/utils/helpers.py', 'pkg_b/utils/helpers.py');
    expect(resolveModule(g, 'utils.helpers', 'tests/t.py')).toBeNull();
  });

  it('says nothing when nothing matches', () => {
    const g = graphWith('backend/core/system/subprocess_runner.py');
    expect(resolveModule(g, 'os.path', 'backend/tests/t.py')).toBeNull();
  });

  it('does not match a partial segment', () => {
    // `runner` must not match `subprocess_runner`.
    const g = graphWith('core/system/subprocess_runner.py');
    expect(resolveModule(g, 'system.runner', 'tests/t.py')).toBeNull();
  });

  it('follows a relative specifier, including the .js that means .ts', () => {
    const g = graphWith('src/db.ts');
    expect(resolveModule(g, '../db.js', 'src/tests/health.test.ts')?.file).toBe('src/db.ts');
    expect(resolveModule(g, '../db', 'src/tests/health.test.ts')?.file).toBe('src/db.ts');
  });

  it('follows a relative specifier to an index file', () => {
    const g = graphWith('src/api/index.ts');
    expect(resolveModule(g, '../src/api', 'tests/a.test.ts')?.file).toBe('src/api/index.ts');
  });

  it('says nothing about a package specifier', () => {
    const g = graphWith('src/db.ts');
    expect(resolveModule(g, 'some-package', 'tests/a.test.ts')).toBeNull();
  });
});
