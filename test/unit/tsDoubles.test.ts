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

  it('reads the value out of a concise implementation, but not out of a block', async () => {
    const [concise] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockImplementation(() => 1);`);
    expect(concise?.method).toBe('load');
    expect(concise?.returnExpr).toBe('1');
    const [block] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockImplementation(() => { return 1; });`,
    );
    expect(block?.returnExpr).toBeNull();
  });

  it('reads a spy on a prototype as a spy on the class instance side', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(Svc.prototype, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.staticReceiver).toBe(false);
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

describe('members configured without spyOn', () => {
  it('reads vi.mocked on a typed receiver', async () => {
    const [d] = await doubles(`${PRELUDE}vi.mocked(s.load).mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('load');
    expect(d?.returnExpr).toBe('1');
  });

  it('reads an assertion on a typed receiver', async () => {
    const [d] = await doubles(`${PRELUDE}expect(s.load).toHaveBeenCalledWith(1, 2);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('load');
    expect(d?.assertedArity).toBe(2);
  });

  it('does not reach past the direct receiver', async () => {
    // `s.inner.deep.mockReturnValue(1)` configures `deep` on whatever `inner`
    // holds. Walking further found `inner` on Svc and called it a ghost.
    const found = await doubles(`${PRELUDE}s.inner.deep.mockReturnValue(1);`);
    expect(found.every((d) => d.method !== 'inner')).toBe(true);
  });

  it('ignores a receiver of unknown type', async () => {
    const found = await doubles(
      `import { vi } from 'vitest';\nvi.mocked(whatever.load).mockReturnValue(1);`,
    );
    expect(found).toEqual([]);
  });
});

describe('static members', () => {
  it('spies on a static method through the class itself', async () => {
    const [d] = await doubles(
      `import { vi } from 'vitest';\nimport { Svc } from '../src/svc';\nvi.spyOn(Svc, 'build').mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('build');
    expect(d?.returnExpr).toBe('1');
  });

  it('still prefers a tracked variable type over its name', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
  });
});

describe('the other two chain setters', () => {
  it('reads a rejection as a promise, without taking the reason for a value', async () => {
    const [d] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockRejectedValue(new Error('boom'));`,
    );
    expect(d?.resolvedReturn).toBe(true);
    expect(d?.returnExpr).toBeNull();
  });

  it('reads mockReturnThis as the fluency claim it is', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockReturnThis();`);
    expect(d?.returnsSelf).toBe(true);
  });
});

describe('a receiver that is a module', () => {
  it('reads a namespace import as the module it names', async () => {
    const [d] = await doubles(
      `import * as db from '../src/db.js';\nvi.spyOn(db, 'query').mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('../src/db.js');
    expect(d?.method).toBe('query');
  });

  it('reads a default import as the module it names', async () => {
    const [d] = await doubles(
      `import db from '../src/db.js';\nvi.spyOn(db, 'query').mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('../src/db.js');
  });

  it('reads a require binding as the module it names', async () => {
    const [d] = await doubles(
      `const db = require('../src/db.js');\nvi.spyOn(db, 'query').mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('../src/db.js');
  });

  it('reaches a member configured through vi.mocked', async () => {
    // adoptTypedMember documents this as supported and then bails, because it
    // requires the receiver to be a tracked constructor.
    const [d] = await doubles(
      `import * as db from '../src/db.js';\nvi.mocked(db.query).mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('../src/db.js');
    expect(d?.method).toBe('query');
    expect(d?.returnExpr).toBe('1');
  });

  it('leaves a constructed instance alone', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
  });

  it('leaves staticReceiver undefined for a namespace import', async () => {
    const [d] = await doubles(
      `import * as db from '../src/db.js';\nvi.spyOn(db, 'query').mockReturnValue(1);`,
    );
    expect(d?.staticReceiver).toBeUndefined();
  });

  it('leaves staticReceiver undefined for a require binding', async () => {
    const [d] = await doubles(
      `const db = require('../src/db.js');\nvi.spyOn(db, 'query').mockReturnValue(1);`,
    );
    expect(d?.staticReceiver).toBeUndefined();
  });

  it('marks staticReceiver false for a default import through vi.mocked, same as vi.spyOn', async () => {
    // spyTargetOf already applies this rule for `vi.spyOn(db, 'query')`
    // through a default import. adoptTypedMember (the `vi.mocked(x.y)` path)
    // did not, so `vi.mocked(db.staticMethod)` through a default import
    // skipped the static-versus-instance check entirely.
    const [d] = await doubles(
      `import db from '../src/db.js';\nvi.mocked(db.query).mockReturnValue(1);`,
    );
    expect(d?.targetSymbol).toBe('../src/db.js');
    expect(d?.method).toBe('query');
    expect(d?.staticReceiver).toBe(false);
  });

  it('prefers a local binding that shadows a module import, for vi.spyOn', async () => {
    // The module map and varTypes both come from one flat, scope-blind walk,
    // so `db` appears in both. Before modules were tracked, only varTypes was
    // consulted and this resolved to LocalService; that must not change.
    const [d] = await doubles(
      `import * as db from '../src/db.js';\nfunction run() {\n  const db = new LocalService();\n  vi.spyOn(db, 'load').mockReturnValue(1);\n}`,
    );
    expect(d?.targetSymbol).toBe('LocalService');
  });

  it('prefers a local binding that shadows a module import, through vi.mocked', async () => {
    const [d] = await doubles(
      `import * as db from '../src/db.js';\nfunction run() {\n  const db = new LocalService();\n  vi.mocked(db.load).mockReturnValue(1);\n}`,
    );
    expect(d?.targetSymbol).toBe('LocalService');
  });
});

describe('return values written through a type assertion', () => {
  // `as any` is what gets added when a stale mock stops compiling, so the
  // assertion is the drift's own fingerprint. Reading the cast as the return
  // expression hid the literal and switched the structural check off, which
  // silenced exactly the case this tool exists to catch.
  it('reads through `as any` to the literal underneath', async () => {
    const [d] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockResolvedValue({ id: '1', nickname: 'x' } as any);`,
    );
    expect(d?.returnExpr).toBe("{ id: '1', nickname: 'x' }");
  });

  it('reads through a named assertion and through `satisfies`', async () => {
    const [named] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockReturnValue(1 as number);`);
    expect(named?.returnExpr).toBe('1');
    const [sat] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockReturnValue(1 satisfies number);`,
    );
    expect(sat?.returnExpr).toBe('1');
  });

  it('reads through a double assertion', async () => {
    const [d] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockReturnValue({ id: '1' } as unknown as Profile);`,
    );
    expect(d?.returnExpr).toBe("{ id: '1' }");
  });
});

describe('vi.mocked wrapping the receiver rather than the member', () => {
  // `vi.mocked(svc.load)` was read, but `vi.mocked(svc).load` produced no
  // double at all. Both are idiomatic, and the second is what gets written
  // once a whole class or module is mocked, so the silence was total.
  it('reads vi.mocked(receiver).member', async () => {
    const [d] = await doubles(`${PRELUDE}vi.mocked(s).load.mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('load');
    expect(d?.returnExpr).toBe('1');
  });

  it('reads jest.mocked(receiver).member the same way', async () => {
    const [d] = await doubles(`${PRELUDE}jest.mocked(s).load.mockResolvedValue(1);`);
    expect(d?.method).toBe('load');
  });

  it('still reads vi.mocked(receiver.member)', async () => {
    const [d] = await doubles(`${PRELUDE}vi.mocked(s.load).mockReturnValue(1);`);
    expect(d?.method).toBe('load');
  });
});

describe('a double assigned straight onto a property', () => {
  // `svc.method = vi.fn()` is ordinary Jest, and it produced no double at all,
  // so neither the pinned return nor the member name was ever checked.
  it('reads the return pinned on an assigned double', async () => {
    const [d] = await doubles(`${PRELUDE}s.load = vi.fn().mockReturnValue(1);`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('load');
    expect(d?.returnExpr).toBe('1');
  });

  it('reads the member name even when the double states nothing else', async () => {
    // The name is itself a claim that the member exists, which is checkable
    // whatever the fake does, so a bare `vi.fn()` still has to be recorded.
    const [d] = await doubles(`${PRELUDE}s.loadd = vi.fn();`);
    expect(d?.targetSymbol).toBe('Svc');
    expect(d?.method).toBe('loadd');
  });

  it('reads a replacement signature from an assigned implementation', async () => {
    const [d] = await doubles(`${PRELUDE}s.load = vi.fn((a: string, b: number) => 1);`);
    expect(d?.fakeArity).toBe(2);
  });

  it('ignores an assignment that is not a double', async () => {
    expect(await doubles(`${PRELUDE}s.load = somethingElse;`)).toEqual([]);
  });

  it('ignores an assignment onto a receiver of unknown type', async () => {
    expect(await doubles(`const q = getThing();\nq.load = vi.fn().mockReturnValue(1);`)).toEqual(
      [],
    );
  });
});

describe('marking a return written behind a type assertion', () => {
  // The cast has to reach the analyzer: reading through it finds real drift,
  // but it is also how a deliberate partial stub is written, and syntax cannot
  // tell the two apart. Recording that it was there lets the analyzer say so
  // without failing a build over an intentional partial.
  it('flags a return written behind a cast', async () => {
    const [d] = await doubles(
      `${PRELUDE}vi.spyOn(s, 'load').mockResolvedValue({ id: '1' } as any);`,
    );
    expect(d?.returnAsserted).toBe(true);
  });

  it('leaves an uncast return unflagged', async () => {
    const [d] = await doubles(`${PRELUDE}vi.spyOn(s, 'load').mockResolvedValue({ id: '1' });`);
    expect(d?.returnAsserted).toBeUndefined();
  });
});
