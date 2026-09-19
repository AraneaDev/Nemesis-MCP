import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(root, 'src', 'cli', 'main.ts');

function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

describe('nemesis audit end-to-end', () => {
  it(
    'finds all four violation types across ecosystems',
    () => {
      const { stdout, status } = runCli(
        ['audit', 'fixtures', '--strictness=all', '--json'],
        root,
      );
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.summary.scanned_test_files).toBeGreaterThanOrEqual(4);
      expect(result.summary.doubles_inspected).toBeGreaterThanOrEqual(13);

      const types = new Set(result.violations.map((v: { type: string }) => v.type));
      expect(types.has('GHOST_METHOD')).toBe(true);
      expect(types.has('ARITY_MISMATCH')).toBe(true);
      expect(types.has('RETURN_DRIFT')).toBe(true);
      expect(types.has('VISIBILITY_BREACH')).toBe(true);

      const files = new Set(result.violations.map((v: { file: string }) => v.file));
      expect([...files].some((f) => f.includes('/php/'))).toBe(true);
      expect([...files].some((f) => f.includes('/ts/'))).toBe(true);
      expect([...files].some((f) => f.includes('/python/'))).toBe(true);
    },
    120_000,
  );

  it(
    'exit code 0 on clean repo',
    () => {
      const { status } = runCli(['audit', 'fixtures/rust'], root);
      expect(status).toBe(0);
    },
    120_000,
  );

  it(
    'ghost method message includes did-you-mean',
    () => {
      const { stdout } = runCli(['audit', 'fixtures', '--strictness=all', '--json'], root);
      const result = JSON.parse(stdout);
      const ghost = result.violations.find(
        (v: { type: string }) => v.type === 'GHOST_METHOD',
      );
      expect(ghost.suggestion).toBeTruthy();
    },
    120_000,
  );
});
