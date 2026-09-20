import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTsPathAliases, resolveModule } from '../../src/core/moduleResolve.js';
import { addModule, emptyGraph } from '../../src/core/symbolGraph.js';
import { runAudit } from '../../src/core/runtime.js';
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

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nemesis-tsconfig-'));
  await mkdir(path.join(root, 'frontend', 'src', 'services'), { recursive: true });
  await mkdir(path.join(root, 'frontend', 'tests'), { recursive: true });
  // JSONC: block and line comments, plus trailing commas. `JSON.parse` throws
  // on this verbatim, and a real tsconfig routinely looks exactly like it.
  await writeFile(
    path.join(root, 'frontend', 'tsconfig.json'),
    `{
  // bundler settings
  "compilerOptions": {
    "target": "ES2020",
    /* Path aliases */
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
    },
  },
  "include": ["src/**/*.ts"],
}
`,
  );
  await writeFile(
    path.join(root, 'frontend', 'src', 'services', 'admin.service.ts'),
    'export function getUsers(): number[] {\n  return [];\n}\n',
  );
  await writeFile(
    path.join(root, 'frontend', 'tests', 'admin.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import * as adminService from '@/services/admin.service';\n` +
      `vi.spyOn(adminService, 'getUsers').mockReturnValue([]);\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reading tsconfig.json off disk', () => {
  it('parses a tsconfig with comments and trailing commas instead of throwing', async () => {
    const rules = await loadTsPathAliases(root);
    expect(rules).toEqual([
      {
        configDir: 'frontend',
        prefix: '@/',
        suffix: '',
        targets: ['frontend/src/*'],
      },
    ]);
  });

  it('resolves through the parsed alias end to end during an audit', async () => {
    // The double targets `adminService.getUsers`, which is a real method, so
    // this proves the alias reached the file rather than merely parsing it.
    const result = await runAudit({ rootDir: root, strictness: 'all', languages: ['typescript'] });
    expect(result.summary.doubles_checked).toBe(1);
    expect(result.summary.doubles_unresolved).toBe(0);
    expect(result.summary.violations_count).toBe(0);
  });

  it('says nothing when no tsconfig.json exists', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'nemesis-no-tsconfig-'));
    try {
      expect(await loadTsPathAliases(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('treats an unparsable tsconfig as no aliases rather than throwing', async () => {
    const broken = await mkdtemp(path.join(tmpdir(), 'nemesis-broken-tsconfig-'));
    try {
      await writeFile(path.join(broken, 'tsconfig.json'), '{ this is not json at all');
      await expect(loadTsPathAliases(broken)).resolves.toEqual([]);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe('extends: inherited baseUrl and paths stay relative to where they were declared', () => {
  it('resolves a parent-declared path alias against the parent directory, not the child', async () => {
    // A shared base config at the repo root, the normal monorepo shape:
    // every package's tsconfig extends it and adds nothing of its own.
    const monorepo = await mkdtemp(path.join(tmpdir(), 'nemesis-extends-'));
    try {
      await mkdir(path.join(monorepo, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(path.join(monorepo, 'frontend'), { recursive: true });
      await writeFile(
        path.join(monorepo, 'tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@core/*': ['packages/core/src/*'] },
          },
        }),
      );
      await writeFile(
        path.join(monorepo, 'frontend', 'tsconfig.json'),
        JSON.stringify({ extends: '../tsconfig.base.json', compilerOptions: {} }),
      );
      await writeFile(
        path.join(monorepo, 'packages', 'core', 'src', 'index.ts'),
        'export function coreThing(): number {\n  return 1;\n}\n',
      );

      const rules = await loadTsPathAliases(monorepo);
      const rule = rules.find((r) => r.prefix === '@core/');
      // TypeScript's own rule: a relative path resolves against the config
      // file that declared it. `tsconfig.base.json` sits at the repo root,
      // so `packages/core/src/*` resolves against `.`, never against
      // `frontend`, the directory of the config that merely inherits it.
      expect(rule?.targets).toEqual(['packages/core/src/*']);

      const g = emptyGraph();
      addModule(g, mod('packages/core/src/index.ts'));
      g.tsPathAliases = rules;
      expect(resolveModule(g, '@core/index', 'frontend/tests/a.test.ts')?.file).toBe(
        'packages/core/src/index.ts',
      );
    } finally {
      await rm(monorepo, { recursive: true, force: true });
    }
  });
});

describe('applying parsed aliases through resolveModule', () => {
  function graphWith(...files: string[]): SymbolGraph {
    const g = emptyGraph();
    for (const f of files) addModule(g, mod(f));
    return g;
  }

  it('resolves a real double file after loading the rules from disk', async () => {
    const rules = await loadTsPathAliases(root);
    const g = graphWith('frontend/src/services/admin.service.ts');
    g.tsPathAliases = rules;
    expect(resolveModule(g, '@/services/admin.service', 'frontend/tests/admin.test.ts')?.file).toBe(
      'frontend/src/services/admin.service.ts',
    );
  });
});
