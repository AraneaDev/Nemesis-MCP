import { expect, jest, test } from '@jest/globals';
import { Mailer } from '../src/Mailer.js';

test('experiments with a stale mail response', () => {
  const mailer = new Mailer();
  jest.spyOn(mailer, 'send').mockResolvedValue('sent');
  expect(mailer).toBeDefined();
});
