import { expect, jest, test } from '@jest/globals';
import { Parser } from '../src/Parser.js';

test('experiments with a stale parser call shape', () => {
  const parser = new Parser();
  const spy = jest.spyOn(parser, 'parse');
  spy.toHaveBeenCalledWith('input', { strict: true });
  expect(spy).toBeDefined();
});
