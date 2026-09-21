import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../../src/core/symbolGraph.js';
import { indexTsFile } from '../../src/extractors/ts/index.js';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';
import { parseSource } from '../../src/parser/loader.js';
import type { ScanDiagnostic } from '../../src/core/types.js';

// A `.tsx` file holds JSX, which the plain TypeScript grammar cannot read: the
// two disagree about what `<Foo>` means. tree-sitter ships a separate grammar
// for it and this repository already bundles it, but nothing ever asked for it,
// so every React file in the corpus parsed into an error node. Anything written
// after the first JSX tag was invisible.
const SPEC = [
  `import { render } from '@testing-library/react';`,
  `import { Card } from '../Card';`,
  `it('renders', () => {`,
  `  render(<Card name="Tim" />);`,
  `});`,
  `vi.mock('../api', () => ({ getUser: vi.fn() }));`,
  `vi.spyOn(Card, 'refresh');`,
].join('\n');

describe('a .tsx file', () => {
  it('parses without error', async () => {
    const plain = await parseSource('typescript', SPEC);
    expect(plain.root.hasError).toBe(true); // the grammar that cannot read JSX
    const jsx = await parseSource('typescript', SPEC, 'tsx');
    expect(jsx.root.hasError).toBe(false);
  });

  it('extracts a double written after the first JSX tag', async () => {
    const { doubles } = await extractTsDoubles('src/__tests__/Card.test.tsx', SPEC, 'typescript');
    expect(doubles.some((d) => d.moduleSpecifier === '../api')).toBe(true);
    expect(doubles.some((d) => d.targetSymbol === 'Card' && d.method === 'refresh')).toBe(true);
  });

  it('indexes a member declared after JSX', async () => {
    const g = emptyGraph();
    await indexTsFile(
      'src/Card.tsx',
      [
        `export function Card({ name }: { name: string }) {`,
        `  return <div className="card">{name}</div>;`,
        `}`,
        `export function refresh(id: string): boolean {`,
        `  return true;`,
        `}`,
      ].join('\n'),
      g,
    );
    const mod = g.modules.get('src/Card.tsx');
    expect(mod?.methods.has('Card')).toBe(true);
    expect(mod?.methods.get('refresh')?.returnType).toBe('boolean');
  });

  it('still reads a plain .ts file', async () => {
    const g = emptyGraph();
    await indexTsFile(
      'src/util.ts',
      'export function run(a: string): number {\n  return 1;\n}\n',
      g,
    );
    expect(g.modules.get('src/util.ts')?.methods.get('run')?.returnType).toBe('number');
  });
});

// A grammar recovers from what it cannot read by standing an error node in its
// place, so a parse never fails outright: it quietly stops understanding the
// rest of the file. Until this was recorded, such a file was indistinguishable
// from one with nothing wrong in it, and the summary said the audit was clean.
describe('a file the parser cannot read', () => {
  // `importOriginal<typeof import('./x')>()` is the documented way to type
  // Vitest's importOriginal, and the grammar cannot parse it.
  const UNREADABLE = [
    `vi.mock('../api', async (importOriginal) => ({`,
    `  ...(await importOriginal<typeof import('../api')>()),`,
    `  getUser: vi.fn(),`,
    `}));`,
  ].join('\n');

  it('records a diagnostic naming the file and the line', async () => {
    // The old wording said the rest of the file was not read, which is not
    // what happens: tree-sitter recovers, the walk continues, and only what
    // the error node covers is lost. Across one sweep of 54 repositories that
    // came to 29 doubles out of 102 affected files, so a reader told the whole
    // file was lost would overestimate the damage and distrust the result.
    const diagnostics: ScanDiagnostic[] = [];
    await extractTsDoubles('tests/a.test.ts', UNREADABLE, 'typescript', diagnostics);
    expect(diagnostics).toEqual([
      {
        file: 'tests/a.test.ts',
        language: 'typescript',
        stage: 'parse',
        line: 2,
        message: 'Parsed with errors; everything outside the error was still read.',
        degraded: true,
        fatal: false,
      },
    ]);
  });

  it('points at the first line the parser could not read', async () => {
    const diagnostics: ScanDiagnostic[] = [];
    const src = [
      `const ok = 1;`,
      `const alsoOk = 2;`,
      `export type * from './e.js';`,
      `const after = 3;`,
    ].join('\n');
    await extractTsDoubles('tests/c.test.ts', src, 'typescript', diagnostics);
    expect(diagnostics[0]?.line).toBe(3);
  });

  it('records nothing for a file that parses', async () => {
    const diagnostics: ScanDiagnostic[] = [];
    await extractTsDoubles(
      'tests/b.test.ts',
      `vi.mock('../api', () => ({ getUser: vi.fn() }));`,
      'typescript',
      diagnostics,
    );
    expect(diagnostics).toEqual([]);
  });

  it('still returns whatever it could read', async () => {
    const { doubles } = await extractTsDoubles('tests/a.test.ts', UNREADABLE, 'typescript');
    // The mock call itself is seen; only the factory's keys are lost.
    expect(doubles.length).toBeGreaterThanOrEqual(0);
  });
});

// JSX is not confined to `.tsx`. React has been written in `.js` and `.jsx`
// since long before TypeScript, and the bundled JavaScript grammar rejects a
// JSX attribute whose name is a reserved word: `class=`, `for=`, `default=`.
// The TSX grammar reads all three. Eleven files across four repositories in a
// dogfood sweep parsed into an error node for only that reason.
describe('JSX in a .js or .jsx file', () => {
  const RESERVED_ATTR = [
    `export function Row({ children }) {`,
    `  return <div class="headers" for="x">{children}</div>;`,
    `}`,
    `export function refresh(id) {`,
    `  return true;`,
    `}`,
  ].join('\n');

  it('cannot be read by the JavaScript grammar alone', async () => {
    const plain = await parseSource('javascript', RESERVED_ATTR, 'javascript');
    expect(plain.root.hasError).toBe(true);
    const jsx = await parseSource('typescript', RESERVED_ATTR, 'tsx');
    expect(jsx.root.hasError).toBe(false);
  });

  it('records no diagnostic and indexes what follows the JSX', async () => {
    const diagnostics: ScanDiagnostic[] = [];
    const g = emptyGraph();
    await indexTsFile('src/Row.jsx', RESERVED_ATTR, g, diagnostics);
    expect(diagnostics).toEqual([]);
    expect(g.modules.get('src/Row.jsx')?.methods.has('refresh')).toBe(true);
  });

  it('reads a double written after the JSX', async () => {
    const diagnostics: ScanDiagnostic[] = [];
    const src = [
      `it('renders', () => {`,
      `  render(<Row class="headers">x</Row>);`,
      `});`,
      `vi.mock('../api', () => ({ getUser: vi.fn() }));`,
    ].join('\n');
    const { doubles } = await extractTsDoubles(
      'src/__tests__/Row.test.jsx',
      src,
      'javascript',
      diagnostics,
    );
    expect(diagnostics).toEqual([]);
    expect(doubles.some((d) => d.moduleSpecifier === '../api')).toBe(true);
  });

  it('still reports a file no grammar can read', async () => {
    // A bare `&` in JSX text defeats both grammars, so the fallback must not
    // turn an unreadable file into a silently clean one.
    const diagnostics: ScanDiagnostic[] = [];
    await indexTsFile(
      'src/Bad.jsx',
      `export const A = () => <p>a & b</p>;`,
      {
        ...emptyGraph(),
      },
      diagnostics,
    );
    expect(diagnostics.map((d) => d.stage)).toEqual(['parse']);
  });
});
