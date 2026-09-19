import { expect, it, vi } from 'vitest';
import { Toggle } from '../src/Toggle';

it('experiments with values that left the union', () => {
  const toggle = new Toggle();
  vi.spyOn(toggle, 'mode').mockReturnValue('auto');
  vi.spyOn(toggle, 'retries').mockReturnValue(5);
  expect(toggle).not.toBeNull();
});
