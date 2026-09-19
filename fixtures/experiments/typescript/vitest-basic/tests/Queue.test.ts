import { expect, it, vi } from 'vitest';
import { Queue } from '../src/Queue.js';

it('experiments with a renamed queue method', () => {
  const queue = new Queue();
  vi.spyOn(queue, 'push').mockReturnValue(true);
  expect(queue).toBeDefined();
});
