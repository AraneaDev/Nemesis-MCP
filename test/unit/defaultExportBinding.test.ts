import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAudit } from '../../src/core/runtime.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nemesis-default-export-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });

  // A default import binds the module's default EXPORT (an instance of S),
  // not the module. `s.ts` also exports `s` by name, matching the common
  // real-world singleton shape (`export const svc = new Svc(); export
  // default svc;`).
  await writeFile(
    path.join(root, 'src', 's.ts'),
    'export class S {\n' +
      '  m(): number {\n' +
      '    return 1;\n' +
      '  }\n' +
      '}\n' +
      'export const s = new S();\n' +
      'export default s;\n',
  );

  // A module with a real top-level function, for the namespace-import case,
  // which still means the module itself.
  await writeFile(
    path.join(root, 'src', 'ns.ts'),
    'export function topLevel(): number {\n  return 1;\n}\n',
  );

  // A default export this scan cannot follow to a declared type: the value
  // is a call expression, not a bare identifier or `new X()`.
  await writeFile(
    path.join(root, 'src', 'opaque.ts'),
    'export function createThing() {\n' +
      '  return { m: () => 1 };\n' +
      '}\n' +
      'export default createThing();\n',
  );

  await writeFile(
    path.join(root, 'tests', 'default-real.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import x from '../src/s';\n` +
      `vi.spyOn(x, 'm').mockReturnValue(2);\n`,
  );

  await writeFile(
    path.join(root, 'tests', 'default-ghost.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import x from '../src/s';\n` +
      `vi.spyOn(x, 'doesNotExist').mockReturnValue(2);\n`,
  );

  await writeFile(
    path.join(root, 'tests', 'default-mocked.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import x from '../src/s';\n` +
      `vi.mocked(x.m).mockReturnValue(3);\n`,
  );

  await writeFile(
    path.join(root, 'tests', 'namespace-import.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import * as ns from '../src/ns';\n` +
      `vi.spyOn(ns, 'topLevel').mockReturnValue(2);\n` +
      `vi.spyOn(ns, 'notAMember').mockReturnValue(3);\n`,
  );

  await writeFile(
    path.join(root, 'tests', 'require-binding.test.ts'),
    `import { vi } from 'vitest';\n` +
      `const ns2 = require('../src/ns');\n` +
      `vi.spyOn(ns2, 'topLevel').mockReturnValue(2);\n`,
  );

  await writeFile(
    path.join(root, 'tests', 'opaque-default.test.ts'),
    `import { vi } from 'vitest';\n` +
      `import thing from '../src/opaque';\n` +
      `vi.spyOn(thing, 'm').mockReturnValue(2);\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const audit = () => runAudit({ rootDir: root, strictness: 'all', languages: ['typescript'] });

describe('a default import binds the default export, not the module', () => {
  it('resolves a real method through the default export to a real signature, silently', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/default-real.test.ts');
    expect(found).toEqual([]);
  });

  it('still reports a ghost when the method genuinely does not exist, so the fix is not blanket silence', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/default-ghost.test.ts');
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.target).toBe('S::doesNotExist');
  });

  it('resolves vi.mocked(x.m) through a default import the same way as vi.spyOn', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/default-mocked.test.ts');
    expect(found).toEqual([]);
  });

  it('still resolves a namespace import to the module and its top-level members', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/namespace-import.test.ts');
    // The real top-level member is silent; the one that is not a module
    // member reports a ghost against the module, not against any class.
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.target).toBe('src/ns.ts::notAMember');
  });

  it('still resolves a require binding to the module', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/require-binding.test.ts');
    expect(found).toEqual([]);
  });

  it('produces no finding when the default export cannot be followed to a type', async () => {
    const result = await audit();
    const found = result.violations.filter((v) => v.file === 'tests/opaque-default.test.ts');
    expect(found).toEqual([]);
  });

  it('still counts every one of these doubles as checked, not unresolved or unknowable', async () => {
    const result = await audit();
    // Every identifier above is bound to a relative specifier this scan
    // owns, so none of the seven doubles configured across these fixtures
    // should ever have been written off as unresolved or a package.
    expect(result.summary.doubles_checked).toBe(7);
    expect(result.summary.doubles_unresolved).toBe(0);
    expect(result.summary.doubles_unknowable).toBe(0);
  });
});
