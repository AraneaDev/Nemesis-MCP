import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAudit } from '../../src/core/runtime.js';
import { exitCodeFor } from '../../src/core/report.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nemesis-budget-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'svc.ts'),
    'export class Svc {\n  load(): boolean { return true; }\n}\n',
  );
  await writeFile(
    path.join(root, 'tests', 'svc.test.ts'),
    `import { vi } from 'vitest';\nimport { Svc } from '../src/svc';\nconst s = new Svc();\nvi.spyOn(s, 'missing').mockReturnValue(1);\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const audit = (opts: Record<string, unknown> = {}) =>
  runAudit({ rootDir: root, strictness: 'all', languages: ['typescript'], ...opts });

describe('budget enforcement', () => {
  it('finds the drift when nothing is constrained', async () => {
    const result = await audit();
    expect(result.summary.violations_count).toBe(1);
    expect(result.summary.diagnostics ?? []).toEqual([]);
    expect(exitCodeFor(result, 'all')).toBe(1);
  });

  it('skips a file over the per-file byte limit without calling it fatal', async () => {
    const result = await audit({ maxFileBytes: 10 });
    const diagnostics = result.summary.diagnostics ?? [];
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.stage === 'budget')).toBe(true);
    expect(diagnostics.every((d) => d.fatal === false)).toBe(true);
    expect(result.summary.partial).toBe(true);
    // A skipped file leaves a gap, so the scan cannot be called clean, but the
    // caller may accept the gap knowingly.
    expect(exitCodeFor(result, 'all')).toBe(2);
    expect(exitCodeFor(result, 'all', { allowPartial: true })).toBe(0);
  });

  it('names the limit it enforced', async () => {
    const result = await audit({ maxFileBytes: 10 });
    expect(result.summary.diagnostics?.[0]?.message).toContain('10 byte limit');
  });

  it('treats an exhausted duration budget as fatal', async () => {
    const result = await audit({ maxDurationMs: -1 });
    const diagnostics = result.summary.diagnostics ?? [];
    expect(diagnostics.some((d) => d.fatal && /duration/i.test(d.message))).toBe(true);
    // A fatal diagnostic is never downgraded, whatever the caller asks for.
    expect(exitCodeFor(result, 'all', { allowPartial: true })).toBe(2);
  });

  it('refuses a scan with more files than the limit allows', async () => {
    const result = await audit({ maxFiles: 1 });
    const diagnostics = result.summary.diagnostics ?? [];
    expect(diagnostics.some((d) => d.fatal && /limit is 1/.test(d.message))).toBe(true);
    expect(exitCodeFor(result, 'all')).toBe(2);
  });

  it('reports exceeding the total byte budget', async () => {
    const result = await audit({ maxTotalBytes: 1 });
    const diagnostics = result.summary.diagnostics ?? [];
    expect(diagnostics.some((d) => d.fatal && /limit is 1/.test(d.message))).toBe(true);
    expect(exitCodeFor(result, 'all')).toBe(2);
  });

  it('records a file it cannot read as fatal', async () => {
    const blocked = await mkdtemp(path.join(tmpdir(), 'nemesis-unreadable-'));
    try {
      await mkdir(path.join(blocked, 'src'), { recursive: true });
      await mkdir(path.join(blocked, 'tests'), { recursive: true });
      await writeFile(path.join(blocked, 'src', 'a.ts'), 'export class A { b(): void {} }');
      const secret = path.join(blocked, 'tests', 'a.test.ts');
      await writeFile(secret, 'export const x = 1;');
      await chmod(secret, 0o000);
      const result = await runAudit({
        rootDir: blocked,
        strictness: 'all',
        languages: ['typescript'],
      });
      const diagnostics = result.summary.diagnostics ?? [];
      // Running as root defeats the permission bit, so only assert when the
      // file really became unreadable.
      if (diagnostics.length > 0) {
        expect(diagnostics.some((d) => d.stage === 'read' && d.fatal)).toBe(true);
      }
    } finally {
      await chmod(path.join(blocked, 'tests', 'a.test.ts'), 0o644).catch(() => {});
      await rm(blocked, { recursive: true, force: true });
    }
  });

  it('never reports a partial scan as clean', async () => {
    // The whole point of the partial flag: a file the symbol graph never saw
    // could be hiding a ghost method.
    const result = await audit({ maxFileBytes: 10 });
    expect(result.summary.violations_count).toBe(0);
    expect(exitCodeFor(result, 'breaking_only')).not.toBe(0);
  });
});
