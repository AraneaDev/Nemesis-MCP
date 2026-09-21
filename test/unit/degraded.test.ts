import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAudit } from '../../src/core/runtime.js';
import { exitCodeFor } from '../../src/core/report.js';

import type { LanguageId } from '../../src/core/types.js';

const LANGS: LanguageId[] = ['typescript', 'javascript', 'php', 'python', 'rust'];

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function project(files: Record<string, string>) {
  root = await mkdtemp(path.join(tmpdir(), 'nemesis-degraded-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, 'utf8');
  }
  return runAudit({ rootDir: root, strictness: 'all', languages: LANGS });
}

// A grammar recovers from what it cannot read by standing an error node in its
// place, and the walk still covers everything around it. Across 54 checkouts
// those regions cost 29 doubles out of 8,736, so calling the whole scan
// incomplete was out of proportion: 21 of 54 repositories could never exit 0,
// which teaches everyone to pass --allow-partial and silences the files that
// genuinely were not read at all.
const UNREADABLE = `export type * from './e.js';
export class Svc {
  load(): boolean { return true; }
}
`;

const SPEC = `import { vi } from 'vitest';
import { Svc } from '../src/svc.js';
const s = new Svc();
vi.spyOn(s, 'load').mockReturnValue(1);
`;

describe('a file read with an unreadable region', () => {
  it('is recorded as degraded rather than skipped', async () => {
    const result = await project({ 'src/svc.ts': UNREADABLE, 'tests/svc.test.ts': SPEC });
    const diagnostics = result.summary.diagnostics ?? [];
    expect(diagnostics.some((d) => d.stage === 'parse' && d.degraded === true)).toBe(true);
    expect(diagnostics.every((d) => d.fatal === false)).toBe(true);
  });

  it('does not make the scan partial', async () => {
    const result = await project({ 'src/svc.ts': UNREADABLE, 'tests/svc.test.ts': SPEC });
    expect(result.summary.partial).toBeUndefined();
    expect(result.summary.degraded_files).toBe(1);
  });

  it('still reports the drift it could read, and exits on that alone', async () => {
    const result = await project({ 'src/svc.ts': UNREADABLE, 'tests/svc.test.ts': SPEC });
    expect(result.violations.length).toBeGreaterThan(0);
    expect(exitCodeFor(result, 'all')).toBe(1);
  });

  it('exits 0 when the only thing wrong is the unreadable region', async () => {
    const clean = `import { vi } from 'vitest';
import { Svc } from '../src/svc.js';
const s = new Svc();
vi.spyOn(s, 'load').mockReturnValue(true);
`;
    const result = await project({ 'src/svc.ts': UNREADABLE, 'tests/svc.test.ts': clean });
    expect(result.violations).toEqual([]);
    expect(exitCodeFor(result, 'all')).toBe(0);
  });
});

describe('a file that was not read at all', () => {
  it('still makes the scan partial and exits 2', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nemesis-unread-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'svc.ts'),
      'export class Svc {\n  load(): boolean { return true; }\n}\n',
    );
    await writeFile(path.join(root, 'tests', 'svc.test.ts'), SPEC);
    const result = await runAudit({
      rootDir: root,
      strictness: 'all',
      languages: LANGS,
      maxFileBytes: 10,
    });
    expect(result.summary.partial).toBe(true);
    expect(exitCodeFor(result, 'all')).toBe(2);
    expect(exitCodeFor(result, 'all', { allowPartial: true })).toBe(0);
  });
});
