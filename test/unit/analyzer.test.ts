import { describe, expect, it } from 'vitest';
import { inferType, typesCompatible } from '../../src/core/analyzer.js';

describe('type compatibility', () => {
  it('accepts identical types', () => {
    expect(typesCompatible('UserProfile', 'UserProfile', 'typescript')).toBe(true);
  });

  it('unwraps Promise on the declared side (mockResolvedValue)', () => {
    expect(typesCompatible("{ id: '1' }", 'Promise<UserProfile>', 'typescript')).toBe(
      false,
    );
    expect(typesCompatible('UserProfile', 'Promise<UserProfile>', 'typescript')).toBe(
      true,
    );
  });

  it('string literal into string', () => {
    expect(typesCompatible("'x'", 'string', 'typescript')).toBe(true);
    expect(typesCompatible("'x'", 'int', 'php')).toBe(false);
  });

  it('numeric widening', () => {
    expect(typesCompatible('int', 'float', 'php')).toBe(true);
    expect(typesCompatible('42', 'int', 'typescript')).toBe(true);
  });

  it('null into nullable types', () => {
    expect(typesCompatible('null', '?int', 'php')).toBe(true);
    expect(typesCompatible('null', 'int', 'php')).toBe(false);
  });

  it('undefined into void', () => {
    expect(typesCompatible('undefined', 'void', 'typescript')).toBe(true);
  });

  it('mixed/any declared types accept anything', () => {
    expect(typesCompatible('whatever', 'mixed', 'php')).toBe(true);
    expect(typesCompatible('42', 'any', 'typescript')).toBe(true);
  });

  it('as any is treated as untyped and compatible', () => {
    expect(typesCompatible('any', 'UserProfile', 'typescript')).toBe(true);
  });
});

describe('inferType', () => {
  it('infers literals', () => {
    expect(inferType("'s'", 'php')).toBe('string');
    expect(inferType('42', 'php')).toBe('int');
    expect(inferType('42', 'typescript')).toBe('number');
    expect(inferType('true', 'php')).toBe('bool');
    expect(inferType('null', 'php')).toBe('null');
    expect(inferType('undefined', 'typescript')).toBe('undefined');
  });

  it('does not guess for identifiers', () => {
    expect(inferType('someVariable', 'typescript')).toBeNull();
  });

  it('infers new expressions', () => {
    expect(inferType('new App\\User()', 'php')).toBe('App\\User');
  });
});
