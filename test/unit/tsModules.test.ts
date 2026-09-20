import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../../src/core/symbolGraph.js';
import { indexTsFile } from '../../src/extractors/ts/index.js';
import type { TypeSymbol } from '../../src/core/types.js';

async function moduleOf(source: string, file = 'src/api.ts'): Promise<TypeSymbol> {
  const g = emptyGraph();
  await indexTsFile(file, source, g);
  const found = g.modules.get(file);
  if (!found) throw new Error('no module symbol emitted');
  return found;
}

describe('the module symbol for a TypeScript file', () => {
  it('holds an exported function with its signature', async () => {
    const m = await moduleOf(
      'export function fetchUser(id: string): Promise<string> {\n  return Promise.resolve(id);\n}\n',
    );
    const fn = m.methods.get('fetchUser');
    expect(fn?.returnType).toBe('Promise<string>');
    expect(fn?.params.map((p) => p.name)).toEqual(['id']);
  });

  it('holds an exported arrow constant as a member', async () => {
    const m = await moduleOf('export const saveUser = (id: string): boolean => id !== "";\n');
    const fn = m.methods.get('saveUser');
    expect(fn?.params.map((p) => p.name)).toEqual(['id']);
    expect(fn?.returnType).toBe('boolean');
  });

  it('holds an exported function-expression constant as a member', async () => {
    const m = await moduleOf(
      'export const saveUser = function (id: string): boolean {\n  return id !== "";\n};\n',
    );
    const fn = m.methods.get('saveUser');
    expect(fn?.params.map((p) => p.name)).toEqual(['id']);
    expect(fn?.returnType).toBe('boolean');
  });

  it('takes an exported class as a member, but not with a signature', async () => {
    const m = await moduleOf('export class Svc {\n  run(): boolean {\n    return true;\n  }\n}\n');
    expect(m.unknownMembers.has('Svc')).toBe(true);
    expect(m.methods.has('Svc')).toBe(false);
  });

  it('takes an exported interface as a member', async () => {
    const m = await moduleOf('export interface UserProfile {\n  id: string;\n}\n');
    expect(m.unknownMembers.has('UserProfile')).toBe(true);
  });

  it('takes an exported type alias as a member', async () => {
    const m = await moduleOf('export type Id = string;\n');
    expect(m.unknownMembers.has('Id')).toBe(true);
  });

  it('takes an exported enum as a member', async () => {
    const m = await moduleOf('export enum Status {\n  Active,\n  Inactive,\n}\n');
    expect(m.unknownMembers.has('Status')).toBe(true);
  });

  it('takes an exported non-function const as a member', async () => {
    const m = await moduleOf('export const sounds = new SoundManager();\n');
    expect(m.unknownMembers.has('sounds')).toBe(true);
    expect(m.methods.has('sounds')).toBe(false);
  });

  it('takes an exported numeric const as a member', async () => {
    const m = await moduleOf('export const MAX = 5;\n');
    expect(m.unknownMembers.has('MAX')).toBe(true);
  });

  it('takes a default export as a member', async () => {
    const m = await moduleOf('const x = 5;\nexport default x;\n');
    expect(m.unknownMembers.has('default')).toBe(true);
  });

  it('takes a default function export as a member under "default", not its own name', async () => {
    const m = await moduleOf(
      'export default function fetchUser(id: string): boolean {\n  return true;\n}\n',
    );
    expect(m.methods.has('default')).toBe(true);
    expect(m.methods.has('fetchUser')).toBe(false);
  });

  it('does not treat a plain named import as a member of this file', async () => {
    // An import is not an export: TypeScript does not make `query` an
    // attribute of `repo.ts` just because the file imports it. Unlike
    // Python, where `from x import y` really does bind `y` on the importing
    // module, this is a purely local binding until something re-exports it.
    const m = await moduleOf("import { query } from './db.js';\n", 'src/repo.ts');
    expect(m.imports?.has('query')).toBe(false);
    expect(m.unknownMembers.has('query')).toBe(false);
  });

  it('does not treat an aliased import as a member of this file', async () => {
    const m = await moduleOf("import { query as q } from './db.js';\n", 'src/repo.ts');
    expect(m.imports?.has('q')).toBe(false);
    expect(m.unknownMembers.has('q')).toBe(false);
  });

  it('does not treat a default import as a member of this file', async () => {
    const m = await moduleOf("import db from './db.js';\n", 'src/repo.ts');
    expect(m.imports?.has('db')).toBe(false);
    expect(m.unknownMembers.has('db')).toBe(false);
  });

  it('delegates a re-exported imported name to the module it came from', async () => {
    const m = await moduleOf(
      "import { query } from './db.js';\nexport { query };\n",
      'src/repo.ts',
    );
    expect(m.imports?.get('query')).toEqual({ from: './db.js', name: 'query' });
    expect(m.unknownMembers.has('query')).toBe(false);
  });

  it('delegates an aliased re-export of an imported name', async () => {
    const m = await moduleOf(
      "import { query } from './db.js';\nexport { query as fetch };\n",
      'src/repo.ts',
    );
    expect(m.imports?.get('fetch')).toEqual({ from: './db.js', name: 'query' });
    expect(m.imports?.has('query')).toBe(false);
  });

  it('delegates a re-export with a source specifier to the module it names', async () => {
    const m = await moduleOf("export { query } from './db.js';\n", 'src/repo.ts');
    expect(m.imports?.get('query')).toEqual({ from: './db.js', name: 'query' });
  });

  it('binds a namespace import under the namespace name, not as an import', async () => {
    const m = await moduleOf("import * as db from './db.js';\n", 'src/repo.ts');
    expect(m.unknownMembers.has('db')).toBe(true);
    expect(m.imports?.has('db')).toBe(false);
  });

  it('gives up on a file that re-exports everything', async () => {
    const m = await moduleOf("export * from './api.js';\n", 'src/barrel.ts');
    expect(m.unknownMembers.has('*')).toBe(true);
  });

  it('reads CommonJS exports', async () => {
    const m = await moduleOf('function getPool() {}\nmodule.exports = { getPool };\n', 'api/db.js');
    expect(m.methods.has('getPool')).toBe(true);
  });

  it('reads a CommonJS property export finding a function declared above it', async () => {
    const m = await moduleOf(
      'function getPool() {}\nmodule.exports.getPool = getPool;\n',
      'api/db.js',
    );
    expect(m.methods.has('getPool')).toBe(true);
  });

  it('reads a bare exports property export', async () => {
    // `exports.x = ...` without the `module.` prefix. The path works; it had
    // no test of its own here, only one against the export-list reader.
    const m = await moduleOf(
      'function getPool() {}\nexports.getPool = getPool;\nexports.raw = function (z) {};\n',
      'api/db.js',
    );
    expect(m.methods.has('getPool')).toBe(true);
    expect(m.methods.get('raw')?.params.map((p) => p.name)).toEqual(['z']);
  });

  it('does not take a class method for a module member', async () => {
    const m = await moduleOf('export class Svc {\n  run(): boolean {\n    return true;\n  }\n}\n');
    expect(m.methods.has('run')).toBe(false);
    expect(m.unknownMembers.has('run')).toBe(false);
  });
});
