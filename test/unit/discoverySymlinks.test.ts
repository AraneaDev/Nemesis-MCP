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

  it('does not walk a tree twice through a self-referential symlink', async () => {
    // One repository in the corpus links plugins/redactx at its own root.
    // Recording real paths only for directories reached through a link missed
    // the root's own path, so every file was discovered twice.
    const selfRoot = await mkdtemp(path.join(tmpdir(), 'nemesis-self-'));
    try {
      await mkdir(path.join(selfRoot, 'src'), { recursive: true });
      await mkdir(path.join(selfRoot, 'plugins'), { recursive: true });
      await writeFile(path.join(selfRoot, 'src', 'a.ts'), 'export const a = 1;');
      await symlink(selfRoot, path.join(selfRoot, 'plugins', 'self'));
      const found = await discoverFiles(selfRoot, {});
      expect(found.productionFiles).toEqual(['src/a.ts']);
    } finally {
      await rm(selfRoot, { recursive: true, force: true });
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

describe('inline rust tests', () => {
  it('scans a source file that carries a #[cfg(test)] module', async () => {
    // Rust's usual unit-test idiom is a module beside the code. Treating only
    // tests/ as test code left that entire case unscanned.
    const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-cfgtest-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'repo.rs'),
        `pub trait Repo { fn save(&self, v: u32) -> bool; }

#[cfg(test)]
mod tests {
    #[test]
    fn t() {
        let mut m = MockRepo::new();
        m.expect_save().return_const(true);
    }
}`,
      );
      const found = await discoverFiles(dir, {});
      // The file is both: it declares production types and contains tests.
      expect(found.productionFiles).toContain('src/repo.rs');
      expect(found.testFiles).toContain('src/repo.rs');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a plain rust source file out of the test list', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-nocfg-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'lib.rs'), 'pub fn add(a: u32) -> u32 { a }');
      const found = await discoverFiles(dir, {});
      expect(found.productionFiles).toContain('src/lib.rs');
      expect(found.testFiles).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
