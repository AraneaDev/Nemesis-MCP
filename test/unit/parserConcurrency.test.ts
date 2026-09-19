import { describe, expect, it } from 'vitest';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';

describe('parser isolation', () => {
  it('supports concurrent parses without sharing mutable parser state', async () => {
    const source = `
      class Service { run(value: string): boolean { return value.length > 0; } }
      const service = new Service();
      const spy = vi.spyOn(service, 'run');
      spy.toHaveBeenCalledTimes(2);
    `;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        extractTsDoubles(`test-${index}.ts`, source, 'typescript'),
      ),
    );
    expect(results).toHaveLength(8);
    expect(results.every((result) => result.doubles.length === 1)).toBe(true);
    expect(results.every((result) => result.doubles[0]?.assertedArity === null)).toBe(true);
  });
});
