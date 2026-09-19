import { expect, it, vi } from 'vitest';
import { Clock } from '../src/Clock';

it('experiments with a spy pointed at the wrong object', () => {
  // `format` moved to the prototype when it stopped being static, so the
  // class itself no longer carries it.
  vi.spyOn(Clock, 'format').mockReturnValue('noon');

  const clock = new Clock();
  // And `now` went the other way.
  vi.spyOn(clock, 'now').mockReturnValue(0);
  expect(clock).not.toBeNull();
});
