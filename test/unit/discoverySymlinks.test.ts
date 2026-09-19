import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverFiles } from '../../src/core/discovery.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nemesis-symlink-'));
  await mkdir(path.join(root, 'real', 'src'), { recursive: true });
  await mkdir(path.join(root, 'repo', 'tests'), { recursive: true });
  await writeFile(path.join(root, 'real', 'src', 'svc.ts'), 'export class Svc {}');
  await writeFile(path.join(root, 'repo', 'tests', 'a.test.ts'), 'export const a = 1;');
  await symlink(path.join(root, 'real', 'src'), path.join(root, 'repo', 'src'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('symlinks during discovery', () => {
  it('follows a symlinked source directory', async () => {
    // Regression: a symlinked directory was neither isDirectory() nor
    // isFile() to the walk, so it was dropped silently. Source reached only
    // through a symlink never entered the graph, and every double pointing
    // into it went unchecked while the scan reported clean.
    const found = await discoverFiles(path.join(root, 'repo'), {});
    expect(found.productionFiles).toContain('src/svc.ts');
    expect(found.testFiles).toContain('tests/a.test.ts');
  });

  it('terminates on a symlink loop', async () => {
    const loopRoot = await mkdtemp(path.join(tmpdir(), 'nemesis-loop-'));
    try {
      await mkdir(path.join(loopRoot, 'src'), { recursive: true });
      await writeFile(path.join(loopRoot, 'src', 'a.ts'), 'export const a = 1;');
      await symlink(loopRoot, path.join(loopRoot, 'src', 'up'));
      const found = await discoverFiles(loopRoot, {});
      expect(found.productionFiles).toContain('src/a.ts');
    } finally {
      await rm(loopRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('skips a broken symlink without failing', async () => {
    const brokenRoot = await mkdtemp(path.join(tmpdir(), 'nemesis-broken-'));
    try {
      await mkdir(path.join(brokenRoot, 'src'), { recursive: true });
      await writeFile(path.join(brokenRoot, 'src', 'a.ts'), 'export const a = 1;');
      await symlink(path.join(brokenRoot, 'nowhere'), path.join(brokenRoot, 'src', 'dangling.ts'));
      const diagnostics: Array<{ fatal: boolean }> = [];
      const found = await discoverFiles(brokenRoot, { diagnostics });
      expect(found.productionFiles).toContain('src/a.ts');
      expect(diagnostics.filter((d) => d.fatal)).toEqual([]);
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  });
});
