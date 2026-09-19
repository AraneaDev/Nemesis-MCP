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

describe('nemesis verify-symbol end-to-end', () => {
  it(
    'lists doubles with validity flags',
    () => {
      const { status, stdout } = runCli(['verify-symbol', 'UserService'], root);
      expect(status).toBe(0);
      expect(stdout).toContain('fixtures/ts/tests/UserService.spec.ts:7');
      expect(stdout).toContain('✗ INVALID');
      expect(stdout).toContain('✓ valid');
    },
    120_000,
  );

  it(
    'reports unresolved symbols',
    () => {
      const { stdout } = runCli(['verify-symbol', 'NoSuchClass'], root);
      expect(stdout).toContain('could not be resolved');
    },
    120_000,
  );
});

describe('nemesis fixtures end-to-end', () => {
  it(
    'flags stale fixture records',
    () => {
      const { status, stdout } = runCli(
        ['fixtures', 'fixtures/fixtures-data', '--json'],
        root,
      );
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.summary.scanned_fixtures).toBe(1);
      const messages = result.violations.map((v: { message: string }) => v.message);
      expect(messages.some((m: string) => m.includes("missing required field 'name'"))).toBe(true);
      expect(messages.some((m: string) => m.includes("'username' which no longer exists"))).toBe(true);
    },
    120_000,
  );
});
