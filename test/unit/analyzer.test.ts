import { describe, expect, it } from 'vitest';
import { bothNominal, inferType, typesCompatible } from '../../src/core/analyzer.js';
import { addType, emptyGraph } from '../../src/core/symbolGraph.js';
import type { SymbolGraph } from '../../src/core/types.js';

function emptyGraphWithService(): SymbolGraph {
  const g = emptyGraph();
  addType(g, {
    name: 'App\\Service',
    file: 'src/Service.php',
    kind: 'class',
    methods: new Map([
      ['run', { name: 'run', returnType: null, params: [], visibility: 'public', line: 1 }],
    ]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  return g;
}

describe('type compatibility', () => {
  it('accepts identical types', () => {
    expect(typesCompatible('UserProfile', 'UserProfile', 'typescript')).toBe(true);
  });

  it('unwraps Promise on the declared side (mockResolvedValue)', () => {
    expect(typesCompatible("'x'", 'Promise<UserProfile>', 'typescript')).toBe(false);
    expect(typesCompatible('UserProfile', 'Promise<UserProfile>', 'typescript')).toBe(true);
    expect(typesCompatible('true', 'Promise<boolean>', 'typescript')).toBe(true);
    expect(typesCompatible('[]', 'Promise<Item[]>', 'typescript')).toBe(true);
  });

  it('an object literal is assumed to satisfy a named type', () => {
    // Field-level structural checking is an explicit non-goal, so an object
    // literal stub is accepted rather than reported as unprovable drift.
    expect(typesCompatible("{ id: '1' }", 'UserProfile', 'typescript')).toBe(true);
    expect(typesCompatible("{ id: '1' }", 'Record<string, string>', 'typescript')).toBe(true);
  });

  it('primitive literals match their declared aliases across languages', () => {
    expect(typesCompatible('true', 'boolean', 'typescript')).toBe(true);
    expect(typesCompatible("'tok'", 'str', 'python')).toBe(true);
    expect(typesCompatible('None', 'None', 'python')).toBe(true);
    expect(typesCompatible('[]', 'array', 'php')).toBe(true);
    expect(typesCompatible('[]', 'iterable', 'php')).toBe(true);
  });

  it('array literals match array-shaped declared types', () => {
    expect(typesCompatible("['a']", 'string[]', 'typescript')).toBe(true);
    expect(typesCompatible("['a']", 'Array<string>', 'typescript')).toBe(true);
    expect(typesCompatible("['a']", 'list[str]', 'python')).toBe(true);
    expect(typesCompatible("['a']", 'List[str]', 'python')).toBe(true);
    expect(typesCompatible("{'a': 1}", 'list[str]', 'python')).toBe(false);
  });

  it('unions accept any member', () => {
    expect(typesCompatible('undefined', 'string | undefined', 'typescript')).toBe(true);
    expect(typesCompatible("'on'", "'on' | 'off'", 'typescript')).toBe(true);
    expect(typesCompatible('42', "'on' | 'off'", 'typescript')).toBe(false);
    expect(typesCompatible('None', 'Optional[str]', 'python')).toBe(true);
  });

  it('still reports genuine drift', () => {
    expect(typesCompatible("'x'", 'int', 'php')).toBe(false);
    expect(typesCompatible("'x'", 'CatalogItem', 'typescript')).toBe(false);
    expect(typesCompatible('true', 'string', 'typescript')).toBe(false);
    expect(typesCompatible('Foo', 'Bar', 'typescript')).toBe(false);
  });

  it('string literal into string', () => {
    expect(typesCompatible("'x'", 'string', 'typescript')).toBe(true);
    expect(typesCompatible("'x'", 'int', 'php')).toBe(false);
  });

  it('numeric widening', () => {
    expect(typesCompatible('int', 'float', 'php')).toBe(true);
    expect(typesCompatible('42', 'int', 'typescript')).toBe(true);
  });

  it('null into nullable types', () => {
    expect(typesCompatible('null', '?int', 'php')).toBe(true);
    expect(typesCompatible('null', 'int', 'php')).toBe(false);
  });

  it('undefined into void', () => {
    expect(typesCompatible('undefined', 'void', 'typescript')).toBe(true);
  });

  it('mixed/any declared types accept anything', () => {
    expect(typesCompatible('whatever', 'mixed', 'php')).toBe(true);
    expect(typesCompatible('42', 'any', 'typescript')).toBe(true);
  });

  it('as any is treated as untyped and compatible', () => {
    expect(typesCompatible('any', 'UserProfile', 'typescript')).toBe(true);
  });
});

describe('inferType', () => {
  it('infers literals', () => {
    expect(inferType("'s'", 'php')).toBe('string');
    expect(inferType('42', 'php')).toBe('int');
    expect(inferType('42', 'typescript')).toBe('number');
    expect(inferType('true', 'php')).toBe('bool');
    expect(inferType('null', 'php')).toBe('null');
    expect(inferType('undefined', 'typescript')).toBe('undefined');
  });

  it('does not guess for identifiers', () => {
    expect(inferType('someVariable', 'typescript')).toBeNull();
  });

  it('infers new expressions', () => {
    expect(inferType('new App\\User()', 'php')).toBe('App\\User');
  });
});

describe('unresolvable named types', () => {
  it('accepts a named stub against a container-shaped declared type', () => {
    // `Illuminate\Database\Eloquent\Collection`, imported as
    // `EloquentCollection`, extends `Illuminate\Support\Collection` — but the
    // base class lives in vendor/, which is never walked.
    expect(typesCompatible('EloquentCollection', 'Collection', 'php')).toBe(true);
    expect(typesCompatible('MyCollection', 'iterable', 'php')).toBe(true);
  });

  it('still reports a named stub clashing with a primitive', () => {
    expect(typesCompatible('EloquentCollection', 'string', 'php')).toBe(false);
    expect(typesCompatible('Invoice', 'int', 'php')).toBe(false);
  });

  it('flags two differing named types as unprovable, not definite', () => {
    expect(bothNominal('Invoice', 'Receipt')).toBe(true);
    expect(bothNominal('UserProfile', 'UserProfile')).toBe(true);
  });

  it('does not downgrade a primitive against a named type', () => {
    expect(bothNominal('string', 'CatalogItem')).toBe(false);
    expect(bothNominal('int', 'Invoice')).toBe(false);
  });
});

describe('dynamic method names', () => {
  it('are never reported as ghost methods', async () => {
    // `$mock->shouldReceive($method)` inside a foreach names no literal member.
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const graph = emptyGraphWithService();
    const findings = analyzeDoubles({
      doubles: [
        {
          framework: 'Mockery',
          language: 'php',
          file: 'tests/ServiceTest.php',
          line: 10,
          targetSymbol: 'App\\Service',
          method: '$method',
          methods: [{ name: '$method', line: 10 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/ServiceTest.php', ['', '']]]),
      options: { strictness: 'all' },
    });
    expect(findings).toEqual([]);
  });

  it('still reports a literal method name', async () => {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const graph = emptyGraphWithService();
    const findings = analyzeDoubles({
      doubles: [
        {
          framework: 'Mockery',
          language: 'php',
          file: 'tests/ServiceTest.php',
          line: 10,
          targetSymbol: 'App\\Service',
          method: 'nope',
          methods: [{ name: 'nope', line: 10 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/ServiceTest.php', ['', '']]]),
      options: { strictness: 'all' },
    });
    expect(findings.map((f) => f.type)).toEqual(['GHOST_METHOD']);
  });
});
