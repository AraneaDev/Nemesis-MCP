import { describe, expect, it } from 'vitest';
import { objectLiteralKeys } from '../../src/core/analyzer.js';

describe('object literal keys', () => {
  it('reads plain and quoted keys', () => {
    expect(objectLiteralKeys("{ id: 1, name: 'a' }")).toEqual(['id', 'name']);
    expect(objectLiteralKeys(`{ 'id': 1, "name": 2 }`)).toEqual(['id', 'name']);
  });

  it('reads shorthand keys', () => {
    expect(objectLiteralKeys('{ id, name }')).toEqual(['id', 'name']);
  });

  it('ignores commas and colons nested inside values', () => {
    expect(objectLiteralKeys('{ id: 1, meta: { a: 1, b: 2 }, tags: [1, 2] }')).toEqual([
      'id',
      'meta',
      'tags',
    ]);
  });

  it('reads an empty literal', () => {
    expect(objectLiteralKeys('{}')).toEqual([]);
  });

  it('gives up when the shape is open or computed', () => {
    // A spread or a computed key means the key set cannot be known, and a
    // missing field proves nothing.
    expect(objectLiteralKeys('{ ...base, id: 1 }')).toBeNull();
    expect(objectLiteralKeys('{ [key]: 1 }')).toBeNull();
  });

  it('gives up on anything that is not an object literal', () => {
    expect(objectLiteralKeys("'x'")).toBeNull();
    expect(objectLiteralKeys('[1, 2]')).toBeNull();
    expect(objectLiteralKeys('')).toBeNull();
  });
});
