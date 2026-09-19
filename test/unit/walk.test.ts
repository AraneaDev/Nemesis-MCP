import { describe, expect, it } from 'vitest';
import { unquote, walk, field, visibilityOf, typeTextOf } from '../../src/extractors/walk.js';
import { parseSource } from '../../src/parser/loader.js';

describe('unquote', () => {
  it('strips matching quotes of every kind', () => {
    expect(unquote(`'a'`)).toBe('a');
    expect(unquote(`"a"`)).toBe('a');
    expect(unquote('`a`')).toBe('a');
  });

  it('leaves unquoted and mismatched text alone', () => {
    expect(unquote('a')).toBe('a');
    expect(unquote(`'a"`)).toBe(`'a"`);
    expect(unquote('')).toBe('');
    expect(unquote(`'`)).toBe(`'`);
  });

  it('trims surrounding whitespace first', () => {
    expect(unquote(`  'a'  `)).toBe('a');
  });
});

describe('walk', () => {
  it('yields the root first, then descends', async () => {
    const { root } = await parseSource('typescript', 'class A { b() {} }');
    const seen = [...walk(root)];
    expect(seen[0]?.node.id).toBe(root.id);
    expect(seen[0]?.depth).toBe(0);
    expect(seen.some(({ node }) => node.type === 'method_definition')).toBe(true);
  });

  it('reports increasing depth', async () => {
    const { root } = await parseSource('typescript', 'class A { b() {} }');
    const method = [...walk(root)].find(({ node }) => node.type === 'method_definition');
    expect(method?.depth).toBeGreaterThan(0);
  });
});

describe('visibilityOf', () => {
  async function visibilityOfMethod(source: string) {
    const { root } = await parseSource('typescript', source);
    const method = [...walk(root)].find(({ node }) => node.type === 'method_definition');
    return method ? visibilityOf(method.node) : null;
  }

  it('reads an explicit modifier', async () => {
    expect(await visibilityOfMethod('class A { private b() {} }')).toBe('private');
    expect(await visibilityOfMethod('class A { protected b() {} }')).toBe('protected');
  });

  it('defaults to public', async () => {
    expect(await visibilityOfMethod('class A { b() {} }')).toBe('public');
    expect(await visibilityOfMethod('class A { public b() {} }')).toBe('public');
  });
});

describe('typeTextOf', () => {
  it('strips the leading annotation marker', async () => {
    const { root } = await parseSource('typescript', 'class A { b(): string { return ""; } }');
    const method = [...walk(root)].find(({ node }) => node.type === 'method_definition');
    expect(typeTextOf(method!.node, 'return_type')).toBe('string');
  });

  it('returns null when the field is absent', async () => {
    const { root } = await parseSource('typescript', 'class A { b() {} }');
    const method = [...walk(root)].find(({ node }) => node.type === 'method_definition');
    expect(typeTextOf(method!.node, 'return_type')).toBeNull();
  });
});

describe('field', () => {
  it('returns a named child or null', async () => {
    const { root } = await parseSource('typescript', 'class A {}');
    const cls = [...walk(root)].find(({ node }) => node.type === 'class_declaration')!.node;
    expect(field(cls, 'name')?.text).toBe('A');
    expect(field(cls, 'nonexistent')).toBeNull();
  });
});
