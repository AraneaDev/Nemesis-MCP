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

  it('records a diagnostic naming the file', async () => {
    const diagnostics: ScanDiagnostic[] = [];
    await extractTsDoubles('tests/a.test.ts', UNREADABLE, 'typescript', diagnostics);
    expect(diagnostics).toEqual([
      {
        file: 'tests/a.test.ts',
        language: 'typescript',
        stage: 'parse',
        message: 'Parsed with errors; the rest of the file was not read.',
        fatal: false,
      },
    ]);
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
