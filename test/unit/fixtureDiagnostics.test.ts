import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { checkFixtures } from '../../src/fixtures/staleFixtures.js';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('fixture diagnostics', () => {
  it('reports malformed fixture input instead of clean success', async () => {
    const rel = 'test/fixtures-invalid/invalid.json';
    const result = await checkFixtures(root, [rel]);
    expect(result.scanned).toBe(0);
    expect(result.diagnostics.some((diagnostic) => diagnostic.stage === 'parse')).toBe(true);
  }, 120_000);

  it('fails for missing explicit fixture paths', async () => {
    await expect(checkFixtures(root, ['fixtures/fixtures-data/missing.json'])).rejects.toThrow(/does not exist/);
  });
});
