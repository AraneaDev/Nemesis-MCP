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

describe('object literal returns checked against declared fields', () => {
  async function run(iface: string, literal: string) {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const graph = emptyGraph();
    await indexTsFile(
      'src/svc.ts',
      `${iface}\nexport class Svc { getUser(): User { return null as never; } }`,
      graph,
    );
    return analyzeDoubles({
      doubles: [
        {
          framework: 'vi.spyOn',
          language: 'typescript',
          file: 'tests/a.test.ts',
          line: 3,
          targetSymbol: 'Svc',
          method: 'getUser',
          methods: [{ name: 'getUser', line: 3 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: literal,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/a.test.ts', ['', '', '', '']]]),
      options: { strictness: 'all' },
    });
  }

  const USER = 'export interface User { id: string; name: string; email?: string; }';

  it('accepts a literal carrying every required field', async () => {
    expect(await run(USER, "{ id: '1', name: 'a' }")).toEqual([]);
    expect(await run(USER, "{ id: '1', name: 'a', email: 'e' }")).toEqual([]);
  });

  it('reports each missing required field separately', async () => {
    // A mock returning `{ id }` where the code reads `.name` is a stale double
    // that shape-level checking cannot see.
    const found = await run(USER, "{ id: '1' }");
    expect(found.map((f) => f.message)).toEqual([
      "Stub returns an object missing required field 'name' of User.",
    ]);
  });

  it('reports a field that does not exist, with a suggestion', async () => {
    const found = await run(USER, "{ id: '1', name: 'a', emial: 'e' }");
    const unknown = found.find((f) => f.message.includes('does not exist'));
    expect(unknown?.confidence).toBe('warning');
    expect(unknown?.suggestion).toBe('email');
  });

  it('says nothing when the literal spreads another value', async () => {
    expect(await run(USER, "{ ...base, id: '1' }")).toEqual([]);
  });

  it('says nothing when the declared type has no known fields', async () => {
    expect(await run('export type User = Record<string, string>;', "{ id: '1' }")).toEqual([]);
  });
});

describe('optional and defaulted parameters', () => {
  async function paramsFor(source: string, method: string) {
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const { resolveType } = await import('../../src/core/symbolGraph.js');
    const graph = emptyGraph();
    await indexTsFile('src/a.ts', source, graph);
    return resolveType(graph, 'E', { language: 'typescript' })?.methods.get(method)?.params ?? [];
  }

  it('treats a question mark as optional even without a default', async () => {
    // Requiring the `=` counted every optional parameter as mandatory, and a
    // correct call was reported as passing too few arguments.
    const params = await paramsFor(
      'export class E { go(a: string, b?: string, c: number = 1) {} }',
      'go',
    );
    expect(params.map((p) => p.hasDefault)).toEqual([false, true, true]);
  });

  it('reads a JavaScript default parameter', async () => {
    const params = await paramsFor('export class E { go(a, b = 1) {} }', 'go');
    expect(params.map((p) => p.hasDefault)).toEqual([false, true]);
  });
});

describe('class heritage', () => {
  async function typeIn(source: string, name: string) {
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const { resolveType } = await import('../../src/core/symbolGraph.js');
    const graph = emptyGraph();
    await indexTsFile('src/a.ts', source, graph);
    return { graph, type: resolveType(graph, name, { language: 'typescript' }) };
  }

  it('records what a class extends and implements', async () => {
    const { type } = await typeIn('export class C extends B implements I, J {}', 'C');
    expect(type?.extends).toEqual(['B']);
    expect(type?.implements).toEqual(['I', 'J']);
  });

  it('strips generics and namespaces from a heritage entry', async () => {
    const { type } = await typeIn('export class C extends ns.Base<Item> {}', 'C');
    expect(type?.extends).toEqual(['Base']);
  });

  it('records what an interface extends', async () => {
    const { type } = await typeIn('export interface I extends J, K {}', 'I');
    expect(type?.extends).toEqual(['J', 'K']);
  });

  it('inherits a member from a base class in the graph', async () => {
    const { resolveMember } = await import('../../src/core/symbolGraph.js');
    const { graph, type } = await typeIn(
      'export class Base { shared(): void {} }\nexport class C extends Base { own(): void {} }',
      'C',
    );
    expect(resolveMember(graph, type!, 'shared')).not.toBeNull();
  });

  it('marks a base outside the scanned tree as unknowable', async () => {
    // `class X extends EventEmitter` must not report every inherited member
    // as a definite ghost.
    const { hasUnresolvedAncestor } = await import('../../src/core/symbolGraph.js');
    const { graph, type } = await typeIn('export class C extends EventEmitter {}', 'C');
    expect(hasUnresolvedAncestor(graph, type!)).toBe(true);
  });
});

describe('literal arguments checked against parameter types', () => {
  async function run(signature: string, args: string[]) {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const graph = emptyGraph();
    await indexTsFile('src/svc.ts', `export class Svc { ${signature} }`, graph);
    return analyzeDoubles({
      doubles: [
        {
          framework: 'vi.spyOn',
          language: 'typescript',
          file: 'tests/a.test.ts',
          line: 3,
          targetSymbol: 'Svc',
          method: 'post',
          methods: [{ name: 'post', line: 3 }],
          withArity: args.length,
          withArgs: args,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/a.test.ts', ['', '', '', '']]]),
      options: { strictness: 'all' },
    }).filter((f) => f.message.startsWith('Argument'));
  }

  const SIG = 'post(amount: number, currency: string): boolean { return true; }';

  it('accepts arguments of the declared types', async () => {
    expect(await run(SIG, ['10', "'eur'"])).toEqual([]);
  });

  it('reports each argument whose literal type is wrong', async () => {
    // The parameters were reordered in production and the assertion was not.
    const found = await run(SIG, ["'eur'", '10']);
    expect(found.map((f) => f.message)).toEqual([
      "Argument 1 is 'string' but Svc::post declares 'amount' as 'number'.",
      "Argument 2 is 'number' but Svc::post declares 'currency' as 'string'.",
    ]);
  });

  it('says nothing about an argument that is not a literal', async () => {
    // Variables and matchers carry no type we can read.
    expect(await run(SIG, ['someValue', 'expect.any(String)'])).toEqual([]);
  });

  it('says nothing about an untyped parameter', async () => {
    expect(await run('post(amount: any, currency: unknown) {}', ["'eur'", '10'])).toEqual([]);
  });

  it('stops at a variadic parameter', async () => {
    expect(await run('post(...parts: string[]) {}', ['1', '2'])).toEqual([]);
  });

  it('ignores arguments beyond the declared list', async () => {
    expect(await run('post(amount: number) {}', ['10', "'extra'"])).toEqual([]);
  });

  it('accepts null for a nullable parameter', async () => {
    expect(await run('post(amount: number | null) {}', ['null'])).toEqual([]);
  });

  it('skips the check entirely when an argument is named', async () => {
    // A named argument is not positional, so the index says nothing.
    expect(await run(SIG, ['amount: 10', "currency: 'eur'"])).toEqual([]);
  });
});

describe('doubles that cannot exist at runtime', () => {
  async function run(source: string, method: string) {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexPhpFile } = await import('../../src/extractors/php/index.js');
    const graph = emptyGraph();
    await indexPhpFile('src/G.php', source, graph);
    return analyzeDoubles({
      doubles: [
        {
          framework: 'PHPUnit_MockObject',
          language: 'php',
          file: 'tests/GTest.php',
          line: 5,
          targetSymbol: 'App\\Gateway',
          method,
          methods: [{ name: method, line: 6 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/GTest.php', ['', '', '', '', '', '', '']]]),
      options: { strictness: 'all' },
    });
  }

  const FINAL_CLASS =
    '<?php namespace App; final class Gateway { public function charge(int $c): bool {} }';
  const MIXED =
    '<?php namespace App; class Gateway { public function charge(int $c): bool {} final public function seal(): bool {} public static function make(): self {} }';

  it('reports a final class, because no subclass can be generated for it', async () => {
    const found = await run(FINAL_CLASS, 'charge');
    expect(found.map((f) => f.message)).toContain(
      "'App\\Gateway' is final, so it cannot be doubled; this mock fails when the test runs.",
    );
    expect(found[0]?.confidence).toBe('definite');
  });

  it('reports a final method as un-overridable', async () => {
    const found = await run(MIXED, 'seal');
    expect(found.map((f) => f.message)).toContain(
      "Method 'seal' is final on 'App\\Gateway', so a double cannot override it.",
    );
  });

  it('warns that an instance double does not intercept a static method', async () => {
    const found = await run(MIXED, 'make');
    const hit = found.find((f) => f.message.includes('is static'));
    expect(hit?.confidence).toBe('warning');
  });

  it('says nothing about an ordinary method on an ordinary class', async () => {
    expect(await run(MIXED, 'charge')).toEqual([]);
  });

  it('names a final class once even when several members are stubbed', async () => {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexPhpFile } = await import('../../src/extractors/php/index.js');
    const graph = emptyGraph();
    await indexPhpFile(
      'src/G.php',
      '<?php namespace App; final class Gateway { public function a(): bool {} public function b(): bool {} }',
      graph,
    );
    const double = (method: string, line: number) => ({
      framework: 'PHPUnit_MockObject',
      language: 'php' as const,
      file: 'tests/GTest.php',
      line,
      targetSymbol: 'App\\Gateway',
      method,
      methods: [{ name: method, line }],
      withArity: null,
      assertedArity: null,
      returnTypeHint: null,
      returnExpr: null,
      confidence: 'definite' as const,
    });
    const found = analyzeDoubles({
      doubles: [double('a', 5), double('b', 6)],
      graph,
      fileLines: new Map([['tests/GTest.php', ['', '', '', '', '', '', '']]]),
      options: { strictness: 'all' },
    });
    expect(found.filter((f) => f.message.includes('is final, so it cannot'))).toHaveLength(1);
  });
});

describe('contracts about the shape of a call', () => {
  async function tsRun(
    source: string,
    double: Partial<Record<string, unknown>> & { method: string },
  ) {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const graph = emptyGraph();
    await indexTsFile('src/svc.ts', source, graph);
    return analyzeDoubles({
      doubles: [
        {
          framework: 'vi.spyOn',
          language: 'typescript',
          file: 'tests/a.test.ts',
          line: 3,
          targetSymbol: 'Svc',
          methods: [{ name: double.method, line: 3 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
          ...double,
        } as never,
      ],
      graph,
      fileLines: new Map([['tests/a.test.ts', ['', '', '', '']]]),
      options: { strictness: 'all' },
    });
  }

  describe('a stub that believes the method is async', () => {
    const SRC =
      'export class Svc { sync(): string { return "x"; } async job(): Promise<string> { return "x"; } }';

    it('reports a resolved value on a method that is not awaitable', async () => {
      // The types line up because the lattice unwraps a promise, so nothing
      // else here notices that the caller now receives one.
      const found = await tsRun(SRC, { method: 'sync', resolvedReturn: true });
      expect(found.map((f) => f.message)).toContain(
        "Stub resolves a value but Svc::sync returns 'string', which is not awaitable.",
      );
    });

    it('says nothing when the method really is awaitable', async () => {
      expect(await tsRun(SRC, { method: 'job', resolvedReturn: true })).toEqual([]);
    });

    it('says nothing when the return type is unknown', async () => {
      const found = await tsRun('export class Svc { sync() {} }', {
        method: 'sync',
        resolvedReturn: true,
      });
      expect(found).toEqual([]);
    });
  });

  describe('a stub that believes the method is fluent', () => {
    async function phpRun(source: string, method: string) {
      const { analyzeDoubles } = await import('../../src/core/analyzer.js');
      const { indexPhpFile } = await import('../../src/extractors/php/index.js');
      const graph = emptyGraph();
      await indexPhpFile('src/Q.php', source, graph);
      return analyzeDoubles({
        doubles: [
          {
            framework: 'PHPUnit_MockObject',
            language: 'php',
            file: 'tests/QTest.php',
            line: 3,
            targetSymbol: 'App\\Query',
            method,
            methods: [{ name: method, line: 3 }],
            withArity: null,
            assertedArity: null,
            returnTypeHint: null,
            returnExpr: null,
            returnsSelf: true,
            confidence: 'definite',
          },
        ],
        graph,
        fileLines: new Map([['tests/QTest.php', ['', '', '', '']]]),
        options: { strictness: 'all' },
      });
    }

    const SRC =
      '<?php namespace App; class Query { public function where(string $c): void {} public function chain(): self {} public function me(): static {} public function named(): Query {} }';

    it('reports willReturnSelf on a method that returns nothing', async () => {
      expect((await phpRun(SRC, 'where')).map((f) => f.message)).toContain(
        "Stub returns the double itself but App\\Query::where returns 'void', so the method is not fluent.",
      );
    });

    it('accepts self, static and the class by name', async () => {
      for (const method of ['chain', 'me', 'named']) {
        expect(await phpRun(SRC, method), method).toEqual([]);
      }
    });
  });

  describe('an enum member that no longer exists', () => {
    const SRC =
      'export enum Status { Active = "a", Closed = "c" }\nexport class Svc { state(): Status { return Status.Active; } }';

    it('reports a removed member, with a suggestion', async () => {
      // A renamed case still parses and still type-checks against the enum.
      const found = await tsRun(SRC, { method: 'state', returnExpr: 'Status.Actve' });
      expect(found[0]?.message).toContain("has no member 'Actve'");
      expect(found[0]?.suggestion).toBe('Active');
    });

    it('accepts a member that is still there', async () => {
      expect(await tsRun(SRC, { method: 'state', returnExpr: 'Status.Closed' })).toEqual([]);
    });

    it('says nothing about a holder that is not an enum', async () => {
      const found = await tsRun(
        'export class Helper { static make(): string { return "x"; } }\nexport class Svc { state(): string { return "x"; } }',
        { method: 'state', returnExpr: 'Helper.missing' },
      );
      expect(found).toEqual([]);
    });
  });
});

describe('named and keyword arguments', () => {
  async function run(signature: string, args: string[], lang: 'php' | 'python' = 'php') {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const graph = emptyGraph();
    if (lang === 'php') {
      const { indexPhpFile } = await import('../../src/extractors/php/index.js');
      await indexPhpFile('src/G.php', `<?php namespace App; class Gateway { ${signature} }`, graph);
    } else {
      const { indexPythonFile } = await import('../../src/extractors/python/index.js');
      await indexPythonFile('src/g.py', `class Gateway:\n    ${signature}\n`, graph);
    }
    return analyzeDoubles({
      doubles: [
        {
          framework: 'double',
          language: lang,
          file: 'tests/t',
          line: 3,
          targetSymbol: lang === 'php' ? 'App\\Gateway' : 'Gateway',
          method: 'charge',
          methods: [{ name: 'charge', line: 3 }],
          withArity: args.length,
          withArgs: args,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/t', ['', '', '', '']]]),
      options: { strictness: 'all' },
    });
  }

  const PHP = 'public function charge(int $amount, string $currency): bool {}';
  const PY = 'def charge(self, amount: int, currency: str) -> bool: pass';

  it('accepts names that match the parameters', async () => {
    expect(await run(PHP, ['amount: 5', "currency: 'eur'"])).toEqual([]);
    expect(await run(PY, ['amount=5', "currency='eur'"], 'python')).toEqual([]);
  });

  it('reports a name that matches no parameter', async () => {
    // A renamed parameter leaves the keyword pointing at nothing, and the
    // argument count is still right so nothing else notices.
    const found = await run(PHP, ['cents: 5', "currency: 'eur'"]);
    expect(found.map((f) => f.message)).toEqual([
      "Argument named 'cents' does not match any parameter of App\\Gateway::charge.",
    ]);
  });

  it('suggests the parameter a near-miss was meant to be', async () => {
    const found = await run(PHP, ['ammount: 5', "currency: 'eur'"]);
    expect(found[0]?.suggestion).toBe('amount');
  });

  it('reports a python keyword the same way', async () => {
    const found = await run(PY, ["user='u'", "currency='eur'"], 'python');
    expect(found[0]?.message).toContain("Argument named 'user'");
  });

  it('says nothing when the method takes a variadic', async () => {
    // Any keyword could land in the variadic, so no name can be ruled out.
    expect(await run('public function charge(...$args) {}', ['cents: 5'])).toEqual([]);
  });

  it('does not treat a positional literal as a name', async () => {
    // `'eur'` and `5` carry no name; they go through the positional check.
    const found = await run(PHP, ['5', "'eur'"]);
    expect(found.filter((f) => f.message.startsWith('Argument named'))).toEqual([]);
  });
});

describe('accessors and members a framework cannot route through', () => {
  async function tsRun(source: string, method: string, accessType?: string) {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const graph = emptyGraph();
    await indexTsFile('src/svc.ts', source, graph);
    return analyzeDoubles({
      doubles: [
        {
          framework: 'vi.spyOn',
          language: 'typescript',
          file: 'tests/a.test.ts',
          line: 3,
          targetSymbol: 'Svc',
          method,
          methods: [{ name: method, line: 3 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
          ...(accessType ? { accessType } : {}),
        },
      ],
      graph,
      fileLines: new Map([['tests/a.test.ts', ['', '', '', '']]]),
      options: { strictness: 'all' },
    });
  }

  const ACCESSORS =
    'export class Svc { get label(): string { return "x"; } set label(v: string) {} run(): boolean { return true; } }';

  it('reports spying on a getter without an access type', async () => {
    const found = await tsRun(ACCESSORS, 'label');
    expect(found.map((f) => f.message)).toContain(
      "'label' is a getter on 'Svc', so spying on it needs an access type such as 'get'.",
    );
  });

  it('accepts the spy when the access type is given', async () => {
    expect(await tsRun(ACCESSORS, 'label', 'get')).toEqual([]);
  });

  it('says nothing about an ordinary method', async () => {
    expect(await tsRun(ACCESSORS, 'run')).toEqual([]);
  });

  it('prefers the getter over the setter of the same name', async () => {
    // The setter's single parameter was being read as the member's arity.
    const { indexTsFile } = await import('../../src/extractors/ts/index.js');
    const { resolveType } = await import('../../src/core/symbolGraph.js');
    const graph = emptyGraph();
    await indexTsFile('src/svc.ts', ACCESSORS, graph);
    const label = resolveType(graph, 'Svc', { language: 'typescript' })?.methods.get('label');
    expect(label?.params).toHaveLength(0);
    expect(label?.returnType).toBe('string');
    expect(label?.modifiers).toEqual(['get']);
  });

  it('reports a stubbed PHP constructor', async () => {
    const { analyzeDoubles } = await import('../../src/core/analyzer.js');
    const { indexPhpFile } = await import('../../src/extractors/php/index.js');
    const graph = emptyGraph();
    await indexPhpFile(
      'src/G.php',
      '<?php namespace App; class Gateway { public function __construct(string $k) {} }',
      graph,
    );
    const found = analyzeDoubles({
      doubles: [
        {
          framework: 'PHPUnit_MockObject',
          language: 'php',
          file: 'tests/GTest.php',
          line: 3,
          targetSymbol: 'App\\Gateway',
          method: '__construct',
          methods: [{ name: '__construct', line: 3 }],
          withArity: null,
          assertedArity: null,
          returnTypeHint: null,
          returnExpr: null,
          confidence: 'definite',
        },
      ],
      graph,
      fileLines: new Map([['tests/GTest.php', ['', '', '', '']]]),
      options: { strictness: 'all' },
    });
    expect(found.map((f) => f.message)).toContain(
      "'__construct' cannot be stubbed on a double of 'App\\Gateway'; the framework never routes through it.",
    );
  });
});
