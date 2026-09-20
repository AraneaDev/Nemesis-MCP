import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { emptyGraph } from '../../src/core/symbolGraph.js';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';

async function run(source: string, exports: Set<string> | null | undefined) {
  const graph = emptyGraph();
  if (exports !== undefined) graph.exportsByFile.set('src/api.ts', exports);
  const { doubles } = await extractTsDoubles('tests/api.test.ts', source, 'typescript');
  return analyzeDoubles({
    doubles,
    graph,
    fileLines: new Map([['tests/api.test.ts', source.split('\n')]]),
    options: { strictness: 'all' },
  });
}

const EXPORTS = new Set(['fetchUser', 'saveUser', 'default']);

describe('a module replaced wholesale', () => {
  it('reports a key the module does not export', async () => {
    const found = await run(
      `vi.mock('../src/api', () => ({ fetchUser: vi.fn(), getUser: vi.fn() }));`,
      EXPORTS,
    );
    expect(found[0]?.message).toContain("supplies 'getUser', which that module does not export");
  });

  it('accepts a partial factory of real exports', async () => {
    expect(await run(`vi.mock('../src/api', () => ({ saveUser: vi.fn() }));`, EXPORTS)).toEqual([]);
  });

  it('always accepts a default key', async () => {
    expect(await run(`vi.mock('../src/api', () => ({ default: vi.fn() }));`, EXPORTS)).toEqual([]);
  });

  it('says nothing about a factory that spreads the original', async () => {
    // The rest of the shape came from the module itself, so the literal is
    // not a list of what the test believes the module exports.
    const source = [
      `vi.mock('../src/api', async (importOriginal) => ({`,
      `  ...(await importOriginal()),`,
      `  getUser: vi.fn(),`,
      `}));`,
    ].join('\n');
    expect(await run(source, EXPORTS)).toEqual([]);
  });

  it('says nothing about a computed key', async () => {
    expect(await run(`vi.mock('../src/api', () => ({ [name]: vi.fn() }));`, EXPORTS)).toEqual([]);
  });

  it('says nothing about a package, a bare mock, or a file it never read', async () => {
    expect(await run(`vi.mock('some-package', () => ({ anything: vi.fn() }));`, EXPORTS)).toEqual(
      [],
    );
    expect(await run(`vi.mock('../src/api');`, EXPORTS)).toEqual([]);
    expect(await run(`vi.mock('../src/api', () => ({ getUser: vi.fn() }));`, undefined)).toEqual(
      [],
    );
  });

  it('says nothing about a module that re-exports everything', async () => {
    expect(await run(`vi.mock('../src/api', () => ({ getUser: vi.fn() }));`, null)).toEqual([]);
  });

  it('leaves the handles a fake adds for the test alone', async () => {
    // `__reset`, `__set`, `__esModule`: the ecosystem's mark for something the
    // fake carries for the test's own use, not a claim about the module.
    const source = `vi.mock('../src/api', () => ({ __reset: () => {}, __esModule: true }));`;
    expect(await run(source, EXPORTS)).toEqual([]);
  });

  it('reads a block-bodied factory', async () => {
    const source = [`vi.mock('../src/api', () => {`, `  return { getUser: vi.fn() };`, `});`].join(
      '\n',
    );
    expect((await run(source, EXPORTS))[0]?.type).toBe('GHOST_METHOD');
  });
});

describe('a manual mock in a __mocks__ directory', () => {
  async function mocks(
    real: Set<string> | null,
    fake: Set<string> | null,
    fakePath = 'src/__mocks__/api.ts',
  ) {
    const graph = emptyGraph();
    graph.exportsByFile.set('src/api.ts', real);
    graph.exportsByFile.set(fakePath, fake);
    return analyzeDoubles({
      doubles: [],
      graph,
      fileLines: new Map(),
      options: { strictness: 'all' },
    });
  }

  it('reports an export the real module does not have', async () => {
    const found = await mocks(new Set(['fetchUser']), new Set(['fetchUser', 'getUser']));
    expect(found[0]?.message).toContain("exports 'getUser', which 'src/api.ts' does not");
  });

  it('accepts a mock that covers only part of the module', async () => {
    // Exporting a subset is the point of a manual mock.
    expect(await mocks(new Set(['fetchUser', 'saveUser']), new Set(['fetchUser']))).toEqual([]);
  });

  it('says nothing about a package mock, which has no sibling file', async () => {
    const graph = emptyGraph();
    graph.exportsByFile.set('__mocks__/axios.ts', new Set(['get']));
    expect(
      analyzeDoubles({ doubles: [], graph, fileLines: new Map(), options: { strictness: 'all' } }),
    ).toEqual([]);
  });

  it('says nothing when either side re-exports everything', async () => {
    expect(await mocks(null, new Set(['getUser']))).toEqual([]);
    expect(await mocks(new Set(['fetchUser']), null)).toEqual([]);
  });

  it('leaves a default and the test-only handles alone', async () => {
    expect(
      await mocks(new Set(['fetchUser']), new Set(['fetchUser', 'default', '__reset'])),
    ).toEqual([]);
  });
});

describe('the values a module mock factory supplies', () => {
  it('reads an inline fake as a double on that member', async () => {
    const { doubles } = await extractTsDoubles(
      'tests/a.test.ts',
      `vi.mock('../src/api', () => ({ isEnabled: vi.fn(() => true) }));`,
      'typescript',
    );
    const member = doubles.find((d) => d.method === 'isEnabled');
    expect(member?.targetSymbol).toBe('../src/api');
    expect(member?.returnExpr).toBe('true');
  });

  it('reads a pinned return value off a factory value', async () => {
    const { doubles } = await extractTsDoubles(
      'tests/a.test.ts',
      `vi.mock('../src/api', () => ({ createTables: vi.fn().mockResolvedValue(undefined) }));`,
      'typescript',
    );
    const member = doubles.find((d) => d.method === 'createTables');
    expect(member?.resolvedReturn).toBe(true);
  });

  it('reads the parameters an inline fake declares', async () => {
    const { doubles } = await extractTsDoubles(
      'tests/a.test.ts',
      `vi.mock('../src/api', () => ({ send: vi.fn((to: string, subject: boolean) => true) }));`,
      'typescript',
    );
    const member = doubles.find((d) => d.method === 'send');
    expect(member?.fakeArity).toBe(2);
    expect(member?.fakeParamTypes).toEqual(['string', 'boolean']);
  });

  it('still reports a key the module does not export', async () => {
    // Check 28's behaviour must not regress.
    const found = await run(
      `vi.mock('../src/api', () => ({ fetchUser: vi.fn(), getUser: vi.fn() }));`,
      EXPORTS,
    );
    expect(found[0]?.message).toContain("supplies 'getUser', which that module does not export");
  });
});
