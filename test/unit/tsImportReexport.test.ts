import { describe, expect, it } from 'vitest';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { emptyGraph } from '../../src/core/symbolGraph.js';
import { indexTsFile } from '../../src/extractors/ts/index.js';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';
import type { SymbolGraph } from '../../src/core/types.js';

async function graphWith(files: Record<string, string>): Promise<SymbolGraph> {
  const g = emptyGraph();
  for (const [file, source] of Object.entries(files)) {
    await indexTsFile(file, source, g);
  }
  return g;
}

async function run(graph: SymbolGraph, testFile: string, testSource: string) {
  const { doubles } = await extractTsDoubles(testFile, testSource, 'typescript');
  return analyzeDoubles({
    doubles,
    graph,
    fileLines: new Map([[testFile, testSource.split('\n')]]),
    options: { strictness: 'all' },
  });
}

// Reproduces the reviewer's report: `src/db.ts` imports `query` from
// `./pg.js` and does not export it. `vi.spyOn(db, 'query')` is a broken
// test, and the tool has to say so rather than checking the stub against
// `src/pg.ts::query`, a module the test never mentioned.
describe('an import is not a re-export', () => {
  it('reports a ghost rather than drift on an imported, unexported name', async () => {
    const graph = await graphWith({
      'src/pg.ts': 'export function query(sql: string): number {\n  return 1;\n}\n',
      'src/db.ts': "import { query } from './pg.js';\nexport const DB_NAME = 'db';\n",
    });
    const found = await run(
      graph,
      'tests/db.test.ts',
      "import * as db from '../src/db.js';\nvi.spyOn(db, 'query');\n",
    );
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.target).toBe('src/db.ts::query');
  });

  it('delegates to the defining module when the name is re-exported after being imported', async () => {
    const graph = await graphWith({
      'src/pg.ts': 'export function query(sql: string): number {\n  return 1;\n}\n',
      'src/db.ts': "import { query } from './pg.js';\nexport { query };\n",
    });
    const found = await run(
      graph,
      'tests/db.test.ts',
      "import * as db from '../src/db.js';\nvi.spyOn(db, 'query').mockReturnValue('x');\n",
    );
    expect(found[0]?.type).toBe('RETURN_DRIFT');
    expect(found[0]?.target).toBe('src/pg.ts::query');
  });

  it('delegates to the defining module for a re-export with a source specifier', async () => {
    const graph = await graphWith({
      'src/pg.ts': 'export function query(sql: string): number {\n  return 1;\n}\n',
      'src/db.ts': "export { query } from './pg.js';\n",
    });
    const found = await run(
      graph,
      'tests/db.test.ts',
      "import * as db from '../src/db.js';\nvi.spyOn(db, 'query').mockReturnValue('x');\n",
    );
    expect(found[0]?.type).toBe('RETURN_DRIFT');
    expect(found[0]?.target).toBe('src/pg.ts::query');
  });
});
