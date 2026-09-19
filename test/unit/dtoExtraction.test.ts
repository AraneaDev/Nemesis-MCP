import { describe, expect, it } from 'vitest';
import { emptyGraph, resolveType } from '../../src/core/symbolGraph.js';
import { indexPhpFile } from '../../src/extractors/php/index.js';
import { indexPythonFile } from '../../src/extractors/python/index.js';
import { indexRustFile } from '../../src/extractors/rust/index.js';
import { indexTsFile } from '../../src/extractors/ts/index.js';

describe('cross-language DTO field extraction', () => {
  it('extracts PHP properties', async () => {
    const graph = emptyGraph();
    await indexPhpFile('src/User.php', `<?php class User { public string $name; protected int $age = 1; }`, graph);
    const user = resolveType(graph, 'User');
    expect(user?.fields?.get('name')?.type).toBe('string');
    expect(user?.fields?.get('name')?.required).toBe(true);
    expect(user?.fields?.get('age')?.required).toBe(false);
  });

  it('extracts Python annotated and initialized attributes', async () => {
    const graph = emptyGraph();
    await indexPythonFile('src/user.py', `class User:\n    name: str\n    age = 1\n    def load(self):\n        pass\n`, graph);
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
});
