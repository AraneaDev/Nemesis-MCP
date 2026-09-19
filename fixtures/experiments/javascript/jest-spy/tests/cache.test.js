import { expect, jest, test } from '@jest/globals';
import { Cache } from '../src/Cache.js';

test('experiments with a removed cache method', () => {
  const cache = new Cache();
  jest.spyOn(cache, 'read').mockReturnValue('value');
  expect(cache).toBeDefined();
});
