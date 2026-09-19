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
    // The property under test is that concurrent parses agree, not how many
    // doubles this snippet happens to contain.
    const shape = (r: (typeof results)[number]) =>
      JSON.stringify(
        r.doubles.map((d) => [d.framework, d.targetSymbol, d.method, d.assertedArity]),
      );
    const first = shape(results[0]!);
    expect(results.every((r) => shape(r) === first)).toBe(true);
    expect(results[0]!.doubles.length).toBeGreaterThan(0);
    const spy = results[0]!.doubles.find((d) => d.framework.endsWith('spyOn'));
    expect(spy?.method).toBe('run');
    expect(spy?.assertedArity).toBeNull();
  });
});
