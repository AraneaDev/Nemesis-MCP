import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { checkFixtures } from '../../src/fixtures/staleFixtures.js';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('fixture diagnostics', () => {
  it('names malformed fixture input instead of claiming a clean success', async () => {
    const rel = 'test/fixtures-invalid/invalid.json';
    const result = await checkFixtures(root, [rel]);
    expect(result.scanned).toBe(0);
    expect(result.unparsable).toContain(rel);
  }, 120_000);

  it('does not turn unparsable input into a partial scan', async () => {
    // Test corpora are full of deliberately broken JSON, truncated files and
    // JSONC configs. Counting each as a diagnostic made `nemesis fixtures`
    // exit 2 in 52 of 54 repositories.
    const result = await checkFixtures(root, ['test/fixtures-invalid/invalid.json']);
    expect(result.diagnostics.some((d) => d.stage === 'parse')).toBe(false);
    expect(result.diagnostics.filter((d) => d.fatal)).toEqual([]);
  }, 120_000);

  it('fails for missing explicit fixture paths', async () => {
    await expect(checkFixtures(root, ['fixtures/fixtures-data/missing.json'])).rejects.toThrow(
      /does not exist/,
    );
  });
});

describe('fixture to DTO matching', () => {
  it('matches a wrapper key that holds records', async () => {
    const result = await checkFixtures(root, ['fixtures/fixtures-data']);
    expect(result.scanned).toBe(1);
    const messages = result.violations.map((v) => v.message);
    expect(messages.some((m) => m.includes("missing required field 'name'"))).toBe(true);
  }, 120_000);

  it('ignores a scalar key that merely shares a name with a class', async () => {
    // `{ "edition": "2026-q1", ... }` is a report blob, not an `Edition`
    // record. Using every top-level key as a name signal bound the two
    // together and reported four fields as missing.
    const dir = path.join(root, 'test', 'fixtures-scalarkey');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'tests', 'fixtures'), { recursive: true });
    await writeFile(
      path.join(dir, 'src', 'edition.ts'),
      'export interface Edition {\n  slug: string;\n  data: string;\n  findings: string;\n}\n',
    );
    await writeFile(
      path.join(dir, 'tests', 'fixtures', 'report.json'),
      JSON.stringify({ schema: 1, edition: '2026-q1', asOf: 'now' }),
    );
    try {
      const result = await checkFixtures(dir);
      expect(result.scanned).toBe(1);
      expect(result.violations).toEqual([]);
      expect(result.unmatched).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('fixture field types', () => {
  it('reports a value whose type does not match the declared field', async () => {
    // Only presence was ever checked, so `"id": 1` sat happily against
    // `id: string` and the fixture looked current.
    const result = await checkFixtures(root, ['fixtures/fixtures-typed']);
    expect(result.scanned).toBe(1);
    const messages = result.violations.map((v) => v.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has 'id' as int but ShipmentRecord declares 'string'"),
        expect.stringContaining("has 'weight' as string but ShipmentRecord declares 'number'"),
        expect.stringContaining("has 'express' as string but ShipmentRecord declares 'boolean'"),
      ]),
    );
  }, 120_000);

  it('accepts a record whose values match', async () => {
    const result = await checkFixtures(root, ['fixtures/fixtures-typed']);
    // The first record in the fixture is correct, so every finding names the
    // second one's fields rather than both.
    expect(result.violations).toHaveLength(3);
  }, 120_000);
});

describe('enum-typed fixture fields', () => {
  it('accepts a value that is a case of the enum', async () => {
    const result = await checkFixtures(root, ['fixtures/fixtures-enum']);
    expect(result.scanned).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.violations.filter((v) => v.message.includes('"fast"'))).toEqual([]);
  }, 120_000);

  it('reports a value that is not a case of the enum', async () => {
    // A string is the right shape for a backed enum, so comparing kinds says
    // nothing; what matters is whether the value is still one of the cases.
    const result = await checkFixtures(root, ['fixtures/fixtures-enum']);
    expect(result.violations.map((v) => v.message)).toEqual([
      expect.stringContaining('has \'lane\' as "express", which is not a case of'),
    ]);
  }, 120_000);
});
