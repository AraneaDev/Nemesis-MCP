import { describe, expect, it } from 'vitest';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import { resolveModule } from '../../src/core/moduleResolve.js';
import type { SymbolGraph, TsPathAlias, TypeSymbol } from '../../src/core/types.js';

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

  it('follows a relative specifier to an .mts or .cts file', () => {
    // Both are discovered and indexed, so a target pointing at one has to be
    // reachable from here as well.
    expect(resolveModule(graphWith('src/db.mts'), '../db', 'src/tests/a.test.ts')?.file).toBe(
      'src/db.mts',
    );
    expect(resolveModule(graphWith('src/db.cts'), '../db', 'src/tests/a.test.ts')?.file).toBe(
      'src/db.cts',
    );
    expect(
      resolveModule(graphWith('src/api/index.mts'), '../src/api', 'tests/a.test.ts')?.file,
    ).toBe('src/api/index.mts');
  });

  it('says nothing about a package specifier', () => {
    const g = graphWith('src/db.ts');
    expect(resolveModule(g, 'some-package', 'tests/a.test.ts')).toBeNull();
  });
});

describe('TypeScript path aliases', () => {
  function alias(
    rule: Partial<TsPathAlias> & Pick<TsPathAlias, 'prefix' | 'targets'>,
  ): TsPathAlias {
    return { configDir: '.', suffix: '', exact: false, ...rule };
  }

  it('resolves "@/services/x" through "@/*": ["./src/*"] to src/services/x.ts', () => {
    const g = graphWith('src/services/admin.service.ts');
    g.tsPathAliases = [alias({ prefix: '@/', targets: ['src/*'] })];
    expect(resolveModule(g, '@/services/admin.service', 'tests/a.test.ts')?.file).toBe(
      'src/services/admin.service.ts',
    );
  });

  it('resolves an alias in a nested tsconfig relative to that directory', () => {
    // frontend/tsconfig.json declares "@/*": ["./src/*"], relative to
    // frontend/, not the repository root.
    const g = graphWith('frontend/src/services/auth.service.ts', 'backend/src/auth.service.ts');
    g.tsPathAliases = [alias({ configDir: 'frontend', prefix: '@/', targets: ['frontend/src/*'] })];
    expect(
      resolveModule(g, '@/services/auth.service', 'frontend/tests/unit/authStore.test.ts')?.file,
    ).toBe('frontend/src/services/auth.service.ts');
    // A file outside frontend/ is not covered by frontend's tsconfig, so the
    // same alias specifier resolves to nothing from there.
    expect(resolveModule(g, '@/services/auth.service', 'backend/tests/t.test.ts')).toBeNull();
  });

  it('resolves to nothing when the alias maps to two targets', () => {
    const g = graphWith('src/services/admin.service.ts');
    g.tsPathAliases = [alias({ prefix: '@/', targets: ['src/*', 'legacy/*'] })];
    expect(resolveModule(g, '@/services/admin.service', 'tests/a.test.ts')).toBeNull();
  });

  it('resolves to nothing when the alias matches no scanned file', () => {
    const g = graphWith('src/services/admin.service.ts');
    g.tsPathAliases = [alias({ prefix: '@/', targets: ['src/*'] })];
    expect(resolveModule(g, '@/services/deleted-service', 'tests/a.test.ts')).toBeNull();
  });

  it('prefers an exact alias over a wildcard one that also matches', () => {
    // "@app/special": ["src/special-handler"] alongside "@app/*": ["src/*"].
    // TypeScript matches the exact key first; falling through to the
    // wildcard rule (declaration order, previously) would have resolved
    // this to src/special.ts instead of src/special-handler.ts.
    const g = graphWith('src/special.ts', 'src/special-handler.ts');
    g.tsPathAliases = [
      alias({ prefix: '@app/', targets: ['src/*'] }),
      alias({ prefix: '@app/special', exact: true, targets: ['src/special-handler'] }),
    ];
    expect(resolveModule(g, '@app/special', 'tests/a.test.ts')?.file).toBe(
      'src/special-handler.ts',
    );
  });

  it('does not fall through to a less specific wildcard when the exact match does not resolve', () => {
    const g = graphWith('src/special.ts');
    g.tsPathAliases = [
      alias({ prefix: '@app/*', targets: ['src/*'] }),
      alias({ prefix: '@app/special', exact: true, targets: ['src/nowhere'] }),
    ];
    // The exact rule wins selection but its own target is not scanned, so
    // this must stay null rather than falling back to "@app/*".
    expect(resolveModule(g, '@app/special', 'tests/a.test.ts')).toBeNull();
  });

  it('picks the wildcard rule with the longest prefix among several that match', () => {
    // Both "@app/*" and "@app/sub/*" match "@app/sub/thing"; TypeScript
    // picks the more specific one, "@app/sub/*". Deliberately points the
    // less specific rule somewhere this target does NOT live, so a wrong
    // selection (or a fall-through to it) would resolve to nothing instead
    // of quietly landing on the right file for the wrong reason.
    const g = graphWith('src/sub/thing.ts');
    g.tsPathAliases = [
      alias({ prefix: '@app/', targets: ['other/*'] }),
      alias({ prefix: '@app/sub/', targets: ['src/sub/*'] }),
    ];
    expect(resolveModule(g, '@app/sub/thing', 'tests/a.test.ts')?.file).toBe('src/sub/thing.ts');
  });
});
