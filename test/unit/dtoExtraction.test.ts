import { describe, expect, it } from 'vitest';
import { emptyGraph, resolveType } from '../../src/core/symbolGraph.js';
import { indexPhpFile } from '../../src/extractors/php/index.js';
import { indexPythonFile } from '../../src/extractors/python/index.js';
import { indexRustFile } from '../../src/extractors/rust/index.js';
import { indexTsFile } from '../../src/extractors/ts/index.js';

describe('cross-language DTO field extraction', () => {
  it('extracts PHP properties', async () => {
    const graph = emptyGraph();
    await indexPhpFile(
      'src/User.php',
      `<?php class User { public string $name; protected int $age = 1; }`,
      graph,
    );
    const user = resolveType(graph, 'User');
    expect(user?.fields?.get('name')?.type).toBe('string');
    expect(user?.fields?.get('name')?.required).toBe(true);
    expect(user?.fields?.get('age')?.required).toBe(false);
  });

  // `self.sites_enabled = ...` in __init__ is how Python declares an instance
  // attribute. Reading only the class body meant such a name was known to
  // nothing, so patching it read as patching a method that does not exist.
  it('extracts Python attributes assigned on self', async () => {
    const graph = emptyGraph();
    await indexPythonFile(
      'src/mgr.py',
      'class Manager:\n    def __init__(self, sites_enabled):\n        self.sites_enabled = sites_enabled\n        self._cache: dict = {}\n\n    def run(self):\n        self.started = True\n        return 1\n',
      graph,
    );
    const mgr = resolveType(graph, 'Manager');
    expect(mgr?.fields?.has('sites_enabled')).toBe(true);
    expect(mgr?.fields?.has('_cache')).toBe(true);
    // Assigned outside __init__ is still an attribute of the instance.
    expect(mgr?.fields?.has('started')).toBe(true);
    // And the methods are still methods, not fields.
    expect(mgr?.methods.has('run')).toBe(true);
    expect(mgr?.fields?.has('run')).toBe(false);
  });

  it('does not take a local variable in a method for an attribute', async () => {
    const graph = emptyGraph();
    await indexPythonFile(
      'src/mgr.py',
      'class Manager:\n    def run(self):\n        total = 1\n        other.attr = 2\n        return total\n',
      graph,
    );
    const mgr = resolveType(graph, 'Manager');
    // Nothing was an attribute of the instance, so there is no field map at all.
    expect(mgr?.fields?.get('total')).toBeUndefined();
    expect(mgr?.fields?.get('attr')).toBeUndefined();
    expect(mgr?.methods.has('run')).toBe(true);
  });

  it('extracts Python annotated and initialized attributes', async () => {
    const graph = emptyGraph();
    await indexPythonFile(
      'src/user.py',
      `class User:\n    name: str\n    age = 1\n    def load(self):\n        pass\n`,
      graph,
    );
    const user = resolveType(graph, 'User');
    expect(user?.fields?.get('name')?.type).toBe('str');
    expect(user?.fields?.get('age')?.required).toBe(false);
  });

  it('extracts Rust struct fields', async () => {
    const graph = emptyGraph();
    await indexRustFile('src/user.rs', 'struct User { name: String, age: u32 }', graph);
    const user = resolveType(graph, 'User');
    expect(user?.fields?.get('name')?.type).toBe('String');
    expect(user?.fields?.get('age')?.required).toBe(true);
  });

  it('retains TypeScript class properties', async () => {
    const graph = emptyGraph();
    await indexTsFile('src/user.ts', 'class User { name: string; age = 1; }', graph);
    const user = resolveType(graph, 'User');
    expect(user?.fields?.get('name')?.type).toBe('string');
    expect(user?.fields?.get('age')?.required).toBe(false);
  });

  // An interface body was read by splitting its text on semicolons. TypeScript
  // does not require them, so an interface written with newline or comma
  // separators collapsed into a single member: the first field was registered
  // and every other one read as a field the type does not have.
  const fieldsOfInterface = async (source: string, name: string) => {
    const graph = emptyGraph();
    await indexTsFile('src/stats.ts', source, graph);
    return resolveType(graph, name)?.fields;
  };

  it('reads interface members separated by newlines alone', async () => {
    const fields = await fieldsOfInterface(
      'export interface LifetimeStats {\n    gamesPlayed: number\n    totalWords: number\n    bestScore: number\n    modes: string[]\n}\n',
      'LifetimeStats',
    );
    expect([...(fields?.keys() ?? [])]).toEqual([
      'gamesPlayed',
      'totalWords',
      'bestScore',
      'modes',
    ]);
    expect(fields?.get('modes')?.type).toBe('string[]');
  });

  it('reads interface members separated by commas', async () => {
    const fields = await fieldsOfInterface(
      'export interface Commas { a: number, b: Record<string, number> }\n',
      'Commas',
    );
    // The comma inside `Record<string, number>` must not end the member.
    expect([...(fields?.keys() ?? [])]).toEqual(['a', 'b']);
    expect(fields?.get('b')?.type).toBe('Record<string, number>');
  });

  it('keeps an inline object field and its optionality', async () => {
    const fields = await fieldsOfInterface(
      'export interface Paged {\n  data: string[];\n  pagination: { page: number; total: number };\n  meta?: { a: number };\n}\n',
      'Paged',
    );
    expect([...(fields?.keys() ?? [])]).toEqual(['data', 'pagination', 'meta']);
    expect(fields?.get('pagination')?.type).toBe('{ page: number; total: number }');
    expect(fields?.get('pagination')?.required).toBe(true);
    expect(fields?.get('meta')?.required).toBe(false);
  });

  it('reads an object-literal type alias the same way', async () => {
    const fields = await fieldsOfInterface(
      'export type Obj = {\n  x: number\n  y: string\n}\n',
      'Obj',
    );
    expect([...(fields?.keys() ?? [])]).toEqual(['x', 'y']);
  });
});
