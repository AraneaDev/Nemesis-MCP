import { describe, expect, it } from 'vitest';
import { objectLiteralKeys } from '../../src/core/analyzer.js';
import { fieldsFromTypeText } from '../../src/extractors/ts/index.js';

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

// The other half of the same comparison: these are the fields a returned
// literal is checked against. A field missing from here is reported as one the
// type does not have, so dropping one silently invents a violation.
describe('the fields of a declared object type', () => {
  const namesOf = (text: string): string[] => [...(fieldsFromTypeText(text)?.keys() ?? [])];

  it('reads plain fields', () => {
    expect(namesOf('{ page: number; limit: number; }')).toEqual(['page', 'limit']);
  });

  it('reads a field whose type is an inline object', () => {
    // The body is split on semicolons at the top nesting level, which is
    // right, but the type was then matched with a pattern that could not span
    // a semicolon. A field carrying an inline object type was dropped, and a
    // stub supplying it was reported as supplying a field that does not exist.
    expect(namesOf('{ data: T[]; pagination: { page: number; total: number; }; }')).toEqual([
      'data',
      'pagination',
    ]);
  });

  it('reads a field whose type is an array of inline objects', () => {
    expect(
      namesOf(
        '{ eventCount: number; byType: Array<{ event_type: string; count: string }>; avgEventsPerDay: number; }',
      ),
    ).toEqual(['eventCount', 'byType', 'avgEventsPerDay']);
  });

  it('reads a field whose inline object type spans several lines', () => {
    expect(
      namesOf('{\n  totalEvents: number;\n  eventsByAge: {\n    last7Days: number;\n  };\n}'),
    ).toEqual(['totalEvents', 'eventsByAge']);
  });

  it('keeps the whole declared type, not the part before the first semicolon', () => {
    const fields = fieldsFromTypeText('{ pagination: { page: number; total: number; }; }');
    expect(fields?.get('pagination')?.type).toBe('{ page: number; total: number; }');
  });

  it('still marks an optional field optional', () => {
    const fields = fieldsFromTypeText('{ meta?: { a: number; b: number; }; id: string; }');
    expect(fields?.get('meta')?.required).toBe(false);
    expect(fields?.get('id')?.required).toBe(true);
  });

  it('ends a member at a newline or a comma, not only a semicolon', () => {
    expect(namesOf('{\n  gamesPlayed: number\n  totalWords: number\n}')).toEqual([
      'gamesPlayed',
      'totalWords',
    ]);
    expect(namesOf('{ a: number, b: string }')).toEqual(['a', 'b']);
  });

  it('does not end a member at a comma inside a type argument list', () => {
    const fields = fieldsFromTypeText('{ a: number, b: Record<string, number> }');
    expect([...(fields?.keys() ?? [])]).toEqual(['a', 'b']);
    expect(fields?.get('b')?.type).toBe('Record<string, number>');
  });

  it('does not treat the arrow of a function type as a closing bracket', () => {
    const fields = fieldsFromTypeText('{ cb: (a: string) => void, id: string }');
    expect([...(fields?.keys() ?? [])]).toEqual(['cb', 'id']);
    expect(fields?.get('cb')?.type).toBe('(a: string) => void');
  });

  it('gives up on anything that is not an object type', () => {
    expect(fieldsFromTypeText('string')).toBeNull();
    expect(fieldsFromTypeText('')).toBeNull();
  });
});
