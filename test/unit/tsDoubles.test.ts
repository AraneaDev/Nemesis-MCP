import { describe, expect, it } from 'vitest';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';

async function doubles(src: string, lang: 'typescript' | 'javascript' = 'typescript') {
  const result = await extractTsDoubles(
    lang === 'typescript' ? 'tests/svc.test.ts' : 'tests/svc.test.js',
    src,
    lang,
  );
  return Array.isArray(result) ? result : result.doubles;
}

const PRELUDE = `import { vi, expect } from 'vitest';\nimport { Svc } from '../src/svc';\nconst s = new Svc();\n`;

describe('spies', () => {
  it('reads vi.spyOn with a return value', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('load');
    expect(d?.returnExpr).toBe('1');
  });

  it('reads jest.spyOn the same way', async () => {
    const [d] = await doubles(
      `const s = new Svc();\njest.spyOn(s, 'load').mockReturnValue(1);`,
      'javascript',
    );
    expect(d?.method).toBe('load');
  });

  it('reads the resolved and once variants', async () => {
    for (const setter of ['mockResolvedValue', 'mockReturnValueOnce', 'mockResolvedValueOnce']) {
      const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').${setter}(1);`);
      expect(d?.returnExpr, setter).toBe('1');
    }
  });

  it('records an implementation without inventing a return value', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockImplementation(() => 1);`);
    expect(d?.method).toBe('load');
    expect(d?.returnExpr).toBeNull();
  });

  it('reads a spy on a prototype', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(Svc.prototype, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc.prototype');
    expect(d?.method).toBe('load');
  });

  it('reads a spy on a nested receiver', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s.inner, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('s.inner');
  });
});

describe('assertions', () => {
  it('reads the asserted argument count through a spy variable', async () => {
    const [d] = await doubles(
      `${PRELUDE}const spy = vi.spyOn(s, 'load');\nexpect(spy).toHaveBeenCalledWith(1, 2);`,
    );
    expect(d?.assertedArity).toBe(2);
  });
});

describe('things that are not doubles', () => {
  it('ignores an ordinary call', async () => {
    expect(await doubles(`${PRELUDE}s.load(1);`)).toEqual([]);
  });

  it('ignores a spy on a built-in global', async () => {
    const found = await doubles(
      `${PRELUDE}vi.spyOn(console, 'error').mockImplementation(() => {});`,
    );
    expect(found.every((d) => d.targetSymbol !== 'Svc')).toBe(true);
  });
});
